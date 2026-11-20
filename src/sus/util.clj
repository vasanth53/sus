(ns sus.util
  (:require [clojure.string :as str]))


(defn parse-cors-origin
  "nil -> unset, :all -> \"*\", else a vector of rules."
  [v]
  (let [raw (str/trim (or v ""))]
    (cond (str/blank? raw) nil
          (= "*" raw) :all
          :else (->> (str/split raw #",") (map str/trim) (remove str/blank?) vec))))

(defn- norm [s] (-> s str/trim (str/replace #"/+$" "") str/lower-case))

(defn- uri [s] (try (let [u (java.net.URI. s)] (when (.getHost u) u)) (catch Exception _ nil)))

(defn- port-str [^java.net.URI u] (if (neg? (.getPort u)) "" (str (.getPort u))))

(defn- rule-matches? [rule origin]
  (let [o (uri origin)
        host (some-> o .getHost str/lower-case)]
    (cond
      (= rule (norm origin)) true
      (str/starts-with? rule "*.") (boolean (and host (str/ends-with? host (subs rule 1))))
      (str/includes? rule "://") (let [r (uri rule)]
                                   (boolean (and r o (= (.getScheme r) (.getScheme o))
                                                 (= (str/lower-case (.getHost r)) host)
                                                 (= (port-str r) (port-str o)))))
      :else (let [[_ h p] (re-matches #"(.*?)(?::(\d+))?" rule)]
              (boolean (and host (= h host) (or (nil? p) (= p (port-str o)))))))))

(defn origin-allowed?
  "allowed nil or :all accepts everything; otherwise origin must match a rule:
  exact origin, host[:port], or *.suffix wildcard."
  [allowed origin]
  (cond (or (nil? allowed) (= :all allowed)) true
        (str/blank? origin) false
        :else (boolean (some #(rule-matches? (norm %) origin) allowed))))

