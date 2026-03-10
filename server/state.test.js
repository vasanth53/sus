const { RoomState, PlayerState, ClueState } = require('./state');

describe('schema state', () => {
  test('players map stores PlayerState instances', () => {
    const state = new RoomState();
    const p = new PlayerState();
    p.id = 'p1';
    p.name = 'Alice';
    state.players.set(p.id, p);

    const got = state.players.get('p1');
    expect(got).toBeTruthy();
    expect(got.name).toBe('Alice');
  });

  test('clues array stores ClueState entries', () => {
    const state = new RoomState();
    const c = new ClueState();
    c.sender = 'Alice';
    c.clue = 'test';
    state.clues.push(c);
    expect(state.clues.length).toBe(1);
    expect(state.clues[0].sender).toBe('Alice');
  });
});

