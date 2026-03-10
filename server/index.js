const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

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

function parseCorsOrigin(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'http://localhost:3000';
  if (raw === '*') return true;
  if (raw.includes(',')) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return raw;
}

const io = new Server(server, {
  cors: {
    origin: parseCorsOrigin(process.env.CLIENT_ORIGIN),
    methods: ['GET', 'POST'],
  },
});

const DEFAULT_ROOM_ID = 'public';

const WORDS = ['Apple', 'Bicycle', 'Telescope', 'Guitar', 'Sunshine', 'Ocean'];
const TURN_SECONDS = Number(process.env.TURN_SECONDS || 30);
const VOTING_SECONDS = Number(process.env.VOTING_SECONDS || 25);

// Mandatory server PIN (used for join + matchmaking)
const GAME_PIN = String(process.env.GAME_PIN || '1234');

const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS || 10);
const PRUNE_DISCONNECTED_AFTER_MS = Number(process.env.PRUNE_DISCONNECTED_AFTER_MS || 2 * 60 * 1000);
const ROOM_IDLE_TTL_MS = Number(process.env.ROOM_IDLE_TTL_MS || 10 * 60 * 1000);

const MATCH_SIZE = Number(process.env.MATCH_SIZE || 4);
const MATCH_MAX_WAIT_MS = Number(process.env.MATCH_MAX_WAIT_MS || 10 * 1000);

const NAME_MAX_LENGTH = 18;
const CLUE_MAX_LENGTH = 32;

function nowMs() {
  return Date.now();
}

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ');
}

function generateToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function rateLimit(socket, event, { windowMs, max }) {
  if (!socket.data) socket.data = {};
  if (!socket.data.rateLimits) socket.data.rateLimits = new Map();

  const now = nowMs();
  const existing = socket.data.rateLimits.get(event);
  if (!existing || now >= existing.resetAt) {
    socket.data.rateLimits.set(event, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  if (existing.count >= max) {
    return { ok: false, retryAfterMs: Math.max(0, existing.resetAt - now) };
  }

  existing.count += 1;
  return { ok: true };
}

function createPlayer(name) {
  const id = generateToken(8);
  return {
    id,
    name,
    token: generateToken(24),
    socketId: null,
    connected: false,
    disconnectedAtMs: null,
    isAlive: true,
    role: null,
    word: null,
    hasVoted: false,
  };
}

function createRoom(roomId, { isMatchmade = false } = {}) {
  return {
    id: roomId,
    isMatchmade,
    createdAtMs: nowMs(),
    lastActiveAtMs: nowMs(),

    // Players are keyed by stable playerId (not socketId)
    players: {},
    hostPlayerId: null,
    socketToPlayerId: {},

    // Game state
    gameState: 'lobby', // lobby, clue-giving, voting, game-over
    secretWord: '',
    turnOrder: [],
    currentPlayerIndex: 0,
    clues: [],
    votes: {},

    timers: {
      turnInterval: null,
      votingInterval: null,
    },
    turnDeadlineMs: null,
    votingDeadlineMs: null,
  };
}

const rooms = new Map();
const matchmakingQueue = [];

function getOrCreateRoom(roomId) {
  const id = roomId || DEFAULT_ROOM_ID;
  if (!rooms.has(id)) rooms.set(id, createRoom(id));
  return rooms.get(id);
}

function pruneRoom(room) {
  const now = nowMs();
  for (const id of Object.keys(room.players)) {
    const p = room.players[id];
    if (!p?.connected && p?.disconnectedAtMs && now - p.disconnectedAtMs > PRUNE_DISCONNECTED_AFTER_MS) {
      delete room.players[id];
    }
  }
  if (room.hostPlayerId && !room.players[room.hostPlayerId]) {
    room.hostPlayerId = null;
  }
  if (!room.hostPlayerId) {
    const firstConnected = Object.values(room.players).find((p) => p.connected);
    room.hostPlayerId = firstConnected?.id || Object.keys(room.players)[0] || null;
  }

  // If a non-public room is empty, remove it
  const hasAnyPlayers = Object.keys(room.players).length > 0;
  if (!hasAnyPlayers && room.id !== DEFAULT_ROOM_ID) {
    rooms.delete(room.id);
  }
}

function stopIntervals(room) {
  if (room.timers.turnInterval) clearInterval(room.timers.turnInterval);
  if (room.timers.votingInterval) clearInterval(room.timers.votingInterval);
  room.timers.turnInterval = null;
  room.timers.votingInterval = null;
  room.turnDeadlineMs = null;
  room.votingDeadlineMs = null;
}

function publicPlayers(room) {
  return Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    isAlive: Boolean(p.isAlive),
    connected: Boolean(p.connected),
    isHost: p.id === room.hostPlayerId,
  }));
}

