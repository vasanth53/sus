function pickOne(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startRound(playerIds, { words, rng = Math.random } = {}) {
  if (!Array.isArray(playerIds) || playerIds.length < 2) {
    return { ok: false, error: 'need_two_players' };
  }
  const pool = Array.isArray(words) && words.length >= 2 ? words : ['Apple', 'Bicycle', 'Telescope', 'Guitar', 'Sunshine', 'Ocean'];
  const secretWord = pickOne(pool, rng);
  let decoyWord = pickOne(pool, rng);
  let guard = 0;
  while (decoyWord === secretWord && guard++ < 10) decoyWord = pickOne(pool, rng);

  const shuffled = shuffle(playerIds, rng);
  const imposterId = shuffled[Math.floor(rng() * shuffled.length)];

  const rolesById = {};
  const wordById = {};
  for (const id of playerIds) {
    const isImposter = id === imposterId;
    rolesById[id] = isImposter ? 'imposter' : 'crewmate';
    wordById[id] = isImposter ? decoyWord : secretWord;
  }

  return {
    ok: true,
    secretWord,
    decoyWord,
    imposterId,
    rolesById,
    wordById,
    turnOrderIds: shuffled,
  };
}

function tallyVotes(votesByTargetId) {
  const entries = Object.entries(votesByTargetId || {});
  if (entries.length === 0) return { ejectedId: null, counts: {} };
  let best = null;
  const counts = {};
  for (const [targetId, count] of entries) {
    const c = Number(count) || 0;
    counts[targetId] = c;
    if (!best || c > best.count) best = { targetId, count: c };
  }
  return { ejectedId: best?.targetId || null, counts };
}

module.exports = {
  startRound,
  tallyVotes,
};

