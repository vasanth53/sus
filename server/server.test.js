const { createRoom, startGame, resetRoomGame } = require("./index");

function makePlayer(id, name, { connected = true } = {}) {
  return {
    id,
    name,
    token: `t_${id}`,
    socketId: null,
    connected,
    disconnectedAtMs: null,
    isAlive: true,
    role: null,
    word: null,
    hasVoted: false,
  };
}

describe("Imposter Game Server (room logic)", () => {
  test("startGame requires at least 2 connected players", () => {
    const room = createRoom("test_room");
    room.players.p1 = makePlayer("p1", "A", { connected: true });
    room.players.p2 = makePlayer("p2", "B", { connected: false });

    expect(startGame(room)).toBe(false);
    expect(room.gameState).toBe("lobby");
  });

  test("startGame assigns one imposter and a decoy word", () => {
    const room = createRoom("test_room2");
    room.players.p1 = makePlayer("p1", "A");
    room.players.p2 = makePlayer("p2", "B");
    room.players.p3 = makePlayer("p3", "C");

    expect(startGame(room)).toBe(true);
    expect(room.gameState).toBe("clue-giving");

    const roles = Object.values(room.players).map((p) => p.role);
    expect(roles.filter((r) => r === "imposter")).toHaveLength(1);
    expect(roles.filter((r) => r === "crewmate")).toHaveLength(2);

    const words = Object.values(room.players).map((p) => p.word);
    const wordCounts = words.reduce((acc, w) => acc.set(w, (acc.get(w) || 0) + 1), new Map());
    const counts = Array.from(wordCounts.values()).sort((a, b) => b - a);
    expect(counts[0]).toBe(2);
    expect(counts[1]).toBe(1);
  });

  test("resetRoomGame returns room to lobby", () => {
    const room = createRoom("test_room3");
    room.players.p1 = makePlayer("p1", "A");
    room.players.p2 = makePlayer("p2", "B");
    startGame(room);

    resetRoomGame(room);
    expect(room.gameState).toBe("lobby");
    expect(room.turnOrder).toHaveLength(0);
    expect(room.clues).toHaveLength(0);
  });
});

