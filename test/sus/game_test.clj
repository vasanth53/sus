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
        [room _] (join room "Bob")
        token (get-in room [:players a :token])]
    (is (= a (:host-id room)))
    (is (= "name_taken" (:error (g/join room {:name "alice"}))))
    (is (= "invalid_name" (:error (g/join room {:name "  \u0001 "}))))
    (testing "rejoin with token reclaims the seat"
      (is (= room (g/disconnect room a "stale-tab")) "old socket can't kick the seat holder")
      (let [room (g/disconnect room a "Alice")]
        (is (not= a (:host-id room)) "host passes on while away")
        (is (= a (:player-id (g/join room {:name "Alice" :token token}))))))
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
