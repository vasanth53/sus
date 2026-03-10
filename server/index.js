const { listen } = require('@colyseus/tools');
const { matchMaker, createEndpoint, createRouter, getBearerToken } = require('@colyseus/core');
const { getTransport } = require('colyseus');

const { ImposterRoom } = require('./ImposterRoom');

const PORT = Number(process.env.PORT || 3001);

function jsonResponse(body, status = 200) {
  const json = JSON.stringify(body);
  return new Response(json, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': json.length.toString(),
    },
  });
}

function wrapSeatReservationForColyseusJs(reservation) {
  if (!reservation || typeof reservation !== 'object') return reservation;
  if (reservation.room) return reservation;

  const { name, roomId, processId, publicAddress } = reservation;
  if (!name || !roomId || !processId) return reservation;

  return {
    ...reservation,
    room: { name, roomId, processId, publicAddress },
  };
}

async function main() {
  await listen(
    {
      routes: createRouter(
        {
          root: createEndpoint('/', { method: 'GET' }, async () => new Response('ok', { status: 200 })),
          health: createEndpoint('/health', { method: 'GET' }, async () => jsonResponse({ ok: true })),
        },
        {
          openapi: { disabled: true },
          routerMiddleware: [
            {
              path: '/matchmake/:method/:roomName',
              middleware: async (ctx) => {
                if (ctx.method !== 'POST') return undefined;

                if (matchMaker.state === matchMaker.MatchMakerState.SHUTTING_DOWN) {
                  return jsonResponse({ code: 503, error: 'shutting_down' }, 503);
                }

                const requestHeaders = ctx.request.headers;
                const method = ctx.params.method;
                const roomName = ctx.params.roomName;

                try {
                  const response = await matchMaker.controller.invokeMethod(method, roomName, ctx.body, {
                    token: getBearerToken(requestHeaders.get('authorization')),
                    headers: requestHeaders,
                    ip:
                      requestHeaders.get('x-forwarded-for') ??
                      requestHeaders.get('x-client-ip') ??
                      requestHeaders.get('x-real-ip'),
                    req: ctx.request,
                  });

                  const transport = getTransport();
                  if (transport?.protocol !== undefined) response.protocol = transport.protocol;

                  return jsonResponse(wrapSeatReservationForColyseusJs(response));
                } catch (e) {
                  const code = Number(e?.code) || 500;
                  return jsonResponse({ code, error: e?.message || 'unknown' }, code);
                }
              },
            },
          ],
        },
      ),
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
