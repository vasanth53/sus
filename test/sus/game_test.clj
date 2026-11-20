(ns sus.game-test
  (:require [clojure.test :refer [deftest is testing]]
            [sus.game :as g]))

(deftest start-round-test
  (testing "needs at least 2 players"
    (is (false? (:ok (g/start-round []))))
    (is (false? (:ok (g/start-round ["p1"])))))
  (testing "one imposter with a decoy word"
    (let [res (g/start-round ["p1" "p2" "p3"])]
      (is (:ok res))
      (is (= {"imposter" 1 "crewmate" 2} (frequencies (vals (:roles res)))))
      (is (= [2 1] (sort > (vals (frequencies (vals (:words res))))))))))

(deftest tally-votes-test
  (is (= "b" (:ejected-id (g/tally-votes ["a" "b" "c" "b" "c" "b"]))))
  (is (= "a" (:ejected-id (g/tally-votes ["a" "b"]))) "tie goes to first voted")
  (is (nil? (:ejected-id (g/tally-votes [])))))

(defn- join [room name & [token]]
  (let [{:keys [room player-id error]} (g/join room {:name name :token token :uid name :max-players 3})]
    (assert (not error) error)
    [room player-id]))

(deftest join-test
  (let [[room a] (join (g/new-room "R" {}) "Alice")
        [room b] (join room "Bob")]
    (is (= a (:host-id room)))
    (is (= "name_taken" (:error (g/join room {:name "alice"}))))
    (is (= "invalid_name" (:error (g/join room {:name "  \u0001 "}))))
    (is (= room (g/disconnect room a "stale-tab")) "old socket can't kick the seat holder")
    (testing "leaving the lobby frees the seat and passes host"
      (let [room (g/disconnect room a "Alice")]
        (is (nil? (get-in room [:players a])))
        (is (= b (:host-id room)))))
    (testing "mid-round the seat is kept and reclaimable only with the token"
      (let [room (-> room (g/start-game a 0 {}) (g/disconnect b "Bob"))
            token (get-in room [:players b :token])]
        (is (= "name_taken" (:error (g/join room {:name "Bob" :token "guess"}))))
        (is (= b (:player-id (g/join room {:name "Bob" :token token}))))))
    (let [[room _] (join room "Cat")]
      (is (= "room_full" (:error (g/join room {:name "Dan" :max-players 3})))))))

(defn- play-clues [room now]
  (reduce (fn [room name]
            (let [pid (some #(when (= name (:name %)) (:id %)) (vals (:players room)))]
              (g/submit-clue room pid (str "clue from " name) now)))
          room (:turn-order room)))

(deftest full-round-test
  (let [[room a] (join (g/new-room "R" {}) "Alice")
        [room b] (join room "Bob")
        [room c] (join room "Cat")
        room (g/start-game room b 0 {})
        _ (is (= "lobby" (:phase room)) "only host may start")
        room (g/start-game room a 0 {})
        imposter (some #(when (= "imposter" (:role %)) (:id %)) (vals (:players room)))]
    (is (= "clue-giving" (:phase room)))
    (is (= 30000 (:turn-deadline room)))
    (is (nil? (get-in (g/player-view room a) [:players 0 :role])) "roles never leak into the public view")
    (is (string? (get-in (g/player-view room a) [:me :word])))
    (let [room (play-clues room 1)]
      (is (= "voting" (:phase room)))
      (is (= 3 (count (:clues room))))
      (let [room (reduce #(g/cast-vote %1 %2 imposter 2) room (remove #{imposter} [a b c]))
            room (if (= "voting" (:phase room))
                   (g/cast-vote room imposter (first (remove #{imposter} [a b c])) 2)
                   room)]
        (is (= "game-over" (:phase room)))
        (is (= "Crewmates" (get-in room [:game-over :winner])))
        (is (= (get-in room [:players imposter :name]) (get-in room [:game-over :imposter])))
        (is (= "game-over" (:phase (g/tick room 4000))))
        (let [room (g/tick room 4502)]
          (is (= "lobby" (:phase room)))
          (is (every? #(nil? (:word %)) (vals (:players room)))))))))

(deftest timeouts-test
  (let [[room a] (join (g/new-room "R" {:turn-seconds 1 :voting-seconds 1}) "Alice")
        [room _] (join room "Bob")
        room (g/start-game room a 0 {})
        room (g/tick room 999)
        _ (is (empty? (:clues room)))
        room (g/tick room 1000)
        _ (is (= "(timeout)" (:clue (first (:clues room)))))
        room (g/tick room 2000)]
    (is (= "voting" (:phase room)))
    (is (= "game-over" (:phase (g/tick room 3000))))))

(defn- round [& names]
  (let [[room ids] (reduce (fn [[room ids] n] (let [[room id] (join room n)] [room (conj ids id)]))
                           [(g/new-room "R" {}) []] names)]
    [(g/start-game room (first ids) 0 {}) ids]))

(defn- imposter-of [room] (some #(when (= "imposter" (:role %)) (:id %)) (vals (:players room))))

(deftest late-joiner-spectates
  (let [[room [a b]] (round "A" "B")
        {room :room late :player-id} (g/join room {:name "Late" :uid "Late"})
        room (-> room (assoc :phase "voting") (g/cast-vote late a 0))]
    (is (false? (get-in room [:players late :alive])))
    (is (not (get-in room [:players late :voted])) "spectator cannot vote")
    (is (= room (g/cast-vote room a late 0)) "spectator cannot be voted for")))

(deftest wrong-ejection-is-imposter-win
  (let [[room ids] (round "A" "B" "C")
        imp (imposter-of room)
        [x y] (remove #{imp} ids)
        room (reduce #(g/cast-vote %1 %2 (if (= %2 x) y x) 0) (assoc room :phase "voting") ids)]
    (is (= "game-over" (:phase room)))
    (is (= "Imposter" (get-in room [:game-over :winner])))
    (is (= "Imposter" (get-in (g/tick (assoc room :phase "voting" :votes [] :voting-deadline 1) 1) [:game-over :winner]))
        "no votes at all: imposter survives")))

(deftest abandoned-round-returns-to-lobby
  (let [[room [a b c]] (round "A" "B" "C")
        room (-> room (g/disconnect b "B") (g/disconnect c "C"))]
    (is (= "lobby" (:phase (g/tick room 1))))
    (is (= [a] (keys (:players (g/tick room 1)))) "players who left are dropped")))

(deftest voting-ends-when-remaining-players-voted
  (let [[room [a b c]] (round "A" "B" "C")
        room (-> room (assoc :phase "voting") (g/cast-vote a b 0) (g/cast-vote b a 0) (g/disconnect c "C"))]
    (is (= "voting" (:phase room)))
    (is (= "game-over" (:phase (g/tick room 1))))))

(deftest ghosts-cannot-grow-room
  (let [[room _] (round "A" "B")
        room (reduce (fn [room i]
                       (let [{room' :room pid :player-id} (g/join room {:name (str "p" i) :uid "loop"})]
                         (if pid (g/disconnect room' pid "loop") room)))
                     room (range 50))]
    (is (= 10 (count (:players room))) "seats capped at max-players during a round")))
