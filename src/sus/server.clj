(ns sus.server
  (:require [clojure.string :as str]
            [org.httpkit.server :as http]
            [ring.middleware.keyword-params :refer [wrap-keyword-params]]
            [ring.middleware.params :refer [wrap-params]]
            [ring.util.response :as resp]
            [sus.game :as game]
            [sus.util :as util]
            [taoensso.sente :as sente]
            [taoensso.sente.server-adapters.http-kit :refer [get-sch-adapter]]))

(defn env [k default] (or (System/getenv k) default))

(def config
  {:port (parse-long (env "PORT" "3001"))
   :host (env "HOST" "0.0.0.0")
   :max-players (parse-long (env "MAX_PLAYERS" "10"))
   :turn-seconds (parse-long (env "TURN_SECONDS" "30"))
   :voting-seconds (parse-long (env "VOTING_SECONDS" "25"))
   :allowed-origins (util/parse-cors-origin (System/getenv "CLIENT_ORIGIN"))})

;; {:rooms {code room} :seats {uid [code pid]}}
(defonce state (atom {:rooms {} :seats {}}))

(defn- now [] (System/currentTimeMillis))

;; --- socket ---

(defonce chsk
  (sente/make-channel-socket-server!
   (get-sch-adapter)
   {:user-id-fn :client-id               ; one seat per browser tab
    :csrf-token-fn nil                   ; no cookies/sessions to protect; origin allowlist below
    :authorized?-fn #(util/origin-allowed? (:allowed-origins config) (get-in % [:headers "origin"]))}))

(defn- broadcast! [room]
  (doseq [p (vals (:players room)) :when (:uid p)]
    ((:send-fn chsk) (:uid p) [:sus/state (game/player-view room (:id p))])))

(defn- update-room!
  "Applies (f room) to one room and pushes the result to its players if anything changed.
  Rooms with nobody connected are dropped, like Colyseus auto-dispose."
  [code f]
  (let [[old new] (swap-vals! state
                              (fn [s]
                                (if-let [room (get-in s [:rooms code])]
                                  (let [room' (f room)]
                                    (if (some :connected (vals (:players room')))
                                      (assoc-in s [:rooms code] room')
                                      (update s :rooms dissoc code)))
                                  s)))
        room (get-in new [:rooms code])]
    (when (and room (not= room (get-in old [:rooms code])))
      (broadcast! room))))

(defn- seat [uid] (get-in @state [:seats uid]))

(defn- leave! [uid]
  (when-let [[code pid] (get-in @state [:seats uid])]
    (swap! state update :seats dissoc uid)
    (update-room! code #(game/disconnect % pid uid))))

(defn- join! [uid {:keys [name token room-code create?]}]
  (let [code (str/upper-case (game/sanitize-text room-code))
        opts {:turn-seconds (:turn-seconds config) :voting-seconds (:voting-seconds config)}
        result (atom nil)]
    (cond
      (not (re-matches #"[A-Z0-9]{4,8}" code)) {:error "invalid_room"}

      ;; reconnecting into the seat we already hold: keep it (and host) as is
      (let [[seat-code pid] (seat uid)
            p (get-in @state [:rooms code :players pid])]
        (and (= seat-code code) (= uid (:uid p))
             (= (str/lower-case (:name p)) (str/lower-case (game/sanitize-text name)))))
      (do (broadcast! (get-in @state [:rooms code])) {:ok true :room-code code})

      :else
      (do
        (leave! uid)
        (swap! state
               (fn [s]
                 (let [room (or (get-in s [:rooms code]) (when create? (game/new-room code opts)))
                       r (if room
                           (game/join room {:name name :token token :uid uid :max-players (:max-players config)})
                           {:error "room_not_found"})]
                   (reset! result r)
                   (if (:room r)
                     (-> s (assoc-in [:rooms code] (:room r)) (assoc-in [:seats uid] [code (:player-id r)]))
                     s))))
        (if-let [room (:room @result)]
          (do (broadcast! room) {:ok true :room-code code})
          (select-keys @result [:error]))))))

(defn handle-event! [{:keys [id uid ?data ?reply-fn]}]
  (let [[code pid] (seat uid)
        ;; ignore a stale tab whose seat was reclaimed elsewhere with the token
        in-room! (fn [f] (when code
                           (update-room! code #(if (= uid (get-in % [:players pid :uid])) (f %) %))))]
    (case id
      :sus/join (when ?reply-fn (?reply-fn (join! uid ?data)))
      :sus/start (in-room! #(game/start-game % pid (now) {}))
      :sus/clue (in-room! #(game/submit-clue % pid (:clue ?data) (now)))
      :sus/vote (in-room! #(game/cast-vote % pid (:player-id ?data) (now)))
      :chsk/uidport-close (leave! uid)
      nil)))

(defn tick-all! []
  (doseq [code (keys (:rooms @state))]
    (update-room! code #(game/tick % (now)))))

;; --- http ---

(defn- routes [{:keys [request-method uri] :as req}]
  (case [request-method uri]
    ;; websocket only: Sente's ajax transport lets a client hold seats without ever opening a socket
    [:get "/chsk"] (if (:websocket? req)
                     ((:ajax-get-or-ws-handshake-fn chsk) req)
                     (resp/bad-request "websocket required"))
    [:get "/health"] (resp/content-type (resp/response "{\"ok\":true}") "application/json")
    [:get "/"] (-> (resp/resource-response "public/index.html") (resp/content-type "text/html"))
    (or (some-> (resp/resource-response uri {:root "public"}) (resp/content-type
                                                                 (cond (str/ends-with? uri ".js") "text/javascript"
                                                                       (str/ends-with? uri ".css") "text/css"
                                                                       (str/ends-with? uri ".svg") "image/svg+xml"
                                                                       (str/ends-with? uri ".png") "image/png"
                                                                       :else "application/octet-stream")))
        (resp/not-found "not found"))))

(def app (-> routes wrap-keyword-params wrap-params))

(defn start! []
  (sente/start-server-chsk-router! (:ch-recv chsk) handle-event!)
  ;; shortcut: polls every room 4x/s for expired deadlines; fine for hobby scale, switch to per-room scheduled tasks if rooms number in the thousands
  (future (while true (Thread/sleep 250) (try (tick-all!) (catch Throwable e (.printStackTrace e)))))
  (let [stop (http/run-server #'app (assoc (select-keys config [:port :host]) :max-ws 65536))]
    (println (str "sus listening on http://" (:host config) ":" (:port config)))
    stop))

(defn -main [& _] (start!) @(promise))
