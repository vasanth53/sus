const { attachSocket, createRoom, rooms } = require('./index');

function makePlayer(id, name) {
  return {
    id,
    name,
    token: `t_${id}`,
    socketId: null,
    connected: false,
    disconnectedAtMs: null,
    isAlive: true,
    role: null,
    word: null,
    hasVoted: false,
  };
}

function makeSocket(id) {
  const joined = new Set([id]);
  return {
    id,
    rooms: joined,
    data: {},
    join: (roomId) => joined.add(roomId),
    leave: (roomId) => joined.delete(roomId),
  };
}

describe('attachSocket', () => {
  beforeEach(() => {
    rooms.clear();
  });

  test('leaves previously joined rooms and clears old socket mappings', () => {
    const roomA = createRoom('r_A');
    const roomB = createRoom('r_B');
    rooms.set(roomA.id, roomA);
    rooms.set(roomB.id, roomB);

    const socket = makeSocket('s1');
    const playerA = makePlayer('pA', 'Alice');
    const playerB = makePlayer('pB', 'Alice');
    roomA.players[playerA.id] = playerA;
    roomB.players[playerB.id] = playerB;

    // Simulate already joined roomA
    socket.rooms.add(roomA.id);
    roomA.socketToPlayerId[socket.id] = playerA.id;
    playerA.socketId = socket.id;
    playerA.connected = true;

    // Now attach to roomB. Should leave roomA and detach mapping.
    attachSocket(roomB, playerB, socket);

    expect(socket.rooms.has(roomA.id)).toBe(false);
    expect(socket.rooms.has(roomB.id)).toBe(true);
    expect(roomA.socketToPlayerId[socket.id]).toBeUndefined();
    expect(playerA.connected).toBe(false);
    expect(playerA.socketId).toBeNull();
    expect(roomB.socketToPlayerId[socket.id]).toBe(playerB.id);
    expect(playerB.connected).toBe(true);
    expect(playerB.socketId).toBe(socket.id);
  });
});

