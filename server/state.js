const schema = require('@colyseus/schema');

const { Schema, MapSchema, ArraySchema } = schema;

class PlayerState extends Schema {
  constructor() {
    super();
    this.id = '';
    this.name = '';
    this.connected = false;
    this.isHost = false;
    this.isAlive = true;
    this.hasVoted = false;
  }
}

class ClueState extends Schema {
  constructor() {
    super();
    this.sender = '';
    this.clue = '';
  }
}

class GameOverState extends Schema {
  constructor() {
    super();
    this.winner = '';
    this.ejected = '';
    this.imposter = '';
    this.secretWord = '';
  }
}

class RoomState extends Schema {
  constructor() {
    super();
    this.roomCode = '';
    this.gameState = 'lobby';
    this.hostPlayerId = '';
    this.players = new MapSchema();
    this.turnOrder = new ArraySchema();
    this.currentPlayer = '';
    this.clues = new ArraySchema();
    this.turnDeadlineMs = 0;
    this.votingDeadlineMs = 0;
    this.turnTotalSeconds = 30;
    this.votingTotalSeconds = 25;
    this.gameOver = null;
  }
}

schema.defineTypes(PlayerState, {
  id: 'string',
  name: 'string',
  connected: 'boolean',
  isHost: 'boolean',
  isAlive: 'boolean',
  hasVoted: 'boolean',
});

schema.defineTypes(ClueState, {
  sender: 'string',
  clue: 'string',
});

schema.defineTypes(GameOverState, {
  winner: 'string',
  ejected: 'string',
  imposter: 'string',
  secretWord: 'string',
});

schema.defineTypes(RoomState, {
  roomCode: 'string',
  gameState: 'string',
  hostPlayerId: 'string',
  players: { map: PlayerState },
  turnOrder: ['string'],
  currentPlayer: 'string',
  clues: [ClueState],
  turnDeadlineMs: 'number',
  votingDeadlineMs: 'number',
  turnTotalSeconds: 'number',
  votingTotalSeconds: 'number',
  gameOver: GameOverState,
});

module.exports = { schema, PlayerState, ClueState, GameOverState, RoomState };
