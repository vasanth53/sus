const { originIsAllowed, parseCorsOrigin } = require('./util');

describe('CORS origin allowlist', () => {
  test('allows any origin when CLIENT_ORIGIN is unset', () => {
    expect(originIsAllowed(parseCorsOrigin(''), 'https://example.com')).toBe(true);
    expect(originIsAllowed(parseCorsOrigin(null), 'https://example.com')).toBe(true);
  });

  test('matches exact origin ignoring trailing slash + case', () => {
    const allowed = parseCorsOrigin('https://imposter-word-game-vasanth.netlify.app/');
    expect(originIsAllowed(allowed, 'https://imposter-word-game-vasanth.netlify.app')).toBe(true);
    expect(originIsAllowed(allowed, 'https://IMPOSTER-WORD-GAME-VASANTH.NETLIFY.APP')).toBe(true);
  });

  test('matches host-only rules', () => {
    const allowed = parseCorsOrigin('imposter-word-game-vasanth.netlify.app');
    expect(originIsAllowed(allowed, 'https://imposter-word-game-vasanth.netlify.app')).toBe(true);
    expect(originIsAllowed(allowed, 'http://imposter-word-game-vasanth.netlify.app')).toBe(true);
  });

  test('supports wildcard subdomains', () => {
    const allowed = parseCorsOrigin('*.netlify.app');
    expect(originIsAllowed(allowed, 'https://imposter-word-game-vasanth.netlify.app')).toBe(true);
    expect(originIsAllowed(allowed, 'https://x.y.netlify.app')).toBe(true);
    expect(originIsAllowed(allowed, 'https://netlify.app')).toBe(false);
  });
});