function broadcastLobby(room) {
  io.to(room.id).emit('updatePlayerList', publicPlayers(room));
}

function findPlayerByName(room, name) {
  const lower = name.toLowerCase();
  return Object.values(room.players).find((p) => (p?.name || '').toLowerCase() === lower) || null;
}

function getPlayerBySocket(room, socketId) {
  const playerId = room.socketToPlayerId[socketId];
  if (!playerId) return null;
  return room.players[playerId] || null;
}

function attachSocket(room, player, socket) {
  if (player.socketId && room.socketToPlayerId[player.socketId] === player.id) {
    delete room.socketToPlayerId[player.socketId];
  }

  player.socketId = socket.id;
  player.connected = true;
  player.disconnectedAtMs = null;
  room.socketToPlayerId[socket.id] = player.id;

  socket.data = socket.data || {};
  socket.data.roomId = room.id;
  socket.join(room.id);
  room.lastActiveAtMs = nowMs();
}

function buildStateSync(room, player) {
  const currentTurnPlayerId = room.turnOrder[room.currentPlayerIndex];
  const currentTurnName = currentTurnPlayerId && room.players[currentTurnPlayerId] ? room.players[currentTurnPlayerId].name : null;

  const turnSecondsRemaining = room.turnDeadlineMs ? Math.max(0, Math.ceil((room.turnDeadlineMs - nowMs()) / 1000)) : null;
  const votingSecondsRemaining = room.votingDeadlineMs ? Math.max(0, Math.ceil((room.votingDeadlineMs - nowMs()) / 1000)) : null;

  return {
    roomId: room.id,
    gameState: room.gameState,
    me: {
      id: player.id,
      name: player.name,
      isHost: player.id === room.hostPlayerId,
      word: player.word,
      hasVoted: Boolean(player.hasVoted),
      token: player.token,
    },
    lobbyPlayers: publicPlayers(room),
    turnOrder: room.turnOrder.map((pid) => room.players[pid]?.name).filter(Boolean),
    currentPlayer: currentTurnName,
    clues: room.clues,
    votablePlayers: Object.values(room.players)
      .filter((p) => p.isAlive)
      .map((p) => ({ id: p.id, name: p.name })),
    turnSecondsRemaining,
    votingSecondsRemaining,
    turnDeadlineMs: room.turnDeadlineMs,
    votingDeadlineMs: room.votingDeadlineMs,
    turnTotalSeconds: TURN_SECONDS,
    votingTotalSeconds: VOTING_SECONDS,
  };
}

function emitTurnTimer(room) {
  if (room.gameState !== 'clue-giving') return;
  const deadline = room.turnDeadlineMs;
  const currentId = room.turnOrder[room.currentPlayerIndex];
  const currentName = currentId && room.players[currentId] ? room.players[currentId].name : null;
  const secondsRemaining = deadline ? Math.max(0, Math.ceil((deadline - nowMs()) / 1000)) : null;
  io.to(room.id).emit('turnTimer', { secondsRemaining, currentPlayer: currentName, deadlineMs: deadline, totalSeconds: TURN_SECONDS });
}

