const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require("socket.io");

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// --- Game State ---
function createInitialState() {
  return {
    players: {},
    hostPlayerId: null,
    socketToPlayerId: {},
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

const state = createInitialState();

const WORDS = ["Apple", "Bicycle", "Telescope", "Guitar", "Sunshine", "Ocean"];
const TURN_SECONDS = Number(process.env.TURN_SECONDS || 30);
const VOTING_SECONDS = Number(process.env.VOTING_SECONDS || 25);
const GAME_PIN = String(process.env.GAME_PIN || '1234');
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 10);
const NAME_MAX_LENGTH = 18;
const CLUE_MAX_LENGTH = 32;
const PRUNE_DISCONNECTED_AFTER_MS = Number(process.env.PRUNE_DISCONNECTED_AFTER_MS || 2 * 60 * 1000);

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ');
}

function isNameTaken(nextState, name) {
  const lower = name.toLowerCase();
  return Object.values(nextState.players).some((p) => (p?.name || '').toLowerCase() === lower);
}

function findPlayerByName(nextState, name) {
  const lower = name.toLowerCase();
  return Object.values(nextState.players).find((p) => (p?.name || '').toLowerCase() === lower) || null;
}

function getPlayerBySocketId(nextState, socketId) {
  const playerId = nextState.socketToPlayerId[socketId];
  if (!playerId) return null;
  return nextState.players[playerId] || null;
}

function generateToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
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
    clue: null,
    hasVoted: false,
  };
}

function broadcastLobby(ioInstance, currentState) {
  ioInstance.emit(
    'updatePlayerList',
    Object.values(currentState.players).map((p) => ({
      id: p.id,
      name: p.name,
      isAlive: Boolean(p.isAlive),
      connected: Boolean(p.connected),
      isHost: p.id === currentState.hostPlayerId,
    })),
  );
}

