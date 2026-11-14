import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DEMO_REPRO, DEMO_TEST, createDemoRepo } from '../src/demo.js';
import { findCulprit } from '../src/engine.js';
import { runCommand } from '../src/exec.js';
import { git } from '../src/git.js';
import { colorFor, excerpt, timeAgo } from '../src/report.js';

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

test('excerpt drops color codes from test output', () => {
  assert.equal(excerpt('\x1b[31mnot ok 1 - a\x1b[39m\n')[0], 'not ok 1 - a');
});

test('FORCE_COLOR turns color on without a terminal, and 0 turns it off', () => {
  const saved = { force: process.env.FORCE_COLOR, no: process.env.NO_COLOR };
  const pipe = { isTTY: false } as NodeJS.WriteStream;
  try {
    process.env.FORCE_COLOR = '1';
    process.env.NO_COLOR = '1';
    assert.equal(colorFor(pipe).red('x'), '\x1b[31mx\x1b[39m');
    process.env.FORCE_COLOR = '0';
    assert.equal(colorFor({ isTTY: true } as NodeJS.WriteStream).red('x'), 'x');
  } finally {
    for (const [key, value] of [['FORCE_COLOR', saved.force], ['NO_COLOR', saved.no]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('tested code does not see AI keys or GitHub tokens', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-secret';
  process.env.GITHUB_TOKEN = 'ghs-secret';
  try {
    const show = `node -e "console.log([process.env.ANTHROPIC_API_KEY, process.env.GITHUB_TOKEN, process.env.PATH ? 'path' : ''].join(','))"`;
    assert.equal((await runCommand(show, repo, 30_000, { untrusted: true })).output.trim(), ',,path');
    assert.equal((await runCommand(show, repo, 30_000)).output.trim(), 'sk-secret,ghs-secret,path');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GITHUB_TOKEN;
  }
});