function emitVotingTimer(room) {
  if (room.gameState !== 'voting') return;
  const deadline = room.votingDeadlineMs;
  const secondsRemaining = deadline ? Math.max(0, Math.ceil((deadline - nowMs()) / 1000)) : null;
  io.to(room.id).emit('votingTimer', { secondsRemaining, deadlineMs: deadline, totalSeconds: VOTING_SECONDS });
}

function resetRoomGame(room) {
  stopIntervals(room);
  room.gameState = 'lobby';
  room.secretWord = '';
  room.turnOrder = [];
  room.currentPlayerIndex = 0;
  room.clues = [];
  room.votes = {};

  pruneRoom(room);
  for (const id of Object.keys(room.players)) {
    room.players[id] = {
      ...room.players[id],
      isAlive: true,
      role: null,
      word: null,
      hasVoted: false,
    };
  }

  io.to(room.id).emit('gameReset');
  broadcastLobby(room);
}

function startVotingTimer(room) {
  stopIntervals(room);
  room.votingDeadlineMs = nowMs() + VOTING_SECONDS * 1000;
  emitVotingTimer(room);
  const interval = setInterval(() => {
    emitVotingTimer(room);
    if (room.gameState !== 'voting') return;
    if (room.votingDeadlineMs && nowMs() >= room.votingDeadlineMs) {
      finalizeVoting(room);
    }
  }, 1000);
  interval.unref?.();
  room.timers.votingInterval = interval;
}

function startTurnTimer(room) {
  if (room.gameState !== 'clue-giving') return;
  if (room.timers.turnInterval) clearInterval(room.timers.turnInterval);
  room.timers.turnInterval = null;
  room.turnDeadlineMs = nowMs() + TURN_SECONDS * 1000;

  emitTurnTimer(room);
  const interval = setInterval(() => {
    emitTurnTimer(room);
    if (room.gameState !== 'clue-giving') return;
    if (room.turnDeadlineMs && nowMs() >= room.turnDeadlineMs) {
      if (room.timers.turnInterval) clearInterval(room.timers.turnInterval);
      room.timers.turnInterval = null;
      advanceWithClue(room, '(skipped)');
    }
  }, 1000);
  interval.unref?.();
  room.timers.turnInterval = interval;
}

function advanceWithClue(room, clueText) {
  if (room.gameState !== 'clue-giving') return;
  const currentId = room.turnOrder[room.currentPlayerIndex];
  const currentPlayer = currentId ? room.players[currentId] : null;
  if (!currentId || !currentPlayer) return;

  const cleaned = sanitizeText(clueText).slice(0, CLUE_MAX_LENGTH);
  const finalClue = cleaned || '(skipped)';
  room.clues.push({ sender: currentPlayer.name, clue: finalClue });
  io.to(room.id).emit('newClue', { sender: currentPlayer.name, clue: finalClue });

  room.currentPlayerIndex++;
  if (room.currentPlayerIndex >= room.turnOrder.length) {
    room.gameState = 'voting';
    stopIntervals(room);
    io.to(room.id).emit('votingStarted', {
      clues: room.clues,
      players: Object.values(room.players).filter((p) => p.isAlive).map((p) => ({ id: p.id, name: p.name })),
    });
    startVotingTimer(room);
    return;
  }

  io.to(room.id).emit('nextTurn', { currentPlayer: room.players[room.turnOrder[room.currentPlayerIndex]].name });
  startTurnTimer(room);
}

