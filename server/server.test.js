const { startRound, tallyVotes } = require('./game');

describe('Imposter Game Server (game logic)', () => {
  test('startRound requires at least 2 players', () => {
    expect(startRound([]).ok).toBe(false);
    expect(startRound(['p1']).ok).toBe(false);
  });

  test('startRound assigns one imposter and a decoy word', () => {
    const res = startRound(['p1', 'p2', 'p3']);
    expect(res.ok).toBe(true);
    expect(Object.keys(res.rolesById).length).toBe(3);
    expect(Object.values(res.rolesById).filter((r) => r === 'imposter')).toHaveLength(1);
    expect(Object.values(res.rolesById).filter((r) => r === 'crewmate')).toHaveLength(2);

    const words = Object.values(res.wordById);
    const counts = words.reduce((acc, w) => acc.set(w, (acc.get(w) || 0) + 1), new Map());
    const sorted = Array.from(counts.values()).sort((a, b) => b - a);
    expect(sorted[0]).toBe(2);
    expect(sorted[1]).toBe(1);
  });

  test('tallyVotes picks the highest vote target', () => {
    const res = tallyVotes({ a: 1, b: 3, c: 2 });
    expect(res.ejectedId).toBe('b');
    expect(res.counts.b).toBe(3);
  });
});
