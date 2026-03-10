const { Room } = require('colyseus');
const { RoomState, PlayerState, ClueState, GameOverState } = require('./state');
const { nowMs, sanitizeText, generateToken } = require('./util');
const { startRound, tallyVotes } = require('./game');
const { parseCorsOrigin, originIsAllowed } = require('./util');

const DEFAULT_TURN_SECONDS = 30;
const DEFAULT_VOTING_SECONDS = 25;

const allowedOrigins = parseCorsOrigin(process.env.CLIENT_ORIGIN);

class ImposterRoom extends Room {
  onCreate(options) {
    const roomCode = sanitizeText(options?.roomCode || '').toUpperCase();
    this.roomCode = roomCode;
    this.setMetadata({ roomCode });

    this.state = new RoomState();
    this.state.roomCode = roomCode;
    this.state.gameState = 'lobby';
    this.state.turnTotalSeconds = Number(process.env.TURN_SECONDS || DEFAULT_TURN_SECONDS);
    this.state.votingTotalSeconds = Number(process.env.VOTING_SECONDS || DEFAULT_VOTING_SECONDS);

    this.maxClients = Number(process.env.MAX_PLAYERS || 10);

    this.playerIdBySessionId = new Map();
    this.playerPrivate = new Map(); // playerId -> { token, role, word }
    this.votesByTargetId = {};

    this.turnTimeout = null;
    this.votingTimeout = null;

    this.onMessage('startGame', (client) => this.handleStartGame(client));
    this.onMessage('submitClue', (client, payload) => this.handleSubmitClue(client, payload));
    this.onMessage('castVote', (client, payload) => this.handleCastVote(client, payload));
  }

  onAuth(client, options, request) {
    const origin =
      request?.headers?.origin ||
      request?.headers?.get?.('origin') ||
      client?.request?.headers?.origin ||
      client?.request?.headers?.get?.('origin');
    if (!originIsAllowed(allowedOrigins, origin)) {
      throw new Error('origin_not_allowed');
    }

    const name = sanitizeText(options?.name || '');
    if (!name) throw new Error('invalid_name');

    const roomCode = sanitizeText(options?.roomCode || '').toUpperCase();
    if (!roomCode) throw new Error('invalid_room');

    return true;
  }

  onJoin(client, options) {
    const name = sanitizeText(options?.name || '').slice(0, 18);
    const token = sanitizeText(options?.token || '');

    // find existing by name
    let existingPlayerId = null;
    for (const [playerId, p] of this.state.players.entries()) {
      if (p && (p.name || '').toLowerCase() === name.toLowerCase()) {
        existingPlayerId = playerId;
        break;
      }
    }

    let playerId = existingPlayerId;
    if (playerId) {
      const priv = this.playerPrivate.get(playerId);
      if (!priv?.token || !token || priv.token !== token) {
        throw new Error('name_taken');
      }
    } else {
      playerId = generateToken(8);
      const priv = { token: generateToken(24), role: null, word: null };
      this.playerPrivate.set(playerId, priv);

      const ps = new PlayerState();
      ps.id = playerId;
      ps.name = name;
      ps.connected = true;
      ps.isAlive = true;
      ps.hasVoted = false;
      ps.isHost = false;
      this.state.players.set(playerId, ps);

      if (!this.state.hostPlayerId) {
        this.state.hostPlayerId = playerId;
      }
    }

    // Mark connected + host flags
    const me = this.state.players.get(playerId);
    if (!me) {
      throw new Error('player_missing');
    }
    me.connected = true;
    me.isHost = playerId === this.state.hostPlayerId;

    // Update host flags for others
    for (const [pid, p] of this.state.players.entries()) {
      p.isHost = pid === this.state.hostPlayerId;
    }

    this.playerIdBySessionId.set(client.sessionId, playerId);

    const priv = this.playerPrivate.get(playerId);
    client.send('me', { playerId, token: priv?.token || '' });

    // If round already started, re-send private word
    if (this.state.gameState !== 'lobby' && priv?.word) {
      client.send('word', { word: priv.word });
    }
  }

