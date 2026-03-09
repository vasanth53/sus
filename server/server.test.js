const { createInitialState, createConnectionHandler, resetGame } = require("./index");

function createMockSocket(id) {
  const handlers = new Map();
  const received = [];

  return {
    id,
    on(event, fn) {
      handlers.set(event, fn);
    },
    emit(event, payload) {
      received.push({ event, payload });
    },
    clientEmit(event, payload, ack) {
      const handler = handlers.get(event);
      if (handler) handler(payload, ack);
    },
    disconnect() {
      const handler = handlers.get("disconnect");
      if (handler) handler();
    },
    getReceived(event) {
      return received.filter((m) => m.event === event).map((m) => m.payload);
    },
  };
}

function createMockIo() {
  const sockets = new Map();
  const broadcasts = [];

  return {
    sockets: { sockets },
    emit(event, payload) {
      broadcasts.push({ event, payload });
      for (const socket of sockets.values()) socket.emit(event, payload);
    },
    connect(socket, connectionHandler) {
      sockets.set(socket.id, socket);
      connectionHandler(socket);
      return socket;
    },
    getBroadcasts(event) {
      return broadcasts.filter((m) => m.event === event).map((m) => m.payload);
    },
  };
}

describe("Imposter Game Server (unit)", () => {
  test("allows players to join the lobby", () => {
    const state = createInitialState();
    const io = createMockIo();
    const onConnection = createConnectionHandler(io, state);

    const a = io.connect(createMockSocket("a"), onConnection);
    const b = io.connect(createMockSocket("b"), onConnection);

    a.clientEmit("joinGame", { name: "Player 1", pin: "1234" });
    b.clientEmit("joinGame", { name: "Player 2", pin: "1234" });

    expect(Object.keys(state.players)).toHaveLength(2);
    expect(Object.values(state.players).map((p) => p.name)).toEqual(expect.arrayContaining(["Player 1", "Player 2"]));
    expect(io.getBroadcasts("updatePlayerList").at(-1)).toHaveLength(2);
  });

  test("does not start game with less than 2 players", () => {
    const state = createInitialState();
    const io = createMockIo();
    const onConnection = createConnectionHandler(io, state);

    const a = io.connect(createMockSocket("a"), onConnection);
    a.clientEmit("joinGame", { name: "Solo", pin: "1234" });
    a.clientEmit("startGame");

    expect(state.gameState).toBe("lobby");
    expect(a.getReceived("roundStarted")).toHaveLength(0);
  });

  test("starts game and assigns roles/words", () => {
    const state = createInitialState();
    const io = createMockIo();
    const onConnection = createConnectionHandler(io, state);

    const a = io.connect(createMockSocket("a"), onConnection);
    const b = io.connect(createMockSocket("b"), onConnection);
    const c = io.connect(createMockSocket("c"), onConnection);

    a.clientEmit("joinGame", { name: "Player 1", pin: "1234" });
    b.clientEmit("joinGame", { name: "Player 2", pin: "1234" });
    c.clientEmit("joinGame", { name: "Player 3", pin: "1234" });

    a.clientEmit("startGame");

    const startedA = a.getReceived("roundStarted")[0];
    const startedB = b.getReceived("roundStarted")[0];
    const startedC = c.getReceived("roundStarted")[0];

    expect(state.gameState).toBe("clue-giving");
    expect(startedA.turnOrder).toHaveLength(3);
    expect(startedB.turnOrder).toHaveLength(3);
    expect(startedC.turnOrder).toHaveLength(3);

    const roles = [startedA.role, startedB.role, startedC.role];
    const words = [startedA.word, startedB.word, startedC.word];

    expect(roles.filter((r) => r === "imposter")).toHaveLength(1);
    expect(roles.filter((r) => r === "crewmate")).toHaveLength(2);

    // Two crewmates share the secret word, imposter gets a different (plausible) word
    const wordCounts = words.reduce((acc, w) => acc.set(w, (acc.get(w) || 0) + 1), new Map());
    const counts = Array.from(wordCounts.values()).sort((a, b) => b - a);
    expect(counts[0]).toBe(2);
    expect(counts[1]).toBe(1);

    // Cleanup: ensure reset doesn't crash with connected players
    resetGame(state, io);
    expect(state.gameState).toBe("lobby");
  });

  test("only the host can start the game", () => {
    const state = createInitialState();
    const io = createMockIo();
    const onConnection = createConnectionHandler(io, state);

    const a = io.connect(createMockSocket("a"), onConnection);
    const b = io.connect(createMockSocket("b"), onConnection);

    a.clientEmit("joinGame", { name: "Host", pin: "1234" });
    b.clientEmit("joinGame", { name: "Guest", pin: "1234" });

    const host = Object.values(state.players).find((p) => p.name === "Host");
    expect(state.hostPlayerId).toBe(host.id);

    b.clientEmit("startGame");
    expect(state.gameState).toBe("lobby");

    a.clientEmit("startGame");
    expect(state.gameState).toBe("clue-giving");
  });
});
