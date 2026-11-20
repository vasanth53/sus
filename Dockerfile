FROM clojure:temurin-21-tools-deps AS build
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY deps.edn package.json package-lock.json shadow-cljs.edn ./
RUN npm ci && clojure -P -M:run && clojure -P -A:cljs
COPY src src
COPY resources resources
RUN npx shadow-cljs release app

FROM clojure:temurin-21-tools-deps
WORKDIR /app
COPY --from=build /root/.m2 /root/.m2
COPY --from=build /app/deps.edn ./
COPY --from=build /app/src src
COPY --from=build /app/resources resources
ENV PORT=3001 HOST=0.0.0.0
EXPOSE 3001
CMD ["clojure", "-M:run"]