  async onLeave(client, consented) {
    const playerId = this.playerIdBySessionId.get(client.sessionId);
    if (!playerId) return;

    const me = this.state.players.get(playerId);
    if (me) me.connected = false;

    try {
      if (!consented) {
        const reconnected = await this.allowReconnection(client, 20);
        // sessionId changes on reconnection; remap
        this.playerIdBySessionId.delete(client.sessionId);
        this.playerIdBySessionId.set(reconnected.sessionId, playerId);
        const p = this.state.players.get(playerId);
        if (p) p.connected = true;
        return;
      }
    } catch {
      // fallthrough: treat as disconnected
    }

    // If lobby host left, reassign
    if (this.state.gameState === 'lobby' && this.state.hostPlayerId === playerId) {
      const nextHostId = Array.from(this.state.players.keys()).find((pid) => this.state.players.get(pid)?.connected);
      this.state.hostPlayerId = nextHostId || '';
      for (const [pid, p] of this.state.players.entries()) {
        p.isHost = pid === this.state.hostPlayerId;
      }
    }
  }

  getPlayerId(client) {
    return this.playerIdBySessionId.get(client.sessionId) || null;
  }

  clearTimers() {
    if (this.turnTimeout) clearTimeout(this.turnTimeout);
    if (this.votingTimeout) clearTimeout(this.votingTimeout);
    this.turnTimeout = null;
    this.votingTimeout = null;
  }

  connectedAlivePlayerIds() {
    return Array.from(this.state.players.entries())
      .filter(([, p]) => p.connected && p.isAlive)
      .map(([id]) => id);
  }

  startTurnTimer() {
    this.clearTimers();
    this.state.turnDeadlineMs = nowMs() + this.state.turnTotalSeconds * 1000;
    this.turnTimeout = setTimeout(() => {
      this.advanceTurn('(timeout)');
    }, this.state.turnTotalSeconds * 1000);
  }

  startVotingTimer() {
    this.clearTimers();
    this.state.votingDeadlineMs = nowMs() + this.state.votingTotalSeconds * 1000;
    this.votingTimeout = setTimeout(() => {
      this.finalizeVoting();
    }, this.state.votingTotalSeconds * 1000);
  }

  handleStartGame(client) {
    const playerId = this.getPlayerId(client);
    if (!playerId) return;
    if (this.state.hostPlayerId && this.state.hostPlayerId !== playerId) return;
    if (this.state.gameState !== 'lobby') return;

    const connectedIds = Array.from(this.state.players.entries())
      .filter(([, p]) => p.connected)
      .map(([id]) => id);
    if (connectedIds.length < 2) return;

    const result = startRound(connectedIds);
    if (!result.ok) return;

    // reset public state
    this.votesByTargetId = {};
    for (const [, p] of this.state.players.entries()) {
      p.isAlive = true;
      p.hasVoted = false;
    }

    // set private words/roles
    for (const id of connectedIds) {
      const priv = this.playerPrivate.get(id);
      if (priv) {
        priv.role = result.rolesById[id];
        priv.word = result.wordById[id];
      }
    }

    // Update public state
    this.state.gameOver = null;
    this.state.gameState = 'clue-giving';
    this.state.turnOrder.clear();
    for (const id of result.turnOrderIds) {
      const p = this.state.players.get(id);
      if (p) this.state.turnOrder.push(p.name);
    }
    const first = result.turnOrderIds[0];
    this.state.currentPlayer = this.state.players.get(first)?.name || '';

    this.state.clues.clear();
    this.startTurnTimer();

    // Send private word to each client
    for (const c of this.clients) {
      const pid = this.getPlayerId(c);
      const priv = pid ? this.playerPrivate.get(pid) : null;
      if (priv?.word) c.send('word', { word: priv.word });
    }
  }

  currentTurnPlayerId() {
    const currentName = this.state.currentPlayer;
    if (!currentName) return null;
    for (const [id, p] of this.state.players.entries()) {
      if (p && p.name === currentName) return id;
    }
    return null;
  }

  advanceTurn(autoClue = '') {
    if (this.state.gameState !== 'clue-giving') return;
    const currentId = this.currentTurnPlayerId();
    if (currentId && autoClue) {
      const c = new ClueState();
      c.sender = this.state.players.get(currentId)?.name || '';
      c.clue = sanitizeText(autoClue).slice(0, 32);
      this.state.clues.push(c);
    }

    const connectedIds = this.connectedAlivePlayerIds();
    if (connectedIds.length < 2) return;

    const orderNames = Array.from(this.state.turnOrder);
    const idx = orderNames.indexOf(this.state.currentPlayer);
    const nextIdx = idx + 1;
    if (nextIdx >= orderNames.length) {
      // voting
      this.state.gameState = 'voting';
      this.state.currentPlayer = '';
      this.startVotingTimer();
      return;
    }
    this.state.currentPlayer = orderNames[nextIdx] || '';
    this.startTurnTimer();
  }

