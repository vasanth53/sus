const { listen } = require('@colyseus/tools');

const { ImposterRoom } = require('./ImposterRoom');

const PORT = Number(process.env.PORT || 3001);

async function main() {
  await listen(
    {
      initializeExpress: (app) => {
        app.disable('x-powered-by');
        app.use((req, res, next) => {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Referrer-Policy', 'no-referrer');
          next();
        });

        app.get('/', (req, res) => res.status(200).send('ok'));
        app.get('/health', (req, res) => res.status(200).json({ ok: true }));
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