function rateLimit(socket, event, { windowMs, max }) {
  if (!socket.data) socket.data = {};
  if (!socket.data.rateLimits) socket.data.rateLimits = new Map();

  const now = Date.now();
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

function stopIntervals(nextState) {
  if (nextState.timers?.turnInterval) clearInterval(nextState.timers.turnInterval);
  if (nextState.timers?.votingInterval) clearInterval(nextState.timers.votingInterval);
  nextState.timers.turnInterval = null;
  nextState.timers.votingInterval = null;
  nextState.turnDeadlineMs = null;
  nextState.votingDeadlineMs = null;
}

// --- Helper Functions ---
function resetGame(nextState, ioInstance) {
  const resolvedState = nextState || state;
  const resolvedIo = ioInstance || io;

  stopIntervals(resolvedState);
  resolvedState.gameState = 'lobby';
  resolvedState.secretWord = '';
  resolvedState.turnOrder = [];
  resolvedState.currentPlayerIndex = 0;
  resolvedState.clues = [];
  resolvedState.votes = {};

  const now = Date.now();
  for (const id of Object.keys(resolvedState.players)) {
    const player = resolvedState.players[id];
    if (!player?.connected && player?.disconnectedAtMs && now - player.disconnectedAtMs > PRUNE_DISCONNECTED_AFTER_MS) {
      delete resolvedState.players[id];
    }
  }
  if (resolvedState.hostPlayerId && !resolvedState.players[resolvedState.hostPlayerId]) {
    resolvedState.hostPlayerId = null;
  }
  if (!resolvedState.hostPlayerId) {
    const firstConnected = Object.values(resolvedState.players).find((p) => p?.connected);
    resolvedState.hostPlayerId = firstConnected?.id || Object.keys(resolvedState.players)[0] || null;
  }

  for (const id of Object.keys(resolvedState.players)) {
    resolvedState.players[id] = {
      ...resolvedState.players[id],
      role: null,
      word: null,
      clue: null,
      isAlive: true,
      hasVoted: false,
    };
  }

  if (resolvedIo) {
    resolvedIo.emit('gameReset');
    broadcastLobby(resolvedIo, resolvedState);
  }
}

function emitTurnTimer(ioInstance, currentState) {
  if (!ioInstance) return;
  if (currentState.gameState !== 'clue-giving') return;
  const deadline = currentState.turnDeadlineMs;
  const currentId = currentState.turnOrder[currentState.currentPlayerIndex];
  const currentName = currentId && currentState.players[currentId] ? currentState.players[currentId].name : null;
  const secondsRemaining = deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null;
  ioInstance.emit('turnTimer', { secondsRemaining, currentPlayer: currentName });
}

function emitVotingTimer(ioInstance, currentState) {
  if (!ioInstance) return;
  if (currentState.gameState !== 'voting') return;
  const deadline = currentState.votingDeadlineMs;
  const secondsRemaining = deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null;
  ioInstance.emit('votingTimer', { secondsRemaining });
}

function finalizeVoting(ioInstance, currentState) {
  stopIntervals(currentState);

  const livingPlayers = Object.values(currentState.players).filter((p) => p.isAlive);

  let ejectedPlayerId = null;
  let isTie = false;

  const voteCounts = Object.entries(currentState.votes);
  if (voteCounts.length > 0) {
    const sortedVotes = voteCounts.sort((a, b) => b[1] - a[1]);
    if (sortedVotes.length > 1 && sortedVotes[0][1] === sortedVotes[1][1]) {
      isTie = true;
    } else {
      ejectedPlayerId = sortedVotes[0][0];
    }
  }

  const imposter = Object.values(currentState.players).find((p) => p.role === 'imposter');
  let result = {};

  if (isTie || !ejectedPlayerId) {
    result = { winner: 'Tie', ejected: null, imposter: imposter?.name || null, secretWord: currentState.secretWord };
  } else if (!currentState.players[ejectedPlayerId]) {
    result = { winner: 'Tie', ejected: null, imposter: imposter?.name || null, secretWord: currentState.secretWord };
  } else {
    currentState.players[ejectedPlayerId].isAlive = false;
    if (currentState.players[ejectedPlayerId].role === 'imposter') {
      result = {
        winner: 'Crewmates',
        ejected: currentState.players[ejectedPlayerId].name,
        imposter: imposter?.name || null,
        secretWord: currentState.secretWord,
      };
    } else {
      const remainingCrew = Object.values(currentState.players).filter((p) => p.isAlive && p.role === 'crewmate').length;
      const remainingImposters = Object.values(currentState.players).filter((p) => p.isAlive && p.role === 'imposter').length;
      if (remainingCrew <= remainingImposters) {
        result = {
          winner: 'Imposter',
          ejected: currentState.players[ejectedPlayerId].name,
          imposter: imposter?.name || null,
          secretWord: currentState.secretWord,
        };
      }
    }
  }

  if (result.winner) {
    currentState.gameState = 'game-over';
    ioInstance.emit('gameOver', result);
    setTimeout(() => resetGame(currentState, ioInstance), 5000);
    return;
  }

  if (ejectedPlayerId && currentState.players[ejectedPlayerId]) {
    ioInstance.emit('voteResult', { ejected: currentState.players[ejectedPlayerId].name });
  } else {
    ioInstance.emit('voteResult', { ejected: null });
  }
  setTimeout(() => resetGame(currentState, ioInstance), 5000);
}

function startVotingTimer(ioInstance, currentState) {
  if (!ioInstance) return;
  stopIntervals(currentState);
  currentState.votingDeadlineMs = Date.now() + VOTING_SECONDS * 1000;
  emitVotingTimer(ioInstance, currentState);
  const interval = setInterval(() => {
    emitVotingTimer(ioInstance, currentState);
    if (currentState.gameState !== 'voting') return;
    if (currentState.votingDeadlineMs && Date.now() >= currentState.votingDeadlineMs) {
      finalizeVoting(ioInstance, currentState);
    }
  }, 1000);
  interval.unref?.();
  currentState.timers.votingInterval = interval;
}

// --- Socket.IO Logic ---
function createConnectionHandler(ioInstance, currentState) {
  function attachSocket(player, socket) {
    if (player.socketId && currentState.socketToPlayerId[player.socketId] === player.id) {
      delete currentState.socketToPlayerId[player.socketId];
    }
    player.socketId = socket.id;
    player.connected = true;
    player.disconnectedAtMs = null;
    currentState.socketToPlayerId[socket.id] = player.id;
  }

  function buildStateSync(player) {
    const currentTurnPlayerId = currentState.turnOrder[currentState.currentPlayerIndex];
    const currentTurnPlayerName = currentTurnPlayerId && currentState.players[currentTurnPlayerId]
      ? currentState.players[currentTurnPlayerId].name
      : null;

    const turnSecondsRemaining = currentState.turnDeadlineMs
      ? Math.max(0, Math.ceil((currentState.turnDeadlineMs - Date.now()) / 1000))
      : null;
    const votingSecondsRemaining = currentState.votingDeadlineMs
      ? Math.max(0, Math.ceil((currentState.votingDeadlineMs - Date.now()) / 1000))
      : null;

    return {
      gameState: currentState.gameState,
      me: {
        id: player.id,
        name: player.name,
        isHost: player.id === currentState.hostPlayerId,
        role: player.role,
        word: player.word,
        hasVoted: Boolean(player.hasVoted),
      },
      lobbyPlayers: Object.values(currentState.players).map((p) => ({
        id: p.id,
        name: p.name,
        isAlive: Boolean(p.isAlive),
        connected: Boolean(p.connected),
        isHost: p.id === currentState.hostPlayerId,
      })),
      turnOrder: currentState.turnOrder.map((pid) => currentState.players[pid]?.name).filter(Boolean),
      currentPlayer: currentTurnPlayerName,
      clues: currentState.clues,
      votablePlayers: Object.values(currentState.players)
        .filter((p) => p.isAlive)
        .map((p) => ({ id: p.id, name: p.name })),
      turnSecondsRemaining,
      votingSecondsRemaining,
      secretWord: currentState.gameState === 'game-over' ? currentState.secretWord : null,
    };
  }

  function advanceWithClue(clueText) {
    if (currentState.gameState !== 'clue-giving') return;
    const currentId = currentState.turnOrder[currentState.currentPlayerIndex];
    const currentPlayer = currentId ? currentState.players[currentId] : null;
    if (!currentId || !currentPlayer) return;

    const cleaned = sanitizeText(clueText).slice(0, CLUE_MAX_LENGTH);
    const finalClue = cleaned || '(skipped)';
    currentState.clues.push({ sender: currentPlayer.name, clue: finalClue });
    ioInstance.emit('newClue', { sender: currentPlayer.name, clue: finalClue });

    currentState.currentPlayerIndex++;
    if (currentState.currentPlayerIndex >= currentState.turnOrder.length) {
      currentState.gameState = 'voting';
      stopIntervals(currentState);
      ioInstance.emit('votingStarted', {
        clues: currentState.clues,
        players: Object.values(currentState.players)
          .filter((p) => p.isAlive)
          .map((p) => ({ id: p.id, name: p.name })),
      });
      startVotingTimer(ioInstance, currentState);
      return;
    }

    ioInstance.emit('nextTurn', {
      currentPlayer: currentState.players[currentState.turnOrder[currentState.currentPlayerIndex]].name,
    });
    startTurnTimer(ioInstance, currentState);
  }

  function startTurnTimer(ioInstanceInner, stateInner) {
    if (!ioInstanceInner) return;
    if (stateInner.gameState !== 'clue-giving') return;

    if (stateInner.timers.turnInterval) clearInterval(stateInner.timers.turnInterval);
    stateInner.timers.turnInterval = null;
    stateInner.turnDeadlineMs = Date.now() + TURN_SECONDS * 1000;

    emitTurnTimer(ioInstanceInner, stateInner);
    const interval = setInterval(() => {
      emitTurnTimer(ioInstanceInner, stateInner);
      if (stateInner.gameState !== 'clue-giving') return;
      if (stateInner.turnDeadlineMs && Date.now() >= stateInner.turnDeadlineMs) {
        if (stateInner.timers.turnInterval) clearInterval(stateInner.timers.turnInterval);
        stateInner.timers.turnInterval = null;
        advanceWithClue('(skipped)');
      }
    }, 1000);
    interval.unref?.();
    stateInner.timers.turnInterval = interval;
  }

  return (socket) => {
    socket.emit(
      'updatePlayerList',
      Object.values(currentState.players).map((p) => ({
        id: p.id,
        name: p.name,
        isAlive: Boolean(p.isAlive),
        connected: Boolean(p.connected),
        isHost: p.id === currentState.hostPlayerId,
      })),
    );

    socket.on('joinGame', (payload, ack) => {
      const limit = rateLimit(socket, 'joinGame', { windowMs: 5000, max: 3 });
      if (!limit.ok) {
        ack?.({ ok: false, error: 'rate_limited', retryAfterMs: limit.retryAfterMs });
        return;
      }

      const name = sanitizeText(typeof payload === 'string' ? payload : payload?.name);
      const pin = sanitizeText(typeof payload === 'object' && payload ? payload.pin : '');
      const token = sanitizeText(typeof payload === 'object' && payload ? payload.token : '');

      if (!name || name.length > NAME_MAX_LENGTH) {
        ack?.({ ok: false, error: 'invalid_name' });
        return socket.emit('joinError', { error: 'invalid_name' });
      }

      if (pin !== GAME_PIN) {
        ack?.({ ok: false, error: 'auth_failed' });
        return socket.emit('authError', { error: 'auth_failed' });
      }

      const existing = findPlayerByName(currentState, name);

      if (currentState.gameState !== 'lobby') {
        if (!existing || !token || existing.token !== token) {
          ack?.({ ok: false, error: 'game_in_progress' });
          return socket.emit('gameInProgress');
        }
      }

      if (existing) {
        if (!token || existing.token !== token) {
          ack?.({ ok: false, error: 'name_taken' });
          return socket.emit('nameTaken');
        }
        attachSocket(existing, socket);
        broadcastLobby(ioInstance, currentState);
        socket.emit('stateSync', buildStateSync(existing));
        ack?.({ ok: true, isHost: existing.id === currentState.hostPlayerId, token: existing.token, playerId: existing.id });
        return;
      }

      if (Object.keys(currentState.players).length >= MAX_PLAYERS) {
        ack?.({ ok: false, error: 'lobby_full' });
        return socket.emit('lobbyFull');
      }

      const created = createPlayer(name);
      currentState.players[created.id] = created;
      attachSocket(created, socket);
      if (!currentState.hostPlayerId) currentState.hostPlayerId = created.id;

      broadcastLobby(ioInstance, currentState);
      socket.emit('stateSync', buildStateSync(created));
      ack?.({ ok: true, isHost: created.id === currentState.hostPlayerId, token: created.token, playerId: created.id });
    });

    socket.on('startGame', () => {
      const limit = rateLimit(socket, 'startGame', { windowMs: 8000, max: 2 });
      if (!limit.ok) return;
      const starter = getPlayerBySocketId(currentState, socket.id);
      if (!starter) return;
      if (currentState.hostPlayerId && starter.id !== currentState.hostPlayerId) return;
      const connectedPlayerIds = Object.values(currentState.players).filter((p) => p.connected).map((p) => p.id);
      if (currentState.gameState !== 'lobby' || connectedPlayerIds.length < 2) return;

      currentState.gameState = 'clue-giving';
      currentState.secretWord = WORDS[Math.floor(Math.random() * WORDS.length)];
      const imposterId = connectedPlayerIds[Math.floor(Math.random() * connectedPlayerIds.length)];
      currentState.turnOrder = connectedPlayerIds.sort(() => Math.random() - 0.5);
      currentState.currentPlayerIndex = 0;
      currentState.clues = [];
      currentState.votes = {};

      currentState.turnOrder.forEach((id) => {
        const isImposter = id === imposterId;
        currentState.players[id].role = isImposter ? 'imposter' : 'crewmate';
        currentState.players[id].word = isImposter ? '???' : currentState.secretWord;
        currentState.players[id].clue = null;
        currentState.players[id].hasVoted = false;
        const playerSocketId = currentState.players[id].socketId;
        const playerSocket = playerSocketId ? ioInstance.sockets?.sockets?.get(playerSocketId) : null;
        if (playerSocket) {
          playerSocket.emit('roundStarted', {
            role: currentState.players[id].role,
            word: currentState.players[id].word,
            turnOrder: currentState.turnOrder.map((pid) => currentState.players[pid].name),
            currentPlayer: currentState.players[currentState.turnOrder[currentState.currentPlayerIndex]].name,
          });
        }
      });
      startTurnTimer(ioInstance, currentState);
    });

    socket.on('submitClue', (clue) => {
      const limit = rateLimit(socket, 'submitClue', { windowMs: 2500, max: 5 });
      if (!limit.ok) return;
      const player = getPlayerBySocketId(currentState, socket.id);
      if (!player) return;
      if (currentState.gameState !== 'clue-giving' || player.id !== currentState.turnOrder[currentState.currentPlayerIndex]) return;
      const cleaned = sanitizeText(clue);
      if (!cleaned || cleaned.length > CLUE_MAX_LENGTH) return;
      if (currentState.timers.turnInterval) clearInterval(currentState.timers.turnInterval);
      currentState.timers.turnInterval = null;
      advanceWithClue(cleaned);
    });

    socket.on('castVote', (votedPlayerId) => {
      const limit = rateLimit(socket, 'castVote', { windowMs: 2500, max: 6 });
      if (!limit.ok) return;
      const voter = getPlayerBySocketId(currentState, socket.id);
      if (currentState.gameState !== 'voting' || !voter || voter.hasVoted) return;
      if (!votedPlayerId || !currentState.players[votedPlayerId] || !currentState.players[votedPlayerId].isAlive) return;

      voter.hasVoted = true;
      currentState.votes[votedPlayerId] = (currentState.votes[votedPlayerId] || 0) + 1;

      const livingPlayers = Object.values(currentState.players).filter((p) => p.isAlive);
      const votedPlayers = livingPlayers.filter((p) => p.hasVoted);

      if (votedPlayers.length === livingPlayers.length) {
        finalizeVoting(ioInstance, currentState);
      }
    });

    socket.on('disconnect', () => {
      const player = getPlayerBySocketId(currentState, socket.id);
      if (!player) return;

      delete currentState.socketToPlayerId[socket.id];
      player.connected = false;
      player.socketId = null;
      player.disconnectedAtMs = Date.now();

      if (currentState.gameState === 'lobby' && currentState.hostPlayerId === player.id) {
        const nextHost = Object.values(currentState.players).find((p) => p.connected);
        currentState.hostPlayerId = nextHost?.id || null;
      }

      broadcastLobby(ioInstance, currentState);

      if (currentState.gameState !== 'lobby') {
        const connectedCount = Object.values(currentState.players).filter((p) => p.connected).length;
        if (connectedCount < 2) {
          resetGame(currentState, ioInstance);
        }
      }
    });
  };
}

io.on('connection', createConnectionHandler(io, state));

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";

// Only start listening if the file is run directly
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Server listening on ${HOST}:${PORT}`);
  });
}

function getGameState() {
  return state.gameState;
}

function getSecretWord() {
  return state.secretWord;
}

module.exports = {
  server,
  io,
  state,
  createInitialState,
  createConnectionHandler,
  resetGame,
  getGameState,
  getSecretWord,
};
