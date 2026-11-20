(ns sus.util-test
  (:require [clojure.test :refer [deftest is]]
            [sus.util :refer [origin-allowed? parse-cors-origin]]))

(deftest unset-allows-all
  (is (origin-allowed? (parse-cors-origin "") "https://example.com"))
  (is (origin-allowed? (parse-cors-origin nil) "https://example.com")))

(deftest exact-origin
  (let [allowed (parse-cors-origin "https://imposter-word-game-vasanth.netlify.app/")]
    (is (origin-allowed? allowed "https://imposter-word-game-vasanth.netlify.app"))
    (is (origin-allowed? allowed "https://IMPOSTER-WORD-GAME-VASANTH.NETLIFY.APP"))
    (is (not (origin-allowed? allowed "https://evil.example")))
    (is (not (origin-allowed? allowed nil)))))

(deftest host-only
  (let [allowed (parse-cors-origin "imposter-word-game-vasanth.netlify.app")]
    (is (origin-allowed? allowed "https://imposter-word-game-vasanth.netlify.app"))
    (is (origin-allowed? allowed "http://imposter-word-game-vasanth.netlify.app")))
  (let [allowed (parse-cors-origin "localhost:3001")]
    (is (origin-allowed? allowed "http://localhost:3001"))
    (is (not (origin-allowed? allowed "http://localhost:3000")))))

(deftest wildcard
  (let [allowed (parse-cors-origin "*.netlify.app")]
    (is (origin-allowed? allowed "https://imposter-word-game-vasanth.netlify.app"))
    (is (origin-allowed? allowed "https://x.y.netlify.app"))
    (is (not (origin-allowed? allowed "https://netlify.app")))))

(deftest comma-list
  (let [allowed (parse-cors-origin "https://a.com, b.com")]
    (is (origin-allowed? allowed "https://a.com"))
    (is (origin-allowed? allowed "https://b.com"))
    (is (not (origin-allowed? allowed "https://c.com")))))
