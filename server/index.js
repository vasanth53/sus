const { listen } = require('@colyseus/tools');
const { matchMaker, getTransport } = require('@colyseus/core');

const { ImposterRoom } = require('./ImposterRoom');

const PORT = Number(process.env.PORT || 3001);

async function main() {
  await listen(
    {
      initializeExpress: (app) => {
        app.disable('x-powered-by');
        app.use(require('express').json());
        app.use((req, res, next) => {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Referrer-Policy', 'no-referrer');
          next();
        });

        app.get('/', (req, res) => res.status(200).send('ok'));
        app.get('/health', (req, res) => res.status(200).json({ ok: true }));

        // Compatibility: Colyseus.js expects `response.room.*` from matchmake.
        // Colyseus 0.17 returns a flat seat reservation (roomId/processId/name),
        // so we wrap it for older clients.
        app.post('/matchmake/:method/:roomName', async (req, res) => {
          if (matchMaker.state === matchMaker.MatchMakerState.SHUTTING_DOWN) {
            return res.status(503).json({ code: 503, error: 'shutting_down' });
          }

          const { method, roomName } = req.params;
          try {
            const response = await matchMaker.controller.invokeMethod(
              method,
              roomName,
              req.body,
              { headers: req.headers, ip: req.headers['x-forwarded-for'], req },
            );

            const transport = getTransport();
            if (transport?.protocol !== undefined) response.protocol = transport.protocol;

            if (!response.room && response.roomId && response.processId && response.name) {
              response.room = {
                name: response.name,
                roomId: response.roomId,
                processId: response.processId,
                publicAddress: response.publicAddress,
              };
            }

            return res.json(response);
          } catch (e) {
            const code = e?.code || 500;
            return res.status(Number(code) || 500).json({ code, error: e?.message || 'unknown' });
          }
        });
      },
      initializeGameServer: (gameServer) => {
        gameServer.define('imposter', ImposterRoom).filterBy(['roomCode']);
      },
      options: {
        // Matchmaker/monitor CORS is handled by Colyseus internals.
        // Per-room origin enforcement lives in ImposterRoom.onAuth().
      },
      displayLogs: true,
    },
    PORT,
  );
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
