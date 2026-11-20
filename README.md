# Imposter Word Game

Small multiplayer "imposter word" game, in Clojure + ClojureScript.

- `src/sus/game.clj` — pure game rules (rooms, turns, votes, timeouts)
- `src/sus/server.clj` — http-kit server; [Sente](https://github.com/taoensso/sente) over WebSocket (`/chsk`); serves the client
- `src/sus/client.cljs` — Reagent UI, built with shadow-cljs into `resources/public/js`
- `src/sus/util.clj` — origin allowlist for the WebSocket handshake

Each client gets its own view of the room pushed as `:sus/state` (public state + only its own word and token).
Client → server events: `:sus/join` (with reply), `:sus/start`, `:sus/clue`, `:sus/vote`.

## Run locally

Prereqs: Java 21, Clojure CLI, Node 20+.

```bash
npm ci
npm run build          # or `npm run watch` while developing
clojure -M:run         # http://localhost:3001
```

## Run with Docker

```bash
docker compose up --build   # http://localhost:3001
```

## Configuration

- `PORT` (default `3001`), `HOST` (default `0.0.0.0`)
- `CLIENT_ORIGIN` — allowed browser Origin(s) for the WebSocket: exact origin, `host[:port]`, `*.suffix`, comma-separated, or `*`. Unset allows any.
- `MAX_PLAYERS` (default `10`), `TURN_SECONDS` (default `30`), `VOTING_SECONDS` (default `25`)

## Tests

```bash
clojure -M:test                 # unit tests (game rules, origin allowlist)
npm run build && npm run e2e    # boots the server, plays a full round with 3 headless Chromium players
```

## Deploy

Render only: one Docker service serves both the page and the WebSocket.

`render.yaml` keeps the existing service name `imposter-game-backend` and switches it from the old Node runtime (root dir `server/`) to the root `Dockerfile`. Sync the Blueprint in Render, then set `CLIENT_ORIGIN` to the service's own URL (e.g. `https://imposter-game-backend.onrender.com`).

If the service was created by hand rather than from the Blueprint, change it in the Render dashboard instead: Settings → Root Directory: empty, Runtime/Language: Docker, Dockerfile path `./Dockerfile`.
