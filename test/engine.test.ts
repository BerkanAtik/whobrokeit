import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEMO_REPRO, DEMO_TEST, createDemoRepo } from '../src/demo.js';
import { findCulprit, type EngineEvent } from '../src/engine.js';
import { runCommand } from '../src/exec.js';
import { git } from '../src/git.js';
import { colorFor, excerpt, formatDuration, palette, renderOutcome, timeAgo, toMarkdown } from '../src/report.js';
import { Sandbox } from '../src/sandbox.js';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cli = (args: string): string => `node --import ${import.meta.resolve('tsx')} "${CLI}" ${args}`;
/** Fails while flag.txt says "broken". */
const FLAG_TEST = `node -e "process.exit(require('fs').readFileSync('flag.txt','utf8').startsWith('broken')?1:0)"`;

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

test('the report lists the files of the culprit next to it, not under the fix', async () => {
  const outcome = await findCulprit({ cwd: repo, test: DEMO_TEST, withFiles: [DEMO_REPRO], good: 'HEAD~20' });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind !== 'found') return;
  const markdown = toMarkdown(outcome, DEMO_TEST);
  const files = markdown.indexOf(`Files changed in \`${outcome.culprit.short}\`:\n\n- \`src/cart.js\` +1 −5\n`);
  assert.ok(files > markdown.indexOf('**Author**') && files < markdown.indexOf('## Proof'), markdown);
});

