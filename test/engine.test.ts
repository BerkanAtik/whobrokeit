import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DEMO_REPRO, DEMO_TEST, createDemoRepo } from '../src/demo.js';
import { findCulprit } from '../src/engine.js';
import { git } from '../src/git.js';
import { excerpt, timeAgo } from '../src/report.js';

let repo: string;

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'whobrokeit-test-'));
  await createDemoRepo(repo);
});

after(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('finds and proves the commit that broke quantities', async () => {
  const outcome = await findCulprit({ cwd: repo, test: DEMO_TEST, withFiles: [DEMO_REPRO] });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind !== 'found') return;
  assert.equal(outcome.culprit.subject, 'refactor: simplify subtotal with reduce');
  assert.equal(outcome.culprit.author, 'Kai Novak');
  assert.equal(outcome.proven, true);
  assert.deepEqual(outcome.culprit.files.map((f) => f.path), ['src/cart.js']);
  assert.ok(outcome.checks <= 12, `expected at most 12 checks, got ${outcome.checks}`);
});

test('leaves the working copy and worktree list untouched', async () => {
  assert.equal(await git(['status', '--porcelain'], repo), `?? ${DEMO_REPRO}`);
  const worktrees = await git(['worktree', 'list', '--porcelain'], repo);
  assert.equal(worktrees.match(/^worktree /gm)?.length, 1);
});

test('works with an explicit --good commit', async () => {
  const outcome = await findCulprit({ cwd: repo, test: DEMO_TEST, withFiles: [DEMO_REPRO], good: 'HEAD~20' });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind === 'found') assert.equal(outcome.culprit.subject, 'refactor: simplify subtotal with reduce');
});

test('says so when the test already passes', async () => {
  const outcome = await findCulprit({ cwd: repo, test: 'node -e "process.exit(0)"' });
  assert.equal(outcome.kind, 'not-reproduced');
});

test('says so when nothing in history works', async () => {
  const outcome = await findCulprit({ cwd: repo, test: 'node -e "process.exit(1)"' });
  assert.equal(outcome.kind, 'no-good-commit');
});

test('says so when the given good commit is broken too', async () => {
  const outcome = await findCulprit({ cwd: repo, test: 'node -e "process.exit(1)"', good: 'HEAD~3' });
  assert.equal(outcome.kind, 'good-fails');
});

test('rejects --with files outside the repo', async () => {
  await assert.rejects(findCulprit({ cwd: repo, test: DEMO_TEST, withFiles: ['../nope.js'] }), /inside the repository/);
});

test('excerpt jumps to the error message', () => {
  const tap =
    'TAP version 13\nnot ok 1 - b\n  ---\n  duration_ms: 1.2\n  error: |-\n    Expected values to be strictly equal:\n    9.99 !== 29.97\n';
  assert.deepEqual(excerpt(tap).slice(0, 2), ['    Expected values to be strictly equal:', '    9.99 !== 29.97']);
});

test('excerpt falls back to the first failure line', () => {
  assert.equal(excerpt('ok 1 - a\nnot ok 2 - b\n# pass 1\n')[0], 'not ok 2 - b');
});

test('timeAgo reads naturally', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  assert.equal(timeAgo('2026-11-02T12:00:00Z', now), '2 weeks ago');
  assert.equal(timeAgo('2026-11-13T12:00:00Z', now), 'yesterday');
});
