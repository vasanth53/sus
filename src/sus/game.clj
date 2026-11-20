(ns sus.game
  "Pure room state transitions. Every fn takes a room map and returns a new one;
  the server owns the atom, sockets and clock."
  (:require [clojure.string :as str]))

(def default-words ["Apple" "Bicycle" "Telescope" "Guitar" "Sunshine" "Ocean"])

(defn sanitize-text [v]
  (if (string? v)
    (-> v (str/replace #"[\x00-\x1F\x7F]" "") str/trim (str/replace #"\s+" " "))
    ""))

(defn- subs* [s n] (if (> (count s) n) (subs s 0 n) s))

(defn token [n-bytes]
  (let [b (byte-array n-bytes)]
    (.nextBytes (java.security.SecureRandom.) b)
    (apply str (map #(format "%02x" (bit-and % 0xff)) b))))

(defn new-room [code {:keys [turn-seconds voting-seconds]}]
  {:code code
   :phase "lobby"
   :host-id nil
   :players {}           ; pid -> {:id :name :n :uid :connected :alive :voted :token :role :word}
   :next-n 0
   :turn-order []        ; names, like the original
   :current-player ""
   :clues []
   :votes []             ; target ids in cast order
   :turn-deadline 0
   :voting-deadline 0
   :reset-at 0
   :turn-seconds (or turn-seconds 30)
   :voting-seconds (or voting-seconds 25)
   :game-over nil})

(defn players-in-order [room] (sort-by :n (vals (:players room))))

(defn- connected-ids [room] (->> (players-in-order room) (filter :connected) (map :id)))

(defn- connected-alive-ids [room] (->> (players-in-order room) (filter #(and (:connected %) (:alive %))) (map :id)))

(defn- reassign-host-if-gone [room]
  (if (and (= "lobby" (:phase room))
           (not (get-in room [:players (:host-id room) :connected])))
    (assoc room :host-id (first (connected-ids room)))
    room))

;; --- join / leave ---

(defn join
  "Returns {:room :player-id} or {:error code}. A known name may rejoin only with its token."
  [room {:keys [name token uid max-players]}]
  (let [name (subs* (sanitize-text name) 18)
        token (sanitize-text token)
        existing (first (filter #(= (str/lower-case (:name %)) (str/lower-case name)) (vals (:players room))))]
    (cond
      (str/blank? name) {:error "invalid_name"}

      existing
      (if (and (seq token) (= token (:token existing)))
        {:room (-> room
                   (update-in [:players (:id existing)] assoc :connected true :uid uid)
                   reassign-host-if-gone)
         :player-id (:id existing)}
        {:error "name_taken"})

      ;; counts away-but-reclaimable seats too, so rename loops can't grow the room
      (>= (count (:players room)) (or max-players 10)) {:error "room_full"}

      :else
      (let [pid (sus.game/token 8)]
        {:room (-> room
                   (assoc-in [:players pid] {:id pid :name name :n (:next-n room) :uid uid
                                             :connected true :voted false
                                             :alive (= "lobby" (:phase room)) ; late joiners watch until next round
                                             :token (sus.game/token 24) :role nil :word nil})
                   (update :next-n inc)
                   (update :host-id #(or % pid))
                   reassign-host-if-gone)
         :player-id pid}))))

(defn disconnect
  "Only the socket currently holding the seat can release it; a reclaimed seat ignores its old tab closing."
  [room pid uid]
  (cond
    (not= uid (get-in room [:players pid :uid])) room
    ;; in the lobby there is nothing to come back to, so free the seat and name
    (= "lobby" (:phase room)) (-> room (update :players dissoc pid) reassign-host-if-gone)
    :else (update-in room [:players pid] assoc :connected false :uid nil)))

;; --- round ---

(defn start-round
  "Pure role/word assignment. rng is a fn returning [0,1)."
  ([ids] (start-round ids {}))
  ([ids {:keys [words rng] :or {rng rand}}]
   (if (< (count ids) 2)
     {:ok false :error "need_two_players"}
     (let [pool (if (>= (count words) 2) words default-words)
           pick #(nth % (int (* (rng) (count %))))
           secret (pick pool)
           decoy (loop [d (pick pool) guard 0]
                   (if (and (= d secret) (< guard 10)) (recur (pick pool) (inc guard)) d))
           order (vec (shuffle ids))
           imposter (pick order)]
       {:ok true
        :secret-word secret
        :decoy-word decoy
        :imposter-id imposter
        :roles (into {} (for [id ids] [id (if (= id imposter) "imposter" "crewmate")]))
        :words (into {} (for [id ids] [id (if (= id imposter) decoy secret)]))
        :turn-order-ids order}))))

(defn tally-votes
  "Most votes wins; ties go to whoever received a vote first."
  [targets]
  (let [counts (frequencies targets)]
    {:ejected-id (reduce (fn [best t] (if (or (nil? best) (> (counts t) (counts best))) t best))
                         nil (distinct targets))
     :counts counts}))

(defn start-game [room pid now opts]
  (let [ids (connected-ids room)
        {:keys [ok roles words turn-order-ids]} (start-round ids opts)]
    (if-not (and ok
                 (= "lobby" (:phase room))
                 (= pid (:host-id room)))
      room
      (-> room
          (update :players #(update-vals % (fn [p] (assoc p :alive true :voted false
                                                          :role (roles (:id p)) :word (words (:id p))))))
          (assoc :phase "clue-giving"
                 :game-over nil
                 :votes []
                 :clues []
                 :turn-order (mapv #(get-in room [:players % :name]) turn-order-ids)
                 :current-player (get-in room [:players (first turn-order-ids) :name])
                 :turn-deadline (+ now (* 1000 (:turn-seconds room))))))))

(defn- advance-turn [room now]
  (if (< (count (connected-alive-ids room)) 2)
    room ; tick sends the abandoned round back to the lobby
    (let [order (:turn-order room)
          next-name (get order (inc (.indexOf ^java.util.List order (:current-player room))))]
      (if next-name
        (assoc room :current-player next-name :turn-deadline (+ now (* 1000 (:turn-seconds room))))
        (assoc room :phase "voting" :current-player "" :turn-deadline 0
               :voting-deadline (+ now (* 1000 (:voting-seconds room))))))))

(defn- add-clue [room sender clue]
  (update room :clues conj {:sender sender :clue (subs* (sanitize-text clue) 32)}))

(defn submit-clue [room pid clue now]
  (let [me (get-in room [:players pid])
        clue (subs* (sanitize-text (if (map? clue) (:clue clue) clue)) 32)]
    (if (and (= "clue-giving" (:phase room)) (:connected me) (:alive me)
             (= (:name me) (:current-player room)) (seq clue))
      (-> room (add-clue (:name me) clue) (advance-turn now))
      room)))

(defn- finalize-voting [room now]
  (let [{:keys [ejected-id]} (tally-votes (:votes room))
        room (cond-> room (get-in room [:players ejected-id]) (assoc-in [:players ejected-id :alive] false))
        ps (players-in-order room)
        imposter (first (filter #(= "imposter" (:role %)) ps))]
    (assoc room
           :phase "game-over"
           :turn-deadline 0
           :voting-deadline 0
           :reset-at (+ now 4500)
           :game-over {:winner (if (and imposter (= ejected-id (:id imposter))) "Crewmates" "Imposter")
                       :ejected (get-in room [:players ejected-id :name] "")
                       :imposter (:name imposter "")
                       :secret-word (or (:word (first (filter #(= "crewmate" (:role %)) ps))) "")})))

(defn cast-vote [room pid target now]
  (let [me (get-in room [:players pid])
        target (get-in room [:players (sanitize-text target)])]
    (if-not (and (= "voting" (:phase room)) (:connected me) (:alive me) (:role me) (not (:voted me))
                 (:alive target) (:role target))
      room
      (let [room (-> room
                     (assoc-in [:players pid :voted] true)
                     (update :votes conj (:id target)))
            alive (connected-alive-ids room)]
        (if (every? #(get-in room [:players % :voted]) alive)
          (finalize-voting room now)
          room)))))

(defn- everyone-voted? [room]
  (every? #(get-in room [:players % :voted]) (connected-alive-ids room)))

(defn- reset-to-lobby [room]
  (-> room
      (update :players #(into {} (for [[id p] % :when (:connected p)]
                                   [id (assoc p :alive true :voted false :role nil :word nil)])))
      (assoc :phase "lobby" :turn-order [] :current-player "" :clues [] :votes []
             :turn-deadline 0 :voting-deadline 0 :reset-at 0 :game-over nil)
      reassign-host-if-gone))

(defn tick
  "Applies whichever deadline has passed. Safe to call as often as you like."
  [room now]
  (let [past? #(and (pos? %) (>= now %))]
    (case (if (and (#{"clue-giving" "voting"} (:phase room)) (< (count (connected-alive-ids room)) 2))
            "abandoned"
            (:phase room))
      "abandoned" (reset-to-lobby room)
      "clue-giving" (if (past? (:turn-deadline room))
                      (-> room (add-clue (:current-player room) "(timeout)") (advance-turn now))
                      room)
      "voting" (if (or (past? (:voting-deadline room)) (everyone-voted? room)) (finalize-voting room now) room)
      "game-over" (if (past? (:reset-at room)) (reset-to-lobby room) room)
      room)))

;; --- what each client sees ---

(defn player-view
  "Public room state plus this player's own id, token and word."
  [room pid]
  (let [me (get-in room [:players pid])]
    {:room-code (:code room)
     :phase (:phase room)
     :players (mapv (fn [p] {:id (:id p) :name (:name p) :connected (:connected p)
                             :host? (= (:id p) (:host-id room)) :alive (:alive p) :voted (:voted p)})
                    (players-in-order room))
     :turn-order (:turn-order room)
     :current-player (:current-player room)
     :clues (:clues room)
     :turn-deadline (:turn-deadline room)
     :voting-deadline (:voting-deadline room)
     :turn-seconds (:turn-seconds room)
     :voting-seconds (:voting-seconds room)
     :game-over (:game-over room)
     :me {:id pid :token (:token me) :word (when (not= "lobby" (:phase room)) (:word me))}}))
