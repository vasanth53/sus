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

  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    setSocket(newSocket);

    // --- General Listeners ---
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
    });

    newSocket.on('newClue', (clue) => {
      setClues(prevClues => [...prevClues, clue]);
    });

    newSocket.on('nextTurn', (data) => {
      setCurrentPlayer(data.currentPlayer);
    });

    newSocket.on('votingStarted', (data) => {
      setGameState('voting');
      setClues(data.clues);
      setVotablePlayers(data.players);
    });

    newSocket.on('gameOver', (result) => {
      setGameState('game-over');
      setGameOverResult(result);
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
    }
  };

  // --- Render Logic ---
  const renderContent = () => {
    if (!hasJoined) {
      return (
        <form onSubmit={handleJoinGame}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter your name" />
          <button type="submit">Join Game</button>
        </form>
      );
    }

    switch (gameState) {
      case 'lobby':
        return (
          <div>
            <h2>Welcome, {name}!</h2>
            <h3>Players in Lobby ({lobbyPlayers.length}):</h3>
            <ul>
              {lobbyPlayers.map((p) => <li key={p.id}>{p.name}</li>)}
            </ul>
            <button onClick={handleStartGame} disabled={lobbyPlayers.length < 2}>
              Start Game (Need at least 2 players)
            </button>
          </div>
        );

      case 'clue-giving':
        const isMyTurn = name === currentPlayer;
        return (
          <div>
            <h2>{isMyTurn ? "It's your turn!" : `Waiting for ${currentPlayer}...`}</h2>
            <h3>Your Word: <strong>{word}</strong> ({role})</h3>
            <div style={{ display: 'flex', justifyContent: 'space-around', width: '100%' }}>
              <div>
                <h4>Turn Order:</h4>
                <ol>{turnOrder.map((p, i) => <li key={i} style={{ fontWeight: p === currentPlayer ? 'bold' : 'normal' }}>{p}</li>)}</ol>
              </div>
              <div>
                <h4>Clues Given:</h4>
                <ul>{clues.map((c, i) => <li key={i}><strong>{c.sender}:</strong> {c.clue}</li>)}</ul>
              </div>
            </div>
            <form onSubmit={handleSubmitClue}>
              <input type="text" value={myClue} onChange={(e) => setMyClue(e.target.value)} placeholder="Enter your clue" disabled={!isMyTurn} />
              <button type="submit" disabled={!isMyTurn}>Submit Clue</button>
            </form>
          </div>
        );

      case 'voting':
        return (
          <div>
            <h2>Voting Time!</h2>
            <p>Review the clues and vote for the imposter.</p>
            <ul>{clues.map((c, i) => <li key={i}><strong>{c.sender}:</strong> {c.clue}</li>)}</ul>
            <h4>Players to vote for:</h4>
            {votablePlayers.map(p => (
              <button key={p.id} onClick={() => handleVote(p.id)} disabled={hasVoted || p.name === name}>
                Vote {p.name}
              </button>
            ))}
            {hasVoted && <p>You have voted! Waiting for other players...</p>}
          </div>
        );
        
      case 'game-over':
        if (!gameOverResult) return <p>Game over. Loading results...</p>;
        return (
            <div>
                <h2>Game Over!</h2>
                <h3>Winner: {gameOverResult.winner}</h3>
                {gameOverResult.ejected && <p>{gameOverResult.ejected} was ejected.</p>}
                {gameOverResult.imposter && <p>The imposter was: <strong>{gameOverResult.imposter}</strong></p>}
                <p>The secret word was: <strong>{gameOverResult.secretWord}</strong></p>
                <p>Returning to lobby shortly...</p>
            </div>
        );

      default:
        return <p>Loading...</p>;
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Imposter Word Game</h1>
        {renderContent()}
      </header>
    </div>
  );
}

export default App;
