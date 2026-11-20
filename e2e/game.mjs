// End-to-end: boots the real server, plays a full round with 3 browsers over the Sente websocket.
// Run: npm run build && npm run e2e
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const PORT = 3999;
const URL = `http://localhost:${PORT}/`;

const server = spawn('clojure', ['-M:run'], {
  env: { ...process.env, PORT: String(PORT), TURN_SECONDS: '4', VOTING_SECONDS: '20' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => d.toString().includes('listening') && resolve());
  server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  setTimeout(() => reject(new Error('server start timeout')), 120000);
});

const browser = await chromium.launch();
const pageErrors = [];
const step = (msg) => {
  assert.deepEqual(pageErrors, [], 'browser errors');
  console.log(`✓ ${msg}`);
};

try {
  const players = {};
  for (const name of ['Alice', 'Bob', 'Cat']) {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    page.wsUrls = [];
    page.on('websocket', (ws) => page.wsUrls.push(ws.url()));
    page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
    await page.goto(URL);
    await page.getByText('Connected').waitFor();
    await page.getByPlaceholder('Name').fill(name);
    players[name] = page;
  }
  const { Alice, Bob, Cat } = players;
  const pages = [Alice, Bob, Cat];
  assert.ok(pages.every((p) => p.wsUrls.some((u) => u.startsWith(`ws://localhost:${PORT}/chsk`))), 'uses websocket');
  step('3 clients connected over ws://…/chsk');

  await Alice.getByRole('button', { name: 'Create room' }).click();
  await Alice.getByRole('heading', { name: 'Lobby' }).waitFor();
  const code = await Alice.locator('.ConsoleText').innerText().then((t) => t.split(' • ')[0]);
  assert.match(code, /^[A-Z0-9]{6}$/);
  step(`Alice created room ${code}`);

  const missing = Bob;
  await missing.getByPlaceholder('Room code').fill('NOPE42');
  await missing.getByRole('button', { name: 'Join', exact: true }).click();
  await missing.getByText('Join failed: room_not_found').waitFor();
  step('joining a missing room is rejected');

  for (const p of [Bob, Cat]) {
    await p.getByPlaceholder('Room code').fill(code);
    await p.getByRole('button', { name: 'Join', exact: true }).click();
    await p.getByRole('heading', { name: 'Lobby' }).waitFor();
  }
  await Alice.locator('.PlayerRow').nth(2).waitFor();
  assert.equal(await Alice.locator('.PlayerRow').count(), 3);
  assert.ok(await Bob.getByRole('button', { name: 'Start round' }).isDisabled(), 'non-host cannot start');
  step('Bob and Cat joined; only host can start');

  await Alice.getByRole('button', { name: 'Start round' }).click();
  const words = {};
  for (const [name, p] of Object.entries(players)) {
    await p.locator('.WordValue').filter({ hasText: /\S/ }).waitFor();
    words[name] = await p.locator('.WordValue').innerText();
  }
  const counts = Object.values(words).reduce((m, w) => ({ ...m, [w]: (m[w] || 0) + 1 }), {});
  assert.deepEqual(Object.values(counts).sort(), [1, 2], `one decoy word: ${JSON.stringify(words)}`);
  const imposter = Object.keys(words).find((n) => counts[words[n]] === 1);
  step(`words dealt privately; imposter is ${imposter}`);

  // Clue phase: whoever has the turn sends a clue, except the 2nd turn which is left to time out.
  const order = (await Alice.locator('ol.List li').allInnerTexts()).map((t) => t.replace(' (you)', ''));
  for (const [i, name] of order.entries()) {
    const p = players[name];
    await p.getByRole('heading', { name: 'Your turn' }).waitFor();
    if (i === 1) {
      await Alice.locator('.ClueText', { hasText: '(timeout)' }).waitFor({ timeout: 8000 });
      step(`${name}'s turn timed out → "(timeout)" clue`);
      continue;
    }
    await p.getByPlaceholder('Type your clue…').fill(`hint-${name}`);
    await p.getByRole('button', { name: 'Send' }).click();
  }
  await Promise.all(pages.map((p) => p.getByRole('heading', { name: 'Voting' }).waitFor()));
  assert.deepEqual(
    (await Cat.locator('.ClueSender').allInnerTexts()),
    order,
  );
  step('all clues in turn order; voting started');

  const crew = Object.keys(players).filter((n) => n !== imposter);
  for (const name of crew) {
    const p = players[name];
    assert.ok(await p.getByRole('button', { name: `Vote ${name}` }).isDisabled(), 'no self-vote');
    await p.getByRole('button', { name: `Vote ${imposter}` }).click();
    await p.getByText('Vote locked in').waitFor();
  }
  await players[imposter].getByRole('button', { name: `Vote ${crew[0]}` }).click();

  for (const p of pages) {
    await p.getByRole('heading', { name: 'Game over' }).waitFor();
    const result = await p.locator('.ResultRow').allInnerTexts();
    assert.ok(result.some((r) => r.includes('Crewmates')), result.join('|'));
    assert.ok(result.some((r) => r.startsWith('Imposter') && r.includes(imposter)), result.join('|'));
    assert.ok(result.some((r) => r.includes(words[crew[0]])), 'secret word revealed');
  }
  step('crew voted out the imposter → Crewmates win on every screen');

  await Promise.all(pages.map((p) => p.getByRole('heading', { name: 'Lobby' }).waitFor({ timeout: 8000 })));
  step('everyone back in lobby');

  // Reload: Bob's saved token lets him reclaim his name; a stranger cannot.
  await Bob.reload();
  await Bob.getByText('Connected').waitFor();
  assert.equal(await Bob.getByPlaceholder('Name').inputValue(), 'Bob');
  await Bob.getByPlaceholder('Room code').fill(code);
  await Bob.getByRole('button', { name: 'Join', exact: true }).click();
  await Bob.getByRole('heading', { name: 'Lobby' }).waitFor();
  await Alice.locator('.PlayerRow').nth(2).waitFor();
  assert.equal(await Alice.locator('.PlayerRow').count(), 3, 'no duplicate Bob');
  step('Bob reloaded and reclaimed his seat with his token');

  const imp = await (await browser.newContext()).newPage();
  await imp.goto(URL);
  await imp.getByText('Connected').waitFor();
  await imp.getByPlaceholder('Name').fill('bob');
  await imp.getByPlaceholder('Room code').fill(code);
  await imp.getByRole('button', { name: 'Join', exact: true }).click();
  await imp.getByText('Join failed: name_taken').waitFor();
  step('impersonating "bob" without the token is rejected');

  // Host leaves the lobby → next connected player becomes host.
  await Alice.context().close();
  await Bob.getByText('You are the host.').waitFor({ timeout: 10000 });
  step('host left → Bob promoted to host');

  console.log('\nE2E PASSED');
} catch (e) {
  console.error('\nE2E FAILED:', e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
