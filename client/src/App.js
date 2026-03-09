import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css';

const DEFAULT_SOCKET_URL =
  typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : 'http://localhost:3001';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || DEFAULT_SOCKET_URL;
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const AMONG_US_ASSETS = {
  stars: `${PUBLIC_URL}/among-us/stars.png`,
  parallax1: `${PUBLIC_URL}/among-us/parallax1.png`,
  parallax2: `${PUBLIC_URL}/among-us/parallax2.png`,
  parallax3: `${PUBLIC_URL}/among-us/parallax3.png`,
  shhhhh: `${PUBLIC_URL}/among-us/shhhhh.png`,
  discuss: `${PUBLIC_URL}/among-us/discuss.png`,
};

function App() {
  // General State
  const [socket, setSocket] = useState(null);
  const [myPlayerId, setMyPlayerId] = useState(null);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [playerToken, setPlayerToken] = useState('');
  const [hasJoined, setHasJoined] = useState(false);
  const [joinPending, setJoinPending] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // connecting, connected, disconnected, error
  
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
  const [turnSecondsRemaining, setTurnSecondsRemaining] = useState(null);
  const [votingSecondsRemaining, setVotingSecondsRemaining] = useState(null);
  const [turnDeadlineMs, setTurnDeadlineMs] = useState(null);
  const [votingDeadlineMs, setVotingDeadlineMs] = useState(null);
  const [turnTotalSeconds, setTurnTotalSeconds] = useState(30);
  const [votingTotalSeconds, setVotingTotalSeconds] = useState(25);
  const [clockMs, setClockMs] = useState(Date.now());
  const [lastToast, setLastToast] = useState(null);

  useEffect(() => {
    const savedName = localStorage.getItem('imposter.name') || '';
    const savedToken = localStorage.getItem('imposter.token') || '';
    if (savedName) setName(savedName);
    if (savedToken) setPlayerToken(savedToken);
  }, []);

  useEffect(() => {
    const hasActiveTimer = Boolean(turnDeadlineMs || votingDeadlineMs);
    if (!hasActiveTimer) return;
    const id = setInterval(() => setClockMs(Date.now()), 80);
    return () => clearInterval(id);
  }, [turnDeadlineMs, votingDeadlineMs]);

  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    setSocket(newSocket);

    // --- General Listeners ---
    newSocket.on('connect', () => {
      setConnectionStatus('connected');
    });
    newSocket.on('disconnect', () => setConnectionStatus('disconnected'));
    newSocket.on('connect_error', () => setConnectionStatus('error'));

    newSocket.on('updatePlayerList', (players) => setLobbyPlayers(players));
    newSocket.on('gameInProgress', () => alert("A game is already in progress. Please wait."));
    newSocket.on('authError', () => setLastToast({ type: 'warning', message: 'Wrong PIN. Try again.' }));
    newSocket.on('nameTaken', () => setLastToast({ type: 'warning', message: 'That name is already taken.' }));
    newSocket.on('lobbyFull', () => setLastToast({ type: 'warning', message: 'Lobby is full.' }));
    newSocket.on('joinError', (data) => setLastToast({ type: 'warning', message: `Join failed: ${data?.error || 'unknown'}` }));
    newSocket.on('gameReset', () => {
      setGameState('lobby');
      setWord('');
      setTurnOrder([]);
      setCurrentPlayer('');
      setClues([]);
      setMyClue('');
      setVotablePlayers([]);
      setHasVoted(false);
      setGameOverResult(null);
      setTurnSecondsRemaining(null);
      setVotingSecondsRemaining(null);
      setTurnDeadlineMs(null);
      setVotingDeadlineMs(null);
      setLastToast({ type: 'info', message: 'Back to lobby. Ready for another round.' });
    });

    // --- Game Flow Listeners ---
    newSocket.on('roundStarted', (data) => {
      setGameState('clue-giving');
      setWord(data.word);
      setTurnOrder(data.turnOrder);
      setCurrentPlayer(data.currentPlayer);
      setClues([]);
      setHasVoted(false);
      setGameOverResult(null);
      setVotingSecondsRemaining(null);
      setVotingDeadlineMs(null);
      setLastToast({ type: 'success', message: 'Round started. Give a clue on your turn.' });
    });

    newSocket.on('newClue', (clue) => {
      setClues(prevClues => [...prevClues, clue]);
    });

    newSocket.on('nextTurn', (data) => {
      setCurrentPlayer(data.currentPlayer);
      setLastToast({ type: 'info', message: `Next turn: ${data.currentPlayer}` });
    });

    newSocket.on('votingStarted', (data) => {
      setGameState('voting');
      setClues(data.clues);
      setVotablePlayers(data.players);
      setTurnSecondsRemaining(null);
      setTurnDeadlineMs(null);
      setHasVoted(false);
      setLastToast({ type: 'warning', message: 'Voting started. Choose wisely.' });
    });

    newSocket.on('turnTimer', (data) => {
      setTurnSecondsRemaining(data.secondsRemaining);
      if (data.currentPlayer) setCurrentPlayer(data.currentPlayer);
      if (data.deadlineMs) setTurnDeadlineMs(data.deadlineMs);
      if (data.totalSeconds) setTurnTotalSeconds(data.totalSeconds);
    });

    newSocket.on('votingTimer', (data) => {
      setVotingSecondsRemaining(data.secondsRemaining);
      if (data.deadlineMs) setVotingDeadlineMs(data.deadlineMs);
      if (data.totalSeconds) setVotingTotalSeconds(data.totalSeconds);
    });

    newSocket.on('stateSync', (data) => {
      if (!data) return;
      setHasJoined(true);
      setGameState(data.gameState || 'lobby');
      setLobbyPlayers(data.lobbyPlayers || []);
      setTurnOrder(data.turnOrder || []);
      setCurrentPlayer(data.currentPlayer || '');
      setClues(data.clues || []);
      setVotablePlayers(data.votablePlayers || []);
      setTurnSecondsRemaining(data.turnSecondsRemaining ?? null);
      setVotingSecondsRemaining(data.votingSecondsRemaining ?? null);
      setTurnDeadlineMs(data.turnDeadlineMs ?? null);
      setVotingDeadlineMs(data.votingDeadlineMs ?? null);
      setTurnTotalSeconds(data.turnTotalSeconds ?? 30);
      setVotingTotalSeconds(data.votingTotalSeconds ?? 25);

      if (data.me) {
        setMyPlayerId(data.me.id || null);
        setName(data.me.name || '');
        setWord(data.me.word || '');
        setHasVoted(Boolean(data.me.hasVoted));
      }
    });

    newSocket.on('gameOver', (result) => {
      setGameState('game-over');
      setGameOverResult(result);
      setTurnSecondsRemaining(null);
      setVotingSecondsRemaining(null);
      setTurnDeadlineMs(null);
      setVotingDeadlineMs(null);
      setLastToast({ type: 'info', message: 'Game over. Returning to lobby soon…' });
    });

    return () => newSocket.close();
  }, []);

  // --- Handlers ---
  const handleJoinGame = (e) => {
    e.preventDefault();
    if (!socket || !name.trim() || !pin.trim() || joinPending) return;

    setJoinPending(true);
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      setJoinPending(false);
      setLastToast({ type: 'warning', message: 'Join timed out. Is the server running?' });
    }, 1200);

    const nextName = name.trim();
    const storedName = (localStorage.getItem('imposter.name') || '').trim();
    const storedToken = (localStorage.getItem('imposter.token') || '').trim();
    const tokenCandidate = (playerToken || storedToken).trim();
    const shouldSendToken = tokenCandidate && storedName.toLowerCase() === nextName.toLowerCase();

    socket.emit(
      'joinGame',
      { name: nextName, pin: pin.trim(), token: shouldSendToken ? tokenCandidate : '' },
      (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      setJoinPending(false);
      if (res?.ok) {
        setHasJoined(true);
        if (res?.playerId) setMyPlayerId(res.playerId);
        if (res?.token) {
          setPlayerToken(res.token);
          localStorage.setItem('imposter.token', res.token);
        }
        localStorage.setItem('imposter.name', nextName);
        setLastToast({ type: 'success', message: res?.isHost ? 'Joined as host.' : 'Joined the lobby.' });
      } else {
        setLastToast({ type: 'warning', message: `Join failed: ${res?.error || 'unknown'}` });
      }
      },
    );
  };

  const handleStartGame = () => socket && socket.emit('startGame');

  const handleSubmitClue = (e) => {
    e.preventDefault();
    if (myClue.trim() && socket) {
      socket.emit('submitClue', myClue);
      setMyClue('');
    }
  };

  const handleVote = (playerId) => {
    if (socket && !hasVoted) {
      socket.emit('castVote', playerId);
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
          <h2 className="CardTitle">Join the lobby</h2>
          <p className="CardHint">Pick a name and wait for at least one other player.</p>
          <form onSubmit={handleJoinGame} className="FormRow">
            <input
              className="Input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              maxLength={18}
              autoComplete="nickname"
            />
            <button
              className="Button Primary"
              type="submit"
              disabled={!name.trim() || !pin.trim() || !socket || joinPending || connectionStatus !== 'connected'}
            >
              {joinPending ? 'Joining…' : 'Join'}
            </button>
          </form>
          <div className="FormRow" style={{ marginTop: 10 }}>
            <input
              className="Input"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Game PIN (required)"
              autoComplete="off"
            />
          </div>
          <div className="MetaRow">
            <span className={`Pill ${connectionStatus === 'connected' ? 'PillOk' : 'PillWarn'}`}>
              {connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting…' : 'Offline'}
            </span>
            <span className="MetaText">Server: {SOCKET_URL}</span>
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
                <button className="Button Primary" onClick={handleStartGame} disabled={lobbyPlayers.length < 2 || !socket || !isHost}>
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
                seconds={turnSecondsRemaining}
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
                seconds={votingSecondsRemaining}
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
              {gameState.toUpperCase()} • {isHost ? 'HOST' : 'PLAYER'} • {name}
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
