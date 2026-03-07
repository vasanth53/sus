import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css';

const DEFAULT_SOCKET_URL =
  typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : 'http://localhost:3001';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || DEFAULT_SOCKET_URL;

function App() {
  // General State
  const [socket, setSocket] = useState(null);
  const [name, setName] = useState('');
  const [hasJoined, setHasJoined] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // connecting, connected, disconnected, error
  
  // Lobby State
  const [lobbyPlayers, setLobbyPlayers] = useState([]);
  
  // Game State
  const [gameState, setGameState] = useState('lobby'); // lobby, clue-giving, voting, game-over
  const [word, setWord] = useState('');
  const [role, setRole] = useState('');
  const [turnOrder, setTurnOrder] = useState([]);
  const [currentPlayer, setCurrentPlayer] = useState('');
  const [clues, setClues] = useState([]);
  const [myClue, setMyClue] = useState('');
  const [votablePlayers, setVotablePlayers] = useState([]);
  const [hasVoted, setHasVoted] = useState(false);
  const [gameOverResult, setGameOverResult] = useState(null);
  const [turnSecondsRemaining, setTurnSecondsRemaining] = useState(null);
  const [votingSecondsRemaining, setVotingSecondsRemaining] = useState(null);
  const [lastToast, setLastToast] = useState(null);

  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    setSocket(newSocket);

    // --- General Listeners ---
    newSocket.on('connect', () => setConnectionStatus('connected'));
    newSocket.on('disconnect', () => setConnectionStatus('disconnected'));
    newSocket.on('connect_error', () => setConnectionStatus('error'));

    newSocket.on('updatePlayerList', (players) => setLobbyPlayers(players));
    newSocket.on('gameInProgress', () => alert("A game is already in progress. Please wait."));
    newSocket.on('gameReset', () => {
      setGameState('lobby');
      setWord('');
      setRole('');
      setTurnOrder([]);
      setCurrentPlayer('');
      setClues([]);
      setMyClue('');
      setVotablePlayers([]);
      setHasVoted(false);
      setGameOverResult(null);
      setTurnSecondsRemaining(null);
      setVotingSecondsRemaining(null);
      setLastToast({ type: 'info', message: 'Back to lobby. Ready for another round.' });
    });

    // --- Game Flow Listeners ---
    newSocket.on('roundStarted', (data) => {
      setGameState('clue-giving');
      setWord(data.word);
      setRole(data.role);
      setTurnOrder(data.turnOrder);
      setCurrentPlayer(data.currentPlayer);
      setClues([]);
      setHasVoted(false);
      setGameOverResult(null);
      setVotingSecondsRemaining(null);
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
      setHasVoted(false);
      setLastToast({ type: 'warning', message: 'Voting started. Choose wisely.' });
    });

    newSocket.on('turnTimer', (data) => {
      setTurnSecondsRemaining(data.secondsRemaining);
      if (data.currentPlayer) setCurrentPlayer(data.currentPlayer);
    });

    newSocket.on('votingTimer', (data) => {
      setVotingSecondsRemaining(data.secondsRemaining);
    });

    newSocket.on('gameOver', (result) => {
      setGameState('game-over');
      setGameOverResult(result);
      setTurnSecondsRemaining(null);
      setVotingSecondsRemaining(null);
      setLastToast({ type: 'info', message: 'Game over. Returning to lobby soon…' });
    });

    return () => newSocket.close();
  }, []);

  // --- Handlers ---
  const handleJoinGame = (e) => {
    e.preventDefault();
    if (name.trim() && socket) {
      socket.emit('joinGame', name);
      setHasJoined(true);
    }
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
  const roleLabel = role === 'imposter' ? 'Imposter' : role === 'crewmate' ? 'Crewmate' : '';
  const roleTone = role === 'imposter' ? 'danger' : role === 'crewmate' ? 'success' : 'neutral';

  const TimerBar = ({ label, seconds }) => {
    if (seconds === null || seconds === undefined) return null;
    const clamped = Math.max(0, Math.min(99, Number(seconds)));
    return (
      <div className="Timer">
        <div className="TimerRow">
          <span className="TimerLabel">{label}</span>
          <span className="TimerValue">{clamped}s</span>
        </div>
        <div className="TimerTrack" aria-hidden="true">
          <div className="TimerFill" style={{ width: `${(clamped / 30) * 100}%` }} />
        </div>
      </div>
    );
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
            <button className="Button Primary" type="submit" disabled={!name.trim() || !socket}>
              Join
            </button>
          </form>
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
              <p className="CardHint">Welcome, <span className="Strong">{name}</span>. Need at least 2 players to start.</p>
              <div className="PlayerList">
                {lobbyPlayers.map((p) => (
                  <div className="PlayerRow" key={p.id}>
                    <div className="Avatar" aria-hidden="true">{(p.name || '?')[0]?.toUpperCase()}</div>
                    <div className="PlayerName">{p.name}</div>
                  </div>
                ))}
              </div>
              <div className="Actions">
                <button className="Button Primary" onClick={handleStartGame} disabled={lobbyPlayers.length < 2 || !socket}>
                  Start round
                </button>
              </div>
            </div>

            <div className="Card Subtle">
              <h3 className="CardTitle Small">How to play</h3>
              <ul className="List">
                <li>Crewmates see the secret word.</li>
                <li>The imposter sees <span className="Code">???</span>.</li>
                <li>Give 1 clue each, then vote.</li>
              </ul>
            </div>
          </div>
        );

      case 'clue-giving':
        return (
          <div className="Grid">
            <div className="Card">
              <div className="Row Between">
                <h2 className="CardTitle">{isMyTurn ? "Your turn" : "Clue phase"}</h2>
                <span className={`Pill Pill${roleTone === 'danger' ? 'Danger' : roleTone === 'success' ? 'Ok' : 'Neutral'}`}>
                  {roleLabel || '—'}
                </span>
              </div>

              <div className="WordBox">
                <div className="WordLabel">Your word</div>
                <div className="WordValue">{word}</div>
              </div>

              <TimerBar label="Turn timer" seconds={turnSecondsRemaining} />

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
              <TimerBar label="Voting timer" seconds={votingSecondsRemaining} />
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
                    disabled={hasVoted || p.name === name}
                    title={p.name === name ? "You can’t vote for yourself" : `Vote ${p.name}`}
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
    <div className="App">
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
        {renderContent()}
      </main>
    </div>
  );
}

export default App;
