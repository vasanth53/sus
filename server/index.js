const express = require('express');
const http = require('http');
const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');

const { ImposterRoom } = require('./ImposterRoom');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/', (req, res) => res.status(200).send('ok'));
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

const server = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server,
  }),
});

gameServer.define('imposter', ImposterRoom).filterBy(['roomCode']);
gameServer.onShutdown(() => {});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

if (require.main === module) {
  gameServer.listen(PORT, HOST).then(() => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on ${HOST}:${PORT}`);
  });
}

module.exports = {
  app,
  server,
  gameServer,
};
