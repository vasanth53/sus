# Imposter Word Game

Small multiplayer “imposter word” game:
- `server/`: Express + Colyseus game server
- `client/`: React (Create React App) UI

## Run with Docker (recommended)

Prereqs: Docker + Docker Compose.

```bash
docker compose up --build
```

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:3001`

Stop:
```bash
docker compose down
```

## Run locally (no Docker)

Prereqs: Node.js (recommended: Node 20+).

Backend:
```bash
cd server
npm ci
node index.js
```

Frontend:
```bash
cd client
npm ci
npm start
```

Open `http://localhost:3000`.

## Configuration

Backend env vars:
- `PORT` (default `3001`)
- `HOST` (default `0.0.0.0`)
- `CLIENT_ORIGIN` (default `http://localhost:3000`) — allowed browser Origin(s) (comma-separated) or `*`
- `MAX_PLAYERS` (default `10`)

Frontend env vars (CRA build-time):
- `REACT_APP_SOCKET_URL` (default: computed from browser host + `:3001`)

## Tests

```bash
cd server && npm test
cd client && CI=true npm test
```

## Deploy

### Frontend on Netlify

This repo includes a `netlify.toml` that builds/publishes the React app from `client/`.

In Netlify site settings, set this build-time env var:
- `REACT_APP_SOCKET_URL` = your backend URL (example: `https://imposter-game-backend.onrender.com`)

Tip: see `client/.env.example`.

### Backend (Socket.IO) hosting

Netlify Functions/Edge Functions are request-based and don’t run a long-lived Colyseus server, so the backend needs a WebSocket-capable host (Render/Fly/Railway/etc).

Backend required env vars:
- `CLIENT_ORIGIN` (set to your Netlify site URL; you can use a comma-separated list, or `*` to allow any origin)

Tip: see `server/.env.example`.

#### Render quickstart

Option A (recommended): use the included `render.yaml` blueprint.

Option B (manual):
- Create a new **Web Service** in Render from this repo
- Root directory: `server`
- Build command: `npm ci`
- Start command: `npm start`
- Env vars: `CLIENT_ORIGIN`

After Render deploys, copy the service URL and set Netlify `REACT_APP_SOCKET_URL` to that URL, then redeploy the Netlify site.
