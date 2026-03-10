const schema = require('@colyseus/schema');

const { Schema, type, MapSchema, ArraySchema } = schema;

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
type('string')(PlayerState.prototype, 'id');
type('string')(PlayerState.prototype, 'name');
type('boolean')(PlayerState.prototype, 'connected');
type('boolean')(PlayerState.prototype, 'isHost');
type('boolean')(PlayerState.prototype, 'isAlive');
type('boolean')(PlayerState.prototype, 'hasVoted');

class ClueState extends Schema {
  constructor() {
    super();
    this.sender = '';
    this.clue = '';
  }
}
type('string')(ClueState.prototype, 'sender');
type('string')(ClueState.prototype, 'clue');

class GameOverState extends Schema {
  constructor() {
    super();
    this.winner = '';
    this.ejected = '';
    this.imposter = '';
    this.secretWord = '';
  }
}
type('string')(GameOverState.prototype, 'winner');
type('string')(GameOverState.prototype, 'ejected');
type('string')(GameOverState.prototype, 'imposter');
type('string')(GameOverState.prototype, 'secretWord');

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

type('string')(RoomState.prototype, 'roomCode');
type('string')(RoomState.prototype, 'gameState');
type('string')(RoomState.prototype, 'hostPlayerId');
type({ map: PlayerState })(RoomState.prototype, 'players');
type([ 'string' ])(RoomState.prototype, 'turnOrder');
type('string')(RoomState.prototype, 'currentPlayer');
type([ ClueState ])(RoomState.prototype, 'clues');
type('number')(RoomState.prototype, 'turnDeadlineMs');
type('number')(RoomState.prototype, 'votingDeadlineMs');
type('number')(RoomState.prototype, 'turnTotalSeconds');
type('number')(RoomState.prototype, 'votingTotalSeconds');
type(GameOverState)(RoomState.prototype, 'gameOver');

module.exports = {
  schema,
  PlayerState,
  ClueState,
  GameOverState,
  RoomState,
};

