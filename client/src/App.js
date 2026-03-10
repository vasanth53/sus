import React, { useState, useEffect, useRef } from 'react';
import * as Colyseus from 'colyseus.js';
import './App.css';

function getDefaultSocketUrl() {
  if (typeof window === 'undefined') return 'http://localhost:3001';
  const { protocol, hostname, host } = window.location;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
  return isLocal ? `${protocol}//${hostname}:3001` : `${protocol}//${host}`;
}

// Reuse existing env var name for deployment convenience.
// It should point to the backend HTTP origin (e.g. https://xxxx.onrender.com).
const SERVER_URL = process.env.REACT_APP_SOCKET_URL || getDefaultSocketUrl();
const COLYSEUS_URL = SERVER_URL.replace(/^http/i, 'ws');
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const AMONG_US_ASSETS = {
  stars: `${PUBLIC_URL}/among-us/stars.png`,
  parallax1: `${PUBLIC_URL}/among-us/parallax1.png`,
  parallax2: `${PUBLIC_URL}/among-us/parallax2.png`,
  parallax3: `${PUBLIC_URL}/among-us/parallax3.png`,
  shhhhh: `${PUBLIC_URL}/among-us/shhhhh.png`,
  discuss: `${PUBLIC_URL}/among-us/discuss.png`,
};

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function getInitialTheme() {
  if (typeof window === 'undefined') return 'light';
  const saved = (localStorage.getItem('imposter.theme') || '').trim().toLowerCase();
  if (saved === 'dark' || saved === 'light') return saved;
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function App() {
  // General State
  const [colyseusClient, setColyseusClient] = useState(null);
  const [room, setRoom] = useState(null);
  const [myPlayerId, setMyPlayerId] = useState(null);
  const [name, setName] = useState('');
  const [playerToken, setPlayerToken] = useState('');
  const [hasJoined, setHasJoined] = useState(false);
  const [joinPending, setJoinPending] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('idle'); // idle, connected, disconnected, error
  const [roomCode, setRoomCode] = useState('');
  const [currentRoomId, setCurrentRoomId] = useState('public');
  
  // Lobby State
  const [lobbyPlayers, setLobbyPlayers] = useState([]);
  
  // Game State
  const [gameState, setGameState] = useState('lobby'); // lobby, clue-giving, voting, game-over
  const [word, setWord] = useState('');
  const [turnOrder, setTurnOrder] = useState([]);
  const [currentPlayer, setCurrentPlayer] = useState('');
  const [clues, setClues] = useState([]);
  const [myClue, setMyClue] = useState('');
  const [votablePlayers, setVotablePlayers] = useState([]);
  const [hasVoted, setHasVoted] = useState(false);
  const [gameOverResult, setGameOverResult] = useState(null);
  const [turnDeadlineMs, setTurnDeadlineMs] = useState(null);
  const [votingDeadlineMs, setVotingDeadlineMs] = useState(null);
  const [turnTotalSeconds, setTurnTotalSeconds] = useState(30);
  const [votingTotalSeconds, setVotingTotalSeconds] = useState(25);
  const [clockMs, setClockMs] = useState(Date.now());
  const [lastToast, setLastToast] = useState(null);
  const [theme, setTheme] = useState(getInitialTheme);

  const identityRef = useRef({ hasJoined: false, playerId: null, token: '', roomId: 'public' });
  const roomRef = useRef(null);
  useEffect(() => {
    identityRef.current = {
      hasJoined: Boolean(hasJoined),
      playerId: myPlayerId,
      token: (playerToken || localStorage.getItem('imposter.token') || '').trim(),
      roomId: currentRoomId,
    };
  }, [hasJoined, myPlayerId, playerToken, currentRoomId]);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    const savedName = localStorage.getItem('imposter.name') || '';
    const savedToken = localStorage.getItem('imposter.token') || '';
    if (savedName) setName(savedName);
    if (savedToken) setPlayerToken(savedToken);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('imposter.theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    const hasActiveTimer = Boolean(turnDeadlineMs || votingDeadlineMs);
    if (!hasActiveTimer) return;
    const id = setInterval(() => setClockMs(Date.now()), 80);
    return () => clearInterval(id);
  }, [turnDeadlineMs, votingDeadlineMs]);

  useEffect(() => {
    const c = new Colyseus.Client(COLYSEUS_URL);
    setColyseusClient(c);
    setConnectionStatus('connected');
    return () => {
      try {
        roomRef.current?.leave?.();
      } catch {
        // ignore
      }
    };
  }, []);

  // --- Handlers ---
  const joinPayloadBase = () => {
    const nextName = name.trim();
    const storedName = (localStorage.getItem('imposter.name') || '').trim();
    const storedToken = (localStorage.getItem('imposter.token') || '').trim();
    const tokenCandidate = (playerToken || storedToken).trim();
    const shouldSendToken = tokenCandidate && storedName.toLowerCase() === nextName.toLowerCase();
    return { name: nextName, token: shouldSendToken ? tokenCandidate : '' };
  };

  const copyRoomCode = async (code) => {
    const value = String(code || '').trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setLastToast({ type: 'success', message: 'Room code copied.' });
    } catch {
      setLastToast({ type: 'info', message: `Room code: ${value}` });
    }
  };

  const joinRoom = async (code, { toastPrefix = 'Joined room', createIfMissing = false } = {}) => {
    const normalized = String(code || '').trim().toUpperCase();
    if (!colyseusClient || !name.trim() || !normalized || joinPending) return;
    setJoinPending(true);
    try {
      const nextRoom = createIfMissing
        ? await colyseusClient.joinOrCreate('imposter', { ...joinPayloadBase(), roomCode: normalized })
        : await colyseusClient.join('imposter', { ...joinPayloadBase(), roomCode: normalized });

      if (room) {
        try { room.leave(); } catch {}
      }

      setRoom(nextRoom);
      setHasJoined(true);
      setCurrentRoomId(normalized);
      localStorage.setItem('imposter.name', name.trim());
      setLastToast({ type: 'success', message: `${toastPrefix} ${normalized}` });

      nextRoom.onMessage('me', (payload) => {
        const pid = payload?.playerId || null;
        const token = payload?.token || '';
        if (pid) setMyPlayerId(pid);
        if (token) {
          setPlayerToken(token);
          localStorage.setItem('imposter.token', token);
        }
      });

      nextRoom.onMessage('word', (payload) => {
        if (payload?.word) setWord(payload.word);
      });

      nextRoom.onStateChange((state) => {
        if (!state) return;
        setGameState(state.gameState || 'lobby');
        setTurnOrder(Array.from(state.turnOrder || []));
        setCurrentPlayer(state.currentPlayer || '');
        setClues(Array.from(state.clues || []).map((c) => ({ sender: c.sender, clue: c.clue })));
        setTurnDeadlineMs(state.turnDeadlineMs ? Number(state.turnDeadlineMs) : null);
        setVotingDeadlineMs(state.votingDeadlineMs ? Number(state.votingDeadlineMs) : null);
        setTurnTotalSeconds(Number(state.turnTotalSeconds || 30));
        setVotingTotalSeconds(Number(state.votingTotalSeconds || 25));

        const players = [];
        try {
          state.players?.forEach?.((p, id) => {
            players.push({
              id,
              name: p.name,
              isAlive: Boolean(p.isAlive),
              connected: Boolean(p.connected),
              isHost: Boolean(p.isHost),
            });
          });
        } catch {
          // ignore
        }
        setLobbyPlayers(players);
        setVotablePlayers(players.filter((p) => p.isAlive).map((p) => ({ id: p.id, name: p.name })));

        const me = identityRef.current.playerId ? players.find((p) => p.id === identityRef.current.playerId) : null;
        if (me) setHasVoted(Boolean(state.players?.get?.(me.id)?.hasVoted));

        if (state.gameOver) {
          setGameOverResult({
            winner: state.gameOver.winner,
            ejected: state.gameOver.ejected,
            imposter: state.gameOver.imposter,
            secretWord: state.gameOver.secretWord,
          });
        } else {
          setGameOverResult(null);
        }

        if (state.gameState === 'lobby') {
          setWord('');
          setClues([]);
          setMyClue('');
          setHasVoted(false);
          setTurnDeadlineMs(null);
          setVotingDeadlineMs(null);
        }
      });
    } catch (err) {
      setLastToast({ type: 'warning', message: `Join failed: ${err?.message || 'unknown'}` });
    } finally {
      setJoinPending(false);
    }
  };

  const createRoomAndJoin = () => {
    if (!name.trim() || joinPending) return;
    const code = generateRoomCode();
    setRoomCode(code);
    joinRoom(code, { toastPrefix: 'Created room', createIfMissing: true });
    copyRoomCode(code);
  };

  const handleJoinGame = (e) => {
    e.preventDefault();
    const code = roomCode.trim();
    if (!code) return setLastToast({ type: 'warning', message: 'Enter a room code.' });
    return joinRoom(code, { toastPrefix: 'Joined room' });
  };

  const handleStartGame = () => room && room.send('startGame');

  const handleSubmitClue = (e) => {
    e.preventDefault();
    if (myClue.trim() && room) {
      room.send('submitClue', { clue: myClue });
      setMyClue('');
    }
  };

  const handleVote = (playerId) => {
    if (room && !hasVoted) {
      room.send('castVote', { playerId });
      setHasVoted(true);
      setLastToast({ type: 'success', message: 'Vote submitted.' });
    }
  };

  const isMyTurn = gameState === 'clue-giving' && name === currentPlayer;
  const isHost =
    hasJoined &&
    (lobbyPlayers.find((p) => p.id === myPlayerId)?.isHost || lobbyPlayers.find((p) => p.name === name)?.isHost);

  const TimerBar = ({ label, seconds, deadlineMs, totalSeconds }) => {
    if (seconds === null || seconds === undefined) return null;
    const clamped = Math.max(0, Math.min(99, Number(seconds)));
    const total = Math.max(1, Number(totalSeconds || 30));
    const remainingMs = deadlineMs ? Math.max(0, deadlineMs - clockMs) : clamped * 1000;
    const fill = Math.max(0, Math.min(1, remainingMs / (total * 1000)));
    return (
      <div className="Timer">
        <div className="TimerRow">
          <span className="TimerLabel">{label}</span>
          <span className="TimerValue">{clamped}s</span>
        </div>
        <div className="TimerTrack" aria-hidden="true">
          <div className="TimerFill" style={{ '--fill': fill }} />
        </div>
      </div>
    );
  };

  const PhaseBanner = () => {
    if (gameState === 'clue-giving') {
      return <img className="PhaseBanner" src={AMONG_US_ASSETS.shhhhh} alt="" aria-hidden="true" />;
    }
    if (gameState === 'voting') {
      return <img className="PhaseBanner" src={AMONG_US_ASSETS.discuss} alt="" aria-hidden="true" />;
    }
    return null;
  };

  // --- Render Logic ---
  const renderContent = () => {
    if (!hasJoined) {
      return (
        <div className="Card">
          <h2 className="CardTitle">Join</h2>
          <p className="CardHint">Type your name, then join with a room code.</p>
          <form onSubmit={handleJoinGame} className="FormRow">
            <input
              className="Input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              maxLength={18}
              autoComplete="nickname"
            />
            <button
              className="Button Primary"
              type="submit"
              disabled={
                !name.trim() ||
                !roomCode.trim() ||
                !colyseusClient ||
                joinPending ||
                connectionStatus !== 'connected'
              }
            >
              {joinPending ? 'Working…' : 'Join'}
            </button>
          </form>
          <div className="FormRow" style={{ marginTop: 10 }}>
            <input
              className="Input"
              type="text"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              placeholder="Room code"
              autoComplete="off"
            />
            <button type="button" className="Button" onClick={() => copyRoomCode(roomCode)} disabled={!roomCode.trim()}>
              Copy
            </button>
          </div>
          <div className="Actions" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="Button"
              onClick={createRoomAndJoin}
              disabled={!name.trim() || !colyseusClient || joinPending || connectionStatus !== 'connected'}
              title="Create a new room and copy the code"
            >
              Create room
            </button>
          </div>
          <div className="MetaRow">
            <span className={`Pill ${connectionStatus === 'connected' ? 'PillOk' : 'PillWarn'}`}>
              {connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting…' : 'Offline'}
            </span>
            <span className="MetaText">Server: {SERVER_URL}</span>
          </div>
        </div>
      );
    }

    switch (gameState) {
      case 'lobby':
        return (
          <div className="Grid">
            <div className="Card">
              <h2 className="CardTitle">Lobby</h2>
              <p className="CardHint">
                Welcome, <span className="Strong">{name}</span>. {isHost ? 'You are the host.' : 'Waiting for host to start.'}
              </p>
              <div className="PlayerList">
                {lobbyPlayers.map((p) => (
                  <div className="PlayerRow" key={p.id}>
                    <div className="Avatar" aria-hidden="true">{(p.name || '?')[0]?.toUpperCase()}</div>
                    <div className="PlayerName">{p.name}{p.id === myPlayerId ? ' (you)' : ''}</div>
                    {p.isHost && <span className="Pill PillNeutral">HOST</span>}
                  </div>
                ))}
              </div>
              <div className="Actions">
                <button className="Button Primary" onClick={handleStartGame} disabled={lobbyPlayers.length < 2 || !room || !isHost}>
                  Start round
                </button>
              </div>
            </div>
          </div>
        );

      case 'clue-giving':
        return (
          <div className="Grid">
            <div className="Card">
              <div className="Row Between">
                <h2 className="CardTitle">{isMyTurn ? "Your turn" : "Clue phase"}</h2>
                <span className={`Pill ${isMyTurn ? 'PillOk' : 'PillNeutral'}`}>{isMyTurn ? 'INPUT' : 'WAIT'}</span>
              </div>

              <PhaseBanner />

              <div className="WordBox">
                <div className="WordLabel">Your word</div>
                <div className="WordValue">{word}</div>
              </div>

              <TimerBar
                label="Turn timer"
                seconds={turnDeadlineMs ? Math.max(0, Math.ceil((turnDeadlineMs - clockMs) / 1000)) : null}
                deadlineMs={turnDeadlineMs}
                totalSeconds={turnTotalSeconds}
              />

              <p className="CardHint">
                {isMyTurn ? "Give a clue that fits the word (but don’t be obvious)." : `Waiting for ${currentPlayer}…`}
              </p>

              <form onSubmit={handleSubmitClue} className="FormRow">
                <input
                  className="Input"
                  type="text"
                  value={myClue}
                  onChange={(e) => setMyClue(e.target.value)}
                  placeholder={isMyTurn ? "Type your clue…" : "Not your turn"}
                  disabled={!isMyTurn}
                  maxLength={32}
                />
                <button className="Button Primary" type="submit" disabled={!isMyTurn || !myClue.trim()}>
                  Send
                </button>
              </form>
            </div>

            <div className="Card Subtle">
              <h3 className="CardTitle Small">Turn order</h3>
              <ol className="List Ordered">
                {turnOrder.map((p, i) => (
                  <li key={i} className={p === currentPlayer ? 'Active' : undefined}>
                    {p}{p === name ? ' (you)' : ''}
                  </li>
                ))}
              </ol>
            </div>

            <div className="Card Subtle">
              <h3 className="CardTitle Small">Clues</h3>
              <div className="ClueList">
                {clues.length === 0 ? (
                  <div className="Empty">No clues yet.</div>
                ) : (
                  clues.map((c, i) => (
                    <div className="ClueRow" key={i}>
                      <span className="ClueSender">{c.sender}</span>
                      <span className="ClueText">{c.clue}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        );

      case 'voting':
        return (
          <div className="Grid">
            <div className="Card">
              <div className="Row Between">
                <h2 className="CardTitle">Voting</h2>
                <span className="Pill PillWarn">Choose</span>
              </div>
              <PhaseBanner />
              <TimerBar
                label="Voting timer"
                seconds={votingDeadlineMs ? Math.max(0, Math.ceil((votingDeadlineMs - clockMs) / 1000)) : null}
                deadlineMs={votingDeadlineMs}
                totalSeconds={votingTotalSeconds}
              />
              <p className="CardHint">Review the clues and vote for the imposter.</p>
              <div className="ClueList">
                {clues.map((c, i) => (
                  <div className="ClueRow" key={i}>
                    <span className="ClueSender">{c.sender}</span>
                    <span className="ClueText">{c.clue}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="Card Subtle">
              <h3 className="CardTitle Small">Players</h3>
              <div className="VoteGrid">
                {votablePlayers.map((p) => (
                  <button
                    className="Button"
                    key={p.id}
                    onClick={() => handleVote(p.id)}
                    disabled={hasVoted || p.id === myPlayerId}
                    title={p.id === myPlayerId ? "You can’t vote for yourself" : `Vote ${p.name}`}
                  >
                    Vote {p.name}
                  </button>
                ))}
              </div>
              {hasVoted && <div className="Notice">Vote locked in. Waiting for others…</div>}
            </div>
          </div>
        );
        
      case 'game-over':
        if (!gameOverResult) return <p>Game over. Loading results...</p>;
        return (
            <div className="Card">
              <h2 className="CardTitle">Game over</h2>
              <div className="ResultRow">
                <div className="ResultLabel">Winner</div>
                <div className="ResultValue">{gameOverResult.winner}</div>
              </div>
              {gameOverResult.ejected && (
                <div className="ResultRow">
                  <div className="ResultLabel">Ejected</div>
                  <div className="ResultValue">{gameOverResult.ejected}</div>
                </div>
              )}
              {gameOverResult.imposter && (
                <div className="ResultRow">
                  <div className="ResultLabel">Imposter</div>
                  <div className="ResultValue">{gameOverResult.imposter}</div>
                </div>
              )}
              <div className="ResultRow">
                <div className="ResultLabel">Secret word</div>
                <div className="ResultValue">{gameOverResult.secretWord}</div>
              </div>
              <p className="CardHint">Returning to lobby shortly…</p>
            </div>
        );

      default:
        return <p>Loading...</p>;
    }
  };

  return (
    <div
      className="App"
      style={{
        '--au-stars': `url(${AMONG_US_ASSETS.stars})`,
        '--au-parallax1': `url(${AMONG_US_ASSETS.parallax1})`,
        '--au-parallax2': `url(${AMONG_US_ASSETS.parallax2})`,
        '--au-parallax3': `url(${AMONG_US_ASSETS.parallax3})`,
      }}
    >
      <div className="SpaceView" aria-hidden="true" />
      <div className="CabinVignette" aria-hidden="true" />
      <div className="TopBar">
        <div className="Brand">
          <div className="LogoDot" aria-hidden="true" />
          <div>
            <div className="BrandTitle">Imposter Word Game</div>
            <div className="BrandSubtitle">quick rounds • tiny chaos</div>
          </div>
        </div>
        <div className="TopBarRight">
          <button
            type="button"
            className="Button ThemeToggle"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            aria-pressed={theme === 'dark'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          {hasJoined && <span className="Pill PillNeutral">You: {name}</span>}
          {gameState !== 'lobby' && gameState !== 'game-over' && (
            <span className={`Pill ${isMyTurn ? 'PillOk' : 'PillNeutral'}`}>{isMyTurn ? 'Your turn' : 'Waiting'}</span>
          )}
        </div>
      </div>

      {lastToast?.message && <div className={`Toast ${lastToast.type || 'info'}`}>{lastToast.message}</div>}

      <main className="Main">
        <div className="MonitorFrame">
          <div className="MonitorBezel" aria-hidden="true" />
          <div className="MonitorScreen">
            {renderContent()}
          </div>
          <div className="ConsoleStrip" aria-hidden="true">
            <div className="ConsoleLights">
              <span className={`Light ${connectionStatus === 'connected' ? 'Ok' : 'Warn'}`} />
              <span className={`Light ${gameState === 'clue-giving' ? 'Ok' : 'Neutral'}`} />
              <span className={`Light ${gameState === 'voting' ? 'Warn' : 'Neutral'}`} />
              <span className={`Light ${gameState === 'game-over' ? 'Danger' : 'Neutral'}`} />
            </div>
            <div className="ConsoleText">
              {currentRoomId} • {gameState.toUpperCase()} • {isHost ? 'HOST' : 'PLAYER'} • {name}
            </div>
            <div className="ConsoleButtons">
              <span className="ConsoleBtn" />
              <span className="ConsoleBtn" />
              <span className="ConsoleBtn" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
