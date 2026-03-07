const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
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
    gameState: 'lobby', // lobby, clue-giving, voting, game-over
    secretWord: '',
    turnOrder: [],
    currentPlayerIndex: 0,
    clues: [],
    votes: {},
  };
}

const state = createInitialState();

const WORDS = ["Apple", "Bicycle", "Telescope", "Guitar", "Sunshine", "Ocean"];

// --- Helper Functions ---
function resetGame(nextState, ioInstance) {
  const resolvedState = nextState || state;
  const resolvedIo = ioInstance || io;
  resolvedState.gameState = 'lobby';
  resolvedState.secretWord = '';
  resolvedState.turnOrder = [];
  resolvedState.currentPlayerIndex = 0;
  resolvedState.clues = [];
  resolvedState.votes = {};

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
    resolvedIo.emit('updatePlayerList', Object.values(resolvedState.players));
  }
}

// --- Socket.IO Logic ---
function createConnectionHandler(ioInstance, currentState) {
  return (socket) => {
    socket.emit('updatePlayerList', Object.values(currentState.players));

    socket.on('joinGame', (name) => {
      if (currentState.gameState !== 'lobby') {
        return socket.emit('gameInProgress');
      }
      currentState.players[socket.id] = { id: socket.id, name, isAlive: true };
      ioInstance.emit('updatePlayerList', Object.values(currentState.players));
    });

    socket.on('startGame', () => {
      if (currentState.gameState !== 'lobby' || Object.keys(currentState.players).length < 2) return;

      currentState.gameState = 'clue-giving';
      currentState.secretWord = WORDS[Math.floor(Math.random() * WORDS.length)];
      const playerIds = Object.keys(currentState.players);
      const imposterId = playerIds[Math.floor(Math.random() * playerIds.length)];
      currentState.turnOrder = playerIds.sort(() => Math.random() - 0.5);
      currentState.currentPlayerIndex = 0;
      currentState.clues = [];
      currentState.votes = {};

      currentState.turnOrder.forEach((id) => {
        const isImposter = id === imposterId;
        currentState.players[id].role = isImposter ? 'imposter' : 'crewmate';
        currentState.players[id].word = isImposter ? '???' : currentState.secretWord;
        currentState.players[id].clue = null;
        currentState.players[id].hasVoted = false;
        const playerSocket = ioInstance.sockets?.sockets?.get(id);
        if (playerSocket) {
          playerSocket.emit('roundStarted', {
            role: currentState.players[id].role,
            word: currentState.players[id].word,
            turnOrder: currentState.turnOrder.map((pid) => currentState.players[pid].name),
            currentPlayer: currentState.players[currentState.turnOrder[currentState.currentPlayerIndex]].name,
          });
        }
      });
    });

    socket.on('submitClue', (clue) => {
      if (currentState.gameState !== 'clue-giving' || socket.id !== currentState.turnOrder[currentState.currentPlayerIndex]) return;
      const playerName = currentState.players[socket.id].name;
      currentState.clues.push({ sender: playerName, clue });
      ioInstance.emit('newClue', { sender: playerName, clue });
      currentState.currentPlayerIndex++;
      if (currentState.currentPlayerIndex >= currentState.turnOrder.length) {
        currentState.gameState = 'voting';
        ioInstance.emit('votingStarted', {
          clues: currentState.clues,
          players: Object.values(currentState.players).filter((p) => p.isAlive),
        });
      } else {
        ioInstance.emit('nextTurn', {
          currentPlayer: currentState.players[currentState.turnOrder[currentState.currentPlayerIndex]].name,
        });
      }
    });

    socket.on('castVote', (votedPlayerId) => {
      if (currentState.gameState !== 'voting' || !currentState.players[socket.id] || currentState.players[socket.id].hasVoted) return;
      if (!votedPlayerId || !currentState.players[votedPlayerId] || !currentState.players[votedPlayerId].isAlive) return;

      currentState.players[socket.id].hasVoted = true;
      currentState.votes[votedPlayerId] = (currentState.votes[votedPlayerId] || 0) + 1;

      const livingPlayers = Object.values(currentState.players).filter((p) => p.isAlive);
      const votedPlayers = livingPlayers.filter((p) => p.hasVoted);

      if (votedPlayers.length !== livingPlayers.length) return;

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
      } else {
        ioInstance.emit('voteResult', { ejected: currentState.players[ejectedPlayerId].name });
        setTimeout(() => resetGame(currentState, ioInstance), 5000);
      }
    });

    socket.on('disconnect', () => {
      if (currentState.players[socket.id]) {
        delete currentState.players[socket.id];
        ioInstance.emit('updatePlayerList', Object.values(currentState.players));
        if (currentState.gameState !== 'lobby' && Object.keys(currentState.players).length < 2) {
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