function finalizeVoting(room) {
  stopIntervals(room);

  let ejectedPlayerId = null;
  let isTie = false;
  const voteCounts = Object.entries(room.votes);
  if (voteCounts.length > 0) {
    const sortedVotes = voteCounts.sort((a, b) => b[1] - a[1]);
    if (sortedVotes.length > 1 && sortedVotes[0][1] === sortedVotes[1][1]) isTie = true;
    else ejectedPlayerId = sortedVotes[0][0];
  }

  const imposter = Object.values(room.players).find((p) => p.role === 'imposter');
  let result = {};

  if (isTie || !ejectedPlayerId || !room.players[ejectedPlayerId]) {
    result = { winner: 'Tie', ejected: null, imposter: imposter?.name || null, secretWord: room.secretWord };
  } else {
    room.players[ejectedPlayerId].isAlive = false;
    if (room.players[ejectedPlayerId].role === 'imposter') {
      result = { winner: 'Crewmates', ejected: room.players[ejectedPlayerId].name, imposter: imposter?.name || null, secretWord: room.secretWord };
    } else {
      const remainingCrew = Object.values(room.players).filter((p) => p.isAlive && p.role === 'crewmate').length;
      const remainingImposters = Object.values(room.players).filter((p) => p.isAlive && p.role === 'imposter').length;
      if (remainingCrew <= remainingImposters) {
        result = { winner: 'Imposter', ejected: room.players[ejectedPlayerId].name, imposter: imposter?.name || null, secretWord: room.secretWord };
      }
    }
  }

  if (result.winner) {
    room.gameState = 'game-over';
    io.to(room.id).emit('gameOver', result);
    setTimeout(() => resetRoomGame(room), 5000);
    return;
  }

  io.to(room.id).emit('voteResult', { ejected: ejectedPlayerId ? room.players[ejectedPlayerId]?.name || null : null });
  setTimeout(() => resetRoomGame(room), 5000);
}

function startGame(room) {
  const connectedPlayerIds = Object.values(room.players).filter((p) => p.connected).map((p) => p.id);
  if (connectedPlayerIds.length < 2) return false;

  room.gameState = 'clue-giving';
  room.secretWord = WORDS[Math.floor(Math.random() * WORDS.length)];
  const imposterId = connectedPlayerIds[Math.floor(Math.random() * connectedPlayerIds.length)];
  room.turnOrder = connectedPlayerIds.sort(() => Math.random() - 0.5);
  room.currentPlayerIndex = 0;
  room.clues = [];
  room.votes = {};

  for (const id of room.turnOrder) {
    const isImposter = id === imposterId;
    room.players[id].role = isImposter ? 'imposter' : 'crewmate';
    if (isImposter) {
      const alternatives = WORDS.filter((w) => w !== room.secretWord);
      room.players[id].word = alternatives.length ? alternatives[Math.floor(Math.random() * alternatives.length)] : '???';
    } else {
      room.players[id].word = room.secretWord;
    }
    room.players[id].hasVoted = false;

    const sockId = room.players[id].socketId;
    const sock = sockId ? io.sockets.sockets.get(sockId) : null;
    if (sock) {
      sock.emit('roundStarted', {
        word: room.players[id].word,
        turnOrder: room.turnOrder.map((pid) => room.players[pid].name),
        currentPlayer: room.players[room.turnOrder[room.currentPlayerIndex]].name,
      });
    }
  }

  startTurnTimer(room);
  return true;
}

function tryMatchmake() {
  const now = nowMs();
  // Remove disconnected sockets
  for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
    const entry = matchmakingQueue[i];
    if (!entry.socket.connected) matchmakingQueue.splice(i, 1);
  }

  if (matchmakingQueue.length < 2) return;

  const oldest = matchmakingQueue[0];
  const canStartSmall = now - oldest.queuedAtMs >= MATCH_MAX_WAIT_MS;

  const groupSize = matchmakingQueue.length >= MATCH_SIZE ? MATCH_SIZE : canStartSmall ? Math.min(2, matchmakingQueue.length) : 0;
  if (!groupSize) return;

  const group = matchmakingQueue.splice(0, groupSize);
  const roomId = `m_${generateRoomCode()}`;
  const room = createRoom(roomId, { isMatchmade: true });
  rooms.set(roomId, room);

  group.forEach((entry, idx) => {
    const { socket, payload } = entry;
    const name = sanitizeText(payload?.name || `Player ${idx + 1}`).slice(0, NAME_MAX_LENGTH);
    const player = createPlayer(name);
    room.players[player.id] = player;
    attachSocket(room, player, socket);
    if (!room.hostPlayerId) room.hostPlayerId = player.id;
    socket.emit('matchFound', { roomId });
    socket.emit('stateSync', buildStateSync(room, player));
  });

  broadcastLobby(room);
}

