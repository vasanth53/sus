# Imposter Word Game

Small multiplayer “imposter word” game:
- `server/`: Express + Socket.IO game server
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
- `CLIENT_ORIGIN` (default `http://localhost:3000`) — Socket.IO CORS origin

Frontend env vars (CRA build-time):
- `REACT_APP_SOCKET_URL` (default: computed from browser host + `:3001`)

## Tests

```bash
cd server && npm test
cd client && CI=true npm test
```