test('file names outside ASCII are shown as they are', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whobrokeit-names-'));
  const commit = async (flag: string, file?: string): Promise<void> => {
    await writeFile(join(dir, 'flag.txt'), flag);
    if (file) await writeFile(join(dir, file), 'x\n');
    await git(['add', '-A'], dir);
    await git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', flag], dir);
  };
  try {
    await git(['init', '-q'], dir);
    await commit('fine');
    await commit('broken', 'çay.txt');
    await commit('broken still');
    const outcome = await findCulprit({ cwd: dir, test: FLAG_TEST });
    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    assert.deepEqual(outcome.culprit.files.map((f) => f.path).sort(), ['flag.txt', 'çay.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('signed commits read right, even with log.showSignature on', async () => {
  // With that setting, git prints a signature check before the output of `git show --format`.
  const dir = await mkdtemp(join(tmpdir(), 'whobrokeit-signed-'));
  try {
    await git(['init', '-q'], dir);
    await git(['config', 'log.showSignature', 'true'], dir);
    for (const flag of ['fine', 'broken', 'broken still']) {
      await writeFile(join(dir, 'flag.txt'), flag);
      await git(['add', '-A'], dir);
      const tree = await git(['write-tree'], dir);
      const parent = await git(['rev-parse', '-q', '--verify', 'HEAD'], dir).catch(() => '');
      const who = 'T <t@example.com> 1700000000 +0000';
      // A signature git can't check is enough to make it print one; no key needed.
      const object = [
        `tree ${tree}`,
        ...(parent ? [`parent ${parent}`] : []),
        `author ${who}`,
        `committer ${who}`,
        'gpgsig -----BEGIN SSH SIGNATURE-----',
        ' U1NIU0lHAAAAAQ==',
        ' -----END SSH SIGNATURE-----',
        '',
        flag,
        '',
      ].join('\n');
      const file = join(dir, '.git', 'commit.txt');
      await writeFile(file, object);
      await git(['update-ref', 'HEAD', await git(['hash-object', '--no-filters', '-t', 'commit', '-w', file], dir)], dir);
    }
    const outcome = await findCulprit({ cwd: dir, test: FLAG_TEST });
    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    assert.match(outcome.culprit.sha, /^[0-9a-f]{40}$/);
    assert.equal(outcome.culprit.subject, 'broken');
    assert.match(outcome.parent.sha, /^[0-9a-f]{40}$/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/** A repository with one commit per flag, each writing it to flag.txt. */
async function flagRepo(flags: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whobrokeit-flags-'));
  await git(['init', '-q'], dir);
  for (const flag of flags) {
    await writeFile(join(dir, 'flag.txt'), flag);
    await git(['add', '-A'], dir);
    await git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', flag], dir);
  }
  return dir;
}

test("the repository's hooks never run in the checkouts it tests", async () => {
  const dir = await flagRepo(['fine', 'broken', 'broken still']);
  try {
    // As a husky or lefthook post-checkout hook that fails.
    await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
    await writeFile(join(dir, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const outcome = await findCulprit({ cwd: dir, test: FLAG_TEST });
    assert.equal(outcome.kind, 'found');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("the user's own worktrees stay, even one whose folder is missing", async () => {
  const dir = await flagRepo(['fine', 'broken']);
  const away = `${dir}-away`;
  try {
    await git(['worktree', 'add', '-q', '--detach', away, 'HEAD'], dir);
    // As on a drive that isn't mounted right now.
    await rm(away, { recursive: true, force: true });
    const outcome = await findCulprit({ cwd: dir, test: FLAG_TEST });
    assert.equal(outcome.kind, 'found');
    const list = await git(['worktree', 'list', '--porcelain'], dir);
    assert.equal(list.match(/^worktree /gm)?.length, 2, list);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(away, { recursive: true, force: true });
  }
});

test('walking back never runs the same commit twice', async () => {
  // The test cannot run on the six oldest commits and fails on the four newest.
  const dir = await flagRepo([0, 1, 2, 3, 4, 5].map((i) => `none ${i}`).concat([6, 7, 8, 9].map((i) => `broken ${i}`)));
  const command = `node -e "const f=require('fs').readFileSync('flag.txt','utf8'); process.exit(f.startsWith('none')?125:f.startsWith('broken')?1:0)"`;
  try {
    const events: EngineEvent[] = [];
    const outcome = await findCulprit({ cwd: dir, test: command, onEvent: (e) => events.push(e) });
    assert.equal(outcome.kind, 'no-good-commit');
    const tested = events.flatMap((e) => (e.type === 'check' && e.phase === 'find-good' ? [e.commit.subject] : []));
    assert.equal(new Set(tested).size, tested.length, tested.join(', '));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a file name with brackets is not read as a pattern', async () => {
  // Next.js routes look like pages/[id].js; as a pattern, that matches pages/i.js.
  const dir = await flagRepo(['fine']);
  await mkdir(join(dir, 'pages'));
  await writeFile(join(dir, 'pages', 'i.js'), 'x\n');
  await git(['add', '-A'], dir);
  await git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'page'], dir);
  const sandbox = await Sandbox.create(dir, 'HEAD', [], false, 30_000);
  try {
    assert.equal(await sandbox.isTracked('pages/i.js'), true);
    assert.equal(await sandbox.isTracked('pages/[id].js'), false);
  } finally {
    await sandbox.dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('an empty repository gets a plain answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whobrokeit-empty-'));
  try {
    await git(['init', '-q'], dir);
    await assert.rejects(findCulprit({ cwd: dir, test: 'exit 1' }), /This repository has no commits yet\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('works when the repository is reached through a link', async () => {
  // As on macOS, where /tmp is a symlink, while git reports the real path.
  const link = `${repo}-link`;
  await symlink(repo, link, 'junction');
  try {
    const outcome = await findCulprit({ cwd: link, test: DEMO_TEST, withFiles: [DEMO_REPRO], good: 'HEAD~20' });
    assert.equal(outcome.kind, 'found');
  } finally {
    await rm(link, { force: true });
  }
});

test('says so when the test already passes', async () => {
  const outcome = await findCulprit({ cwd: repo, test: 'node -e "process.exit(0)"' });
  assert.equal(outcome.kind, 'not-reproduced');
  // A report with no culprit is still Markdown: one headline, the facts once.
  const markdown = toMarkdown(outcome, 'node -e "process.exit(0)"');
  assert.match(markdown, /^# whobrokeit report\n\n\*\*The test passes at [0-9a-f]+, so there is no bug to hunt\.\*\*\n/);
  assert.equal(markdown.match(/1 checks?/g)?.length, 1, markdown);
});

test('says so when nothing in history works, and shows what the test printed', async () => {
  // As with a typo in the command, or a test file that older commits don't have.
  const command = `node -e "console.log('Cannot find module ./test/new.js'); process.exit(1)"`;
  const outcome = await findCulprit({ cwd: repo, test: command });
  assert.equal(outcome.kind, 'no-good-commit');
  if (outcome.kind !== 'no-good-commit') return;
  assert.match(outcome.output, /Cannot find module/);
  const text = renderOutcome(outcome, palette(false));
  assert.match(text, /Test output:\n {2}Cannot find module \.\/test\/new\.js/);
  assert.match(text, /--with <file> if the test file is newer than the bug/);
  assert.match(toMarkdown(outcome, command), /## Test output\n\n```text\nCannot find module \.\/test\/new\.js\n```/);
});

test('says so when the given good commit is broken too', async () => {
  const outcome = await findCulprit({ cwd: repo, test: 'node -e "process.exit(1)"', good: 'HEAD~3' });
  assert.equal(outcome.kind, 'good-fails');
  if (outcome.kind !== 'good-fails') return;
  assert.match(renderOutcome(outcome, palette(false)), /The test also fails at --good/);
  // A test that cannot run there did not fail there.
  const skipped = renderOutcome({ ...outcome, verdict: 'skip', reason: 'test crashed' }, palette(false));
  assert.match(skipped, /The test cannot run at --good [0-9a-f]+ \(test crashed\)\./);
  // With no culprit, the agent's test is still worth a look.
  const repro = { path: 'r.mjs', command: 'node r.mjs', code: 'a\nb\n', agent: 'Fake Agent', attempts: 1 };
  const shown = renderOutcome({ ...outcome, repro }, palette(false), 100, { test: '.git/whobrokeit/r.mjs' });
  assert.match(shown, /The test Fake Agent wrote \(2 lines\): \.git\/whobrokeit\/r\.mjs/);
});

test('a --good or --bad that starts with a dash is never given to git', async () => {
  await assert.rejects(findCulprit({ cwd: repo, test: DEMO_TEST, bad: '--since=2020' }), /--bad --since=2020 is not a commit/);
});

test('a bug called "demo" after -- is described, not the demo command', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'whobrokeit-nogit-'));
  try {
    const run = await runCommand(cli('--agent "node -e 0" -- demo'), outside, 60_000);
    assert.equal(run.code, 1);
    assert.match(run.output, /not inside a git repository/);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('demo --agent without --ai says what is missing, and makes no repo', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'whobrokeit-nodemo-'));
  try {
    const target = join(outside, 'demo');
    const run = await runCommand(cli(`demo "${target}" --agent codex`), outside, 60_000);
    assert.equal(run.code, 1);
    assert.match(run.output, /In the demo, --agent and --model need --ai\./);
    assert.equal(existsSync(target), false);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
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

test('durations never read "1m 60s"', () => {
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(59_960), '1m 0s');
  assert.equal(formatDuration(61_000), '1m 1s');
  assert.equal(formatDuration(119_500), '2m 0s');
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