setInterval(() => {
  tryMatchmake();
  // Idle room cleanup
  const now = nowMs();
  for (const room of rooms.values()) {
    const hasAnyConnected = Object.values(room.players).some((p) => p.connected);
    if (room.id !== DEFAULT_ROOM_ID && !hasAnyConnected && now - room.lastActiveAtMs > ROOM_IDLE_TTL_MS) {
      stopIntervals(room);
      rooms.delete(room.id);
    }
  }
}, 1000).unref?.();

io.on('connection', (socket) => {
  socket.emit('serverInfo', {
    requiresPin: true,
    matchmaking: { enabled: true, targetSize: MATCH_SIZE, maxWaitMs: MATCH_MAX_WAIT_MS },
  });

  socket.on('createRoom', (payload, ack) => {
    const limit = rateLimit(socket, 'createRoom', { windowMs: 5000, max: 3 });
    if (!limit.ok) return ack?.({ ok: false, error: 'rate_limited' });

    const pin = sanitizeText(payload?.pin || '');
    if (pin !== GAME_PIN) return ack?.({ ok: false, error: 'auth_failed' });

    const roomId = `r_${generateRoomCode()}`;
    rooms.set(roomId, createRoom(roomId));
    return ack?.({ ok: true, roomId });
  });

  function handleJoinRoom(payload, ack) {
    const limit = rateLimit(socket, 'joinRoom', { windowMs: 5000, max: 3 });
    if (!limit.ok) return ack?.({ ok: false, error: 'rate_limited' });

    const roomId = sanitizeText(payload?.roomId || DEFAULT_ROOM_ID);
    const pin = sanitizeText(payload?.pin || '');
    const name = sanitizeText(payload?.name || '').slice(0, NAME_MAX_LENGTH);
    const token = sanitizeText(payload?.token || '');
    if (!name) {
      socket.emit('joinError', { error: 'invalid_name' });
      return ack?.({ ok: false, error: 'invalid_name' });
    }
    if (pin !== GAME_PIN) {
      socket.emit('authError', { error: 'auth_failed' });
      return ack?.({ ok: false, error: 'auth_failed' });
    }

    const room = getOrCreateRoom(roomId);
    pruneRoom(room);
    if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('lobbyFull');
      return ack?.({ ok: false, error: 'lobby_full' });
    }

    const existing = findPlayerByName(room, name);
    if (room.gameState !== 'lobby') {
      if (!existing || !token || existing.token !== token) {
        socket.emit('gameInProgress');
        return ack?.({ ok: false, error: 'game_in_progress' });
      }
    }

    let player = existing;
    if (player) {
      if (!token || player.token !== token) {
        socket.emit('nameTaken');
        return ack?.({ ok: false, error: 'name_taken' });
      }
    } else {
      player = createPlayer(name);
      room.players[player.id] = player;
    }

    attachSocket(room, player, socket);
    if (!room.hostPlayerId) room.hostPlayerId = player.id;

    broadcastLobby(room);
    socket.emit('stateSync', buildStateSync(room, player));
    return ack?.({ ok: true, roomId: room.id, playerId: player.id, token: player.token, isHost: player.id === room.hostPlayerId });
  }

  socket.on('joinRoom', (payload, ack) => handleJoinRoom(payload, ack));

  // Back-compat: existing client uses joinGame/startGame/submitClue/castVote
  socket.on('joinGame', (payload, ack) => handleJoinRoom({ ...(payload || {}), roomId: DEFAULT_ROOM_ID }, ack));

  socket.on('quickMatch', (payload, ack) => {
    const limit = rateLimit(socket, 'quickMatch', { windowMs: 5000, max: 2 });
    if (!limit.ok) return ack?.({ ok: false, error: 'rate_limited' });

    const pin = sanitizeText(payload?.pin || '');
    const name = sanitizeText(payload?.name || '').slice(0, NAME_MAX_LENGTH);
    if (!name) return ack?.({ ok: false, error: 'invalid_name' });
    if (pin !== GAME_PIN) return ack?.({ ok: false, error: 'auth_failed' });

    const alreadyQueued = matchmakingQueue.some((e) => (e.payload?.name || '').toLowerCase() === name.toLowerCase() && e.socket.connected);
    if (alreadyQueued) return ack?.({ ok: false, error: 'name_in_queue' });

    matchmakingQueue.push({ socket, payload: { name }, queuedAtMs: nowMs() });
    ack?.({ ok: true, queued: true });
    tryMatchmake();
  });

  socket.on('startGame', () => {
    const roomId = socket.data?.roomId || DEFAULT_ROOM_ID;
    const room = rooms.get(roomId);
    if (!room) return;
    const limit = rateLimit(socket, 'startGame', { windowMs: 8000, max: 2 });
    if (!limit.ok) return;
    const starter = getPlayerBySocket(room, socket.id);
    if (!starter) return;
    if (room.hostPlayerId && starter.id !== room.hostPlayerId) return;
    if (room.gameState !== 'lobby') return;
    startGame(room);
  });

  socket.on('submitClue', (clue) => {
    const roomId = socket.data?.roomId || DEFAULT_ROOM_ID;
    const room = rooms.get(roomId);
    if (!room) return;
    const limit = rateLimit(socket, 'submitClue', { windowMs: 2500, max: 5 });
    if (!limit.ok) return;
    const player = getPlayerBySocket(room, socket.id);
    if (!player) return;
    if (room.gameState !== 'clue-giving') return;
    if (player.id !== room.turnOrder[room.currentPlayerIndex]) return;
    const cleaned = sanitizeText(clue);
    if (!cleaned || cleaned.length > CLUE_MAX_LENGTH) return;
    if (room.timers.turnInterval) clearInterval(room.timers.turnInterval);
    room.timers.turnInterval = null;
    advanceWithClue(room, cleaned);
  });

  socket.on('castVote', (votedPlayerId) => {
    const roomId = socket.data?.roomId || DEFAULT_ROOM_ID;
    const room = rooms.get(roomId);
    if (!room) return;
    const limit = rateLimit(socket, 'castVote', { windowMs: 2500, max: 6 });
    if (!limit.ok) return;
    const voter = getPlayerBySocket(room, socket.id);
    if (!voter || voter.hasVoted) return;
    if (room.gameState !== 'voting') return;
    if (!votedPlayerId || !room.players[votedPlayerId] || !room.players[votedPlayerId].isAlive) return;

    voter.hasVoted = true;
    room.votes[votedPlayerId] = (room.votes[votedPlayerId] || 0) + 1;

    const required = Object.values(room.players).filter((p) => p.isAlive && p.connected).length;
    const voted = Object.values(room.players).filter((p) => p.isAlive && p.connected && p.hasVoted).length;
    if (required > 0 && voted >= required) finalizeVoting(room);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data?.roomId || DEFAULT_ROOM_ID;
    const room = rooms.get(roomId);
    if (!room) return;

    const player = getPlayerBySocket(room, socket.id);
    if (!player) return;
    delete room.socketToPlayerId[socket.id];

    player.connected = false;
    player.socketId = null;
    player.disconnectedAtMs = nowMs();

    if (room.gameState === 'lobby' && room.hostPlayerId === player.id) {
      const nextHost = Object.values(room.players).find((p) => p.connected);
      room.hostPlayerId = nextHost?.id || null;
    }

    // If it's their turn, immediately skip to keep flow going
    if (room.gameState === 'clue-giving' && room.turnOrder[room.currentPlayerIndex] === player.id) {
      advanceWithClue(room, '(disconnected)');
    }

    broadcastLobby(room);
    room.lastActiveAtMs = nowMs();
  });
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Server listening on ${HOST}:${PORT}`);
  });
}

module.exports = {
  server,
  io,
  rooms,
  createRoom,
  getOrCreateRoom,
  startGame,
  resetRoomGame,
};
