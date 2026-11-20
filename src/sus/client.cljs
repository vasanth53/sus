(ns sus.client
  (:require [clojure.string :as str]
            [reagent.core :as r]
            [reagent.dom.client :as rdc]
            [taoensso.sente :as sente]))

(defn- ls-get [k] (try (or (.getItem js/localStorage k) "") (catch :default _ "")))
(defn- ls-set! [k v] (try (.setItem js/localStorage k v) (catch :default _ nil)))

(defn- initial-theme []
  (let [saved (str/lower-case (str/trim (ls-get "imposter.theme")))]
    (cond (#{"dark" "light"} saved) saved
          (some-> js/window (.matchMedia "(prefers-color-scheme: dark)") .-matches) "dark"
          :else "light")))

(defonce app (r/atom {:name (ls-get "imposter.name")
                      :token (ls-get "imposter.token")
                      :room-code ""
                      :joined? false
                      :pending? false
                      :connected? false
                      :view nil
                      :clue ""
                      :toast nil
                      :theme (initial-theme)
                      :clock (js/Date.now)}))

(defonce chsk (sente/make-channel-socket-client! "/chsk" nil {:type :ws}))

(defn- toast! [type message] (swap! app assoc :toast {:type type :message message}))

(defn- send! [ev] ((:send-fn chsk) ev))

(defn- new-room-code []
  (apply str (repeatedly 6 #(rand-nth "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"))))

(defn- copy-code! [code]
  (when-not (str/blank? code)
    (-> (.writeText js/navigator.clipboard code)
        (.then #(toast! "success" "Room code copied.")
               #(toast! "info" (str "Room code: " code))))))

(defn- join! [code {:keys [prefix create? quiet?]}]
  (let [{:keys [name token pending?]} @app
        name (str/trim name)
        code (str/upper-case (str/trim code))
        ;; only offer the token back for the name it was issued to
        token (if (= (str/lower-case name) (str/lower-case (str/trim (ls-get "imposter.name")))) token "")]
    (when (and (seq name) (seq code) (not pending?))
      (swap! app assoc :pending? true)
      ((:send-fn chsk) [:sus/join {:name name :token token :room-code code :create? create?}] 5000
       (fn [reply]
         (swap! app assoc :pending? false)
         (cond
           (:ok reply) (do (ls-set! "imposter.name" name)
                           (swap! app assoc :joined? true :room-code code)
                           (when-not quiet? (toast! "success" (str prefix " " code))))
           (sente/cb-success? reply) (toast! "warning" (str "Join failed: " (:error reply)))
           :else (toast! "warning" "Join failed: timeout")))))))

(defn- on-state! [view]
  (let [token (get-in view [:me :token])]
    (when (seq token) (ls-set! "imposter.token" token))
    (swap! app (fn [s] (cond-> (assoc s :view view :token (or token (:token s)))
                         (= "lobby" (:phase view)) (assoc :clue ""))))))

(defn- handle! [{:keys [id ?data]}]
  (case id
    :chsk/state (let [[_ new] ?data]
                  (swap! app assoc :connected? (:open? new))
                  ;; after a dropped socket the server has released our seat; take it back with our token
                  (when (and (:open? new) (not (:first-open? new)) (:joined? @app))
                    (join! (:room-code @app) {:create? true :quiet? true})))
    :sus/state (on-state! ?data)
    nil))

;; --- views ---

(defn- me [{:keys [view]}] (some #(when (= (:id %) (get-in view [:me :id])) %) (:players view)))

(defn- seconds-left [deadline clock] (when (pos? deadline) (max 0 (js/Math.ceil (/ (- deadline clock) 1000)))))

(defn- timer-bar [label deadline total clock]
  (when-let [secs (seconds-left deadline clock)]
    (let [fill (-> (/ (- deadline clock) (* 1000 (max 1 total))) (max 0) (min 1))]
      [:div.Timer
       [:div.TimerRow [:span.TimerLabel label] [:span.TimerValue (str (min 99 secs) "s")]]
       [:div.TimerTrack {:aria-hidden true} [:div.TimerFill {:style {"--fill" fill}}]]])))

(defn- banner [phase]
  (when-let [img ({"clue-giving" "shhhhh" "voting" "discuss"} phase)]
    [:img.PhaseBanner {:src (str "/among-us/" img ".png") :alt "" :aria-hidden true}]))

(defn- clue-list [clues]
  [:div.ClueList
   (if (empty? clues)
     [:div.Empty "No clues yet."]
     (for [[i c] (map-indexed vector clues)]
       ^{:key i} [:div.ClueRow [:span.ClueSender (:sender c)] [:span.ClueText (:clue c)]]))])

(defn- join-card [{:keys [name room-code pending? connected?]}]
  (let [ready? (and (seq (str/trim name)) connected? (not pending?))]
    [:div.Card
     [:h2.CardTitle "Join"]
     [:p.CardHint "Type your name, then join with a room code."]
     [:form.FormRow {:on-submit (fn [e] (.preventDefault e)
                                  (if (str/blank? room-code)
                                    (toast! "warning" "Enter a room code.")
                                    (join! room-code {:prefix "Joined room"})))}
      [:input.Input {:type "text" :value name :placeholder "Name" :max-length 18 :auto-complete "nickname"
                     :on-change #(swap! app assoc :name (.. % -target -value))}]
      [:button.Button.Primary {:type "submit" :disabled (not (and ready? (seq (str/trim room-code))))}
       (if pending? "Working…" "Join")]]
     [:div.FormRow {:style {:margin-top 10}}
      [:input.Input {:type "text" :value room-code :placeholder "Room code" :auto-complete "off"
                     :on-change #(swap! app assoc :room-code (str/upper-case (.. % -target -value)))}]
      [:button.Button {:type "button" :disabled (str/blank? room-code) :on-click #(copy-code! room-code)} "Copy"]]
     [:div.Actions {:style {:margin-top 10}}
      [:button.Button {:type "button" :disabled (not ready?) :title "Create a new room and copy the code"
                       :on-click #(let [code (new-room-code)]
                                    (swap! app assoc :room-code code)
                                    (join! code {:prefix "Created room" :create? true})
                                    (copy-code! code))}
       "Create room"]]
     [:div.MetaRow
      [:span {:class ["Pill" (if connected? "PillOk" "PillWarn")]} (if connected? "Connected" "Offline")]
      [:span.MetaText "Server: " (.. js/window -location -origin)]]]))

(defn- lobby [{:keys [view] :as s}]
  (let [host? (:host? (me s))]
    [:div.Grid
     [:div.Card
      [:h2.CardTitle "Lobby"]
      [:p.CardHint "Welcome, " [:span.Strong (:name s)] ". " (if host? "You are the host." "Waiting for host to start.")]
      [:div.PlayerList
       (for [p (:players view)]
         ^{:key (:id p)}
         [:div.PlayerRow
          [:div.Avatar {:aria-hidden true} (str/upper-case (subs (str (:name p) "?") 0 1))]
          [:div.PlayerName (:name p) (when (= (:id p) (get-in view [:me :id])) " (you)")]
          (when (:host? p) [:span.Pill.PillNeutral "HOST"])])]
      [:div.Actions
       [:button.Button.Primary {:on-click #(send! [:sus/start])
                                :disabled (or (< (count (:players view)) 2) (not host?))}
        "Start round"]]]]))

(defn- clue-phase [{:keys [view clue clock] :as s}]
  (let [my-turn? (= (:name (me s)) (:current-player view))]
    [:div.Grid
     [:div.Card
      [:div.Row.Between
       [:h2.CardTitle (if my-turn? "Your turn" "Clue phase")]
       [:span {:class ["Pill" (if my-turn? "PillOk" "PillNeutral")]} (if my-turn? "INPUT" "WAIT")]]
      [banner (:phase view)]
      [:div.WordBox [:div.WordLabel "Your word"] [:div.WordValue (get-in view [:me :word])]]
      [timer-bar "Turn timer" (:turn-deadline view) (:turn-seconds view) clock]
      [:p.CardHint (if my-turn? "Give a clue that fits the word (but don’t be obvious)."
                       (str "Waiting for " (:current-player view) "…"))]
      [:form.FormRow {:on-submit (fn [e] (.preventDefault e)
                                   (when-not (str/blank? clue)
                                     (send! [:sus/clue {:clue clue}])
                                     (swap! app assoc :clue "")))}
       [:input.Input {:type "text" :value clue :max-length 32 :disabled (not my-turn?)
                      :placeholder (if my-turn? "Type your clue…" "Not your turn")
                      :on-change #(swap! app assoc :clue (.. % -target -value))}]
       [:button.Button.Primary {:type "submit" :disabled (or (not my-turn?) (str/blank? clue))} "Send"]]]
     [:div.Card.Subtle
      [:h3.CardTitle.Small "Turn order"]
      [:ol.List.Ordered
       (for [[i p] (map-indexed vector (:turn-order view))]
         ^{:key i} [:li {:class (when (= p (:current-player view)) "Active")}
                    p (when (= p (:name (me s))) " (you)")])]]
     [:div.Card.Subtle [:h3.CardTitle.Small "Clues"] [clue-list (:clues view)]]]))

(defn- voting [{:keys [view clock] :as s}]
  (let [{:keys [id voted]} (me s)]
    [:div.Grid
     [:div.Card
      [:div.Row.Between [:h2.CardTitle "Voting"] [:span.Pill.PillWarn "Choose"]]
      [banner (:phase view)]
      [timer-bar "Voting timer" (:voting-deadline view) (:voting-seconds view) clock]
      [:p.CardHint "Review the clues and vote for the imposter."]
      [clue-list (:clues view)]]
     [:div.Card.Subtle
      [:h3.CardTitle.Small "Players"]
      [:div.VoteGrid
       (for [p (filter :alive (:players view))]
         ^{:key (:id p)}
         [:button.Button {:disabled (or voted (= (:id p) id))
                          :title (if (= (:id p) id) "You can’t vote for yourself" (str "Vote " (:name p)))
                          :on-click #(do (send! [:sus/vote {:player-id (:id p)}]) (toast! "success" "Vote submitted."))}
          (str "Vote " (:name p))])]
      (when voted [:div.Notice "Vote locked in. Waiting for others…"])]]))

(defn- game-over [{:keys [view]}]
  (let [{:keys [winner ejected imposter secret-word]} (:game-over view)
        row (fn [label v] [:div.ResultRow [:div.ResultLabel label] [:div.ResultValue v]])]
    [:div.Card
     [:h2.CardTitle "Game over"]
     (row "Winner" winner)
     (when (seq ejected) (row "Ejected" ejected))
     (when (seq imposter) (row "Imposter" imposter))
     (row "Secret word" secret-word)
     [:p.CardHint "Returning to lobby shortly…"]]))

(defn- root []
  (let [{:keys [view joined? connected? toast theme name] :as s} @app
        phase (if joined? (:phase view "lobby") "lobby")
        my-turn? (and (= "clue-giving" phase) (= (:name (me s)) (:current-player view)))
        host? (and joined? (:host? (me s)))]
    [:div.App {:style {"--au-stars" "url(/among-us/stars.png)"
                       "--au-parallax1" "url(/among-us/parallax1.png)"
                       "--au-parallax2" "url(/among-us/parallax2.png)"
                       "--au-parallax3" "url(/among-us/parallax3.png)"}}
     [:div.SpaceView {:aria-hidden true}]
     [:div.CabinVignette {:aria-hidden true}]
     [:div.TopBar
      [:div.Brand
       [:div.LogoDot {:aria-hidden true}]
       [:div [:div.BrandTitle "Imposter Word Game"] [:div.BrandSubtitle "quick rounds • tiny chaos"]]]
      [:div.TopBarRight
       [:button.Button.ThemeToggle {:type "button" :aria-pressed (= theme "dark")
                                    :title (if (= theme "dark") "Switch to light mode" "Switch to dark mode")
                                    :on-click #(swap! app update :theme {"dark" "light" "light" "dark"})}
        (if (= theme "dark") "Light" "Dark")]
       (when joined? [:span.Pill.PillNeutral "You: " name])
       (when (#{"clue-giving" "voting"} phase)
         [:span {:class ["Pill" (if my-turn? "PillOk" "PillNeutral")]} (if my-turn? "Your turn" "Waiting")])]]
     (when toast [:div {:class ["Toast" (:type toast)]} (:message toast)])
     [:main.Main
      [:div.MonitorFrame
       [:div.MonitorBezel {:aria-hidden true}]
       [:div.MonitorScreen
        (cond (not joined?) [join-card s]
              (nil? view) [:p "Loading..."]
              :else (case phase
                      "lobby" [lobby s]
                      "clue-giving" [clue-phase s]
                      "voting" [voting s]
                      "game-over" [game-over s]
                      [:p "Loading..."]))]
       [:div.ConsoleStrip {:aria-hidden true}
        [:div.ConsoleLights
         [:span {:class ["Light" (if connected? "Ok" "Warn")]}]
         [:span {:class ["Light" (if (= phase "clue-giving") "Ok" "Neutral")]}]
         [:span {:class ["Light" (if (= phase "voting") "Warn" "Neutral")]}]
         [:span {:class ["Light" (if (= phase "game-over") "Danger" "Neutral")]}]]
        [:div.ConsoleText (str/join " • " [(if joined? (:room-code s) "public") (str/upper-case phase)
                                           (if host? "HOST" "PLAYER") name])]
        [:div.ConsoleButtons [:span.ConsoleBtn] [:span.ConsoleBtn] [:span.ConsoleBtn]]]]]]))

(defonce react-root (delay (rdc/create-root (js/document.getElementById "root"))))

(defn ^:dev/after-load render! [] (rdc/render @react-root [root]))

(defn init []
  (add-watch app :theme (fn [_ _ o n]
                          (when (not= (:theme o) (:theme n))
                            (set! (.. js/document -documentElement -dataset -theme) (:theme n))
                            (ls-set! "imposter.theme" (:theme n)))))
  (set! (.. js/document -documentElement -dataset -theme) (:theme @app))
  (js/setInterval #(let [v (:view @app)]
                     (when (or (pos? (:turn-deadline v 0)) (pos? (:voting-deadline v 0)))
                       (swap! app assoc :clock (js/Date.now))))
                  80)
  (sente/start-client-chsk-router! (:ch-recv chsk) handle!)
  (render!))