  handleSubmitClue(client, payload) {
    if (this.state.gameState !== 'clue-giving') return;
    const playerId = this.getPlayerId(client);
    if (!playerId) return;
    const me = this.state.players.get(playerId);
    if (!me || !me.connected || !me.isAlive) return;
    if (me.name !== this.state.currentPlayer) return;

    const clueText = sanitizeText(payload?.clue ?? payload ?? '').slice(0, 32);
    if (!clueText) return;

    const c = new ClueState();
    c.sender = me.name;
    c.clue = clueText;
    this.state.clues.push(c);

    this.advanceTurn();
  }

  handleCastVote(client, payload) {
    if (this.state.gameState !== 'voting') return;
    const playerId = this.getPlayerId(client);
    if (!playerId) return;
    const me = this.state.players.get(playerId);
    if (!me || !me.connected || !me.isAlive || me.hasVoted) return;

    const targetId = sanitizeText(payload?.playerId ?? payload ?? '');
    const target = this.state.players.get(targetId);
    if (!target || !target.isAlive) return;

    me.hasVoted = true;
    this.votesByTargetId[targetId] = (this.votesByTargetId[targetId] || 0) + 1;

    const aliveConnected = this.connectedAlivePlayerIds().length;
    const voted = Array.from(this.state.players.values()).filter((p) => p.connected && p.isAlive && p.hasVoted).length;
    if (aliveConnected > 0 && voted >= aliveConnected) {
      this.finalizeVoting();
    }
  }

  finalizeVoting() {
    if (this.state.gameState !== 'voting') return;
    this.clearTimers();

    const { ejectedId } = tallyVotes(this.votesByTargetId);
    if (ejectedId && this.state.players.get(ejectedId)) {
      this.state.players.get(ejectedId).isAlive = false;
    }

    // Determine winner
    let imposterId = null;
    for (const [pid, priv] of this.playerPrivate.entries()) {
      if (priv?.role === 'imposter') {
        imposterId = pid;
        break;
      }
    }

    const imposterAlive = imposterId ? Boolean(this.state.players.get(imposterId)?.isAlive) : false;
    const aliveCrew = Array.from(this.state.players.entries()).filter(([pid, p]) => p.isAlive && this.playerPrivate.get(pid)?.role === 'crewmate').length;

    const over = new GameOverState();
    over.ejected = ejectedId ? this.state.players.get(ejectedId)?.name || '' : '';
    over.imposter = imposterId ? this.state.players.get(imposterId)?.name || '' : '';
    over.secretWord = (() => {
      const crewId = Array.from(this.playerPrivate.entries()).find(([, priv]) => priv?.role === 'crewmate')?.[0];
      const crewWord = crewId ? this.playerPrivate.get(crewId)?.word : '';
      return crewWord || '';
    })();

    if (!imposterAlive) {
      over.winner = 'Crewmates';
    } else if (aliveCrew <= 1) {
      over.winner = 'Imposter';
    } else {
      // If no clear winner, default to crewmates unless imposter survived with parity
      over.winner = 'Crewmates';
    }

    this.state.gameOver = over;
    this.state.gameState = 'game-over';
    this.state.turnDeadlineMs = 0;
    this.state.votingDeadlineMs = 0;

    setTimeout(() => this.resetToLobby(), 4500);
  }

  resetToLobby() {
    this.clearTimers();
    this.votesByTargetId = {};
    this.state.gameState = 'lobby';
    this.state.turnOrder.clear();
    this.state.currentPlayer = '';
    this.state.clues.clear();
    this.state.turnDeadlineMs = 0;
    this.state.votingDeadlineMs = 0;
    this.state.gameOver = null;
    for (const [, p] of this.state.players.entries()) {
      p.isAlive = true;
      p.hasVoted = false;
    }
    for (const priv of this.playerPrivate.values()) {
      if (priv) {
        priv.role = null;
        priv.word = null;
      }
    }
  }
}

module.exports = { ImposterRoom };
