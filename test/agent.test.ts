import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pickAgent, type Agent } from '../src/agent.js';
import { DEMO_BUG_REPORT, DEMO_REPRO, DEMO_TEST, createDemoRepo } from '../src/demo.js';
import { UserError, findCulprit, type EngineEvent } from '../src/engine.js';
import { runCommand, type RunResult } from '../src/exec.js';
import { applyEdits, parseExplanation } from '../src/explain.js';
import { git } from '../src/git.js';
import { toMarkdown } from '../src/report.js';
import { buildPrompt, classifyRepro, normalizeReproPath, parseReply } from '../src/repro.js';

const BUG_SUBJECT = 'refactor: simplify subtotal with reduce';

const answer = (path: string, code: string, command = `node ${path}`): string =>
  `I read src/cart.js. Here is the script.\n\n<path>${path}</path>\n<command>${command}</command>\n<code>\n${code}</code>\n`;

const REPRO = `import { createCart, addItem, subtotal } from './src/cart.js';

const cart = createCart();
addItem(cart, { name: 'mug', price: 9.99, qty: 3 });
const got = subtotal(cart);
if (got !== 29.97) {
  console.log('WHOBROKEIT_BUG: expected 29.97 for 3 mugs, got ' + got);
  process.exitCode = 1;
}
`;

/** Same check, but it also imports formatPrice, which only exists from commit 9 on. */
const REPRO_NEEDS_NEWER_API = REPRO.replace('subtotal }', 'subtotal, formatPrice }').replace(
  "' + got",
  "' + formatPrice(got)",
);

const MISSES_THE_BUG = "console.log('looks fine to me');\n";

function scripted(...answers: string[]): Agent & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    label: 'Fake Agent',
    prompts,
    async ask(prompt) {
      prompts.push(prompt);
      const next = answers.shift();
      if (next === undefined) throw new Error('the fake agent ran out of answers');
      return next;
    },
  };
}

let repo: string;

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'whobrokeit-agent-test-'));
  await createDemoRepo(repo);
});

after(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('an agent-written test finds and proves the culprit, after one miss', async () => {
  const agent = scripted(answer('whobrokeit-repro.mjs', MISSES_THE_BUG), answer('whobrokeit-repro.mjs', REPRO));
  const outcome = await findCulprit({ cwd: repo, describe: { bug: DEMO_BUG_REPORT, agent } });

  assert.equal(outcome.kind, 'found');
  if (outcome.kind !== 'found') return;
  assert.equal(outcome.culprit.subject, BUG_SUBJECT);
  assert.equal(outcome.proven, true);
  assert.equal(outcome.repro?.attempts, 2);
  assert.equal(outcome.repro?.agent, 'Fake Agent');
  assert.match(outcome.failureOutput, /WHOBROKEIT_BUG: expected 29\.97 for 3 mugs, got 9\.99/);

  assert.ok(agent.prompts[0].includes(DEMO_BUG_REPORT));
  assert.ok(!agent.prompts[0].includes('Earlier attempts'));
  assert.match(agent.prompts[1], /### Attempt 1[\s\S]*it exited 0/);
  assert.match(agent.prompts[1], /looks fine to me/);
});

test('the agent may not replace an existing file', async () => {
  const sabotage = 'export function subtotal() { return -1; }\n';
  const agent = scripted(answer('src/cart.js', sabotage), answer('whobrokeit-repro.mjs', REPRO));
  const events: EngineEvent[] = [];
  const outcome = await findCulprit({ cwd: repo, describe: { bug: DEMO_BUG_REPORT, agent }, onEvent: (e) => events.push(e) });

  assert.equal(outcome.kind, 'found');
  assert.equal(outcome.repro?.attempts, 2);
  assert.ok(events.some((e) => e.type === 'rejected' && /already exists/.test(e.problem)));
  assert.match(agent.prompts[1], /src\/cart\.js already exists/);
});

test('a crash on older commits means "can\'t tell", not "broken"', async () => {
  const agent = scripted(answer('whobrokeit-repro.mjs', REPRO_NEEDS_NEWER_API));
  const events: EngineEvent[] = [];
  const outcome = await findCulprit({ cwd: repo, describe: { bug: DEMO_BUG_REPORT, agent }, onEvent: (e) => events.push(e) });

  assert.equal(outcome.kind, 'found');
  if (outcome.kind !== 'found') return;
  assert.equal(outcome.culprit.subject, BUG_SUBJECT);
  assert.equal(outcome.proven, true);
  const skipped = events.filter((e) => e.type === 'check' && e.verdict === 'skip');
  assert.ok(skipped.length > 0, 'expected the commits without formatPrice to be skipped');
});

test('says so when the agent finds nothing to reproduce', async () => {
  const agent = scripted('<cannot>The report does not say what went wrong.</cannot>');
  const outcome = await findCulprit({ cwd: repo, describe: { bug: 'it is weird', agent } });

  assert.equal(outcome.kind, 'no-repro');
  if (outcome.kind !== 'no-repro') return;
  assert.equal(outcome.gaveUp, true);
  assert.equal(outcome.reason, 'The report does not say what went wrong.');
  assert.equal(outcome.checks, 0);
  // There is no test to name, and an empty code span would show up as stray backticks.
  const markdown = toMarkdown(outcome, '');
  assert.ok(!markdown.includes('``'), markdown);
  assert.match(markdown, /^_0 checks · /m);
});

test('a test path the commit cannot hold costs one attempt, not the run', async () => {
  // src/cart.js is a file, so nothing can be written under it.
  const agent = scripted(
    answer('src/cart.js/repro.mjs', REPRO, 'node src/cart.js/repro.mjs'),
    answer('whobrokeit-repro.mjs', REPRO),
  );
  const outcome = await findCulprit({ cwd: repo, describe: { bug: DEMO_BUG_REPORT, agent } });
  assert.equal(outcome.kind, 'found');
  assert.equal(outcome.repro?.attempts, 2);
  assert.match(agent.prompts[1], /it could not be run: cannot write src\/cart\.js\/repro\.mjs at this commit/);
});

test('gives up after three tests that all pass', async () => {
  const miss = answer('whobrokeit-repro.mjs', MISSES_THE_BUG);
  const agent = scripted(miss, miss, miss);
  const outcome = await findCulprit({ cwd: repo, describe: { bug: DEMO_BUG_REPORT, agent } });

  assert.equal(outcome.kind, 'no-repro');
  if (outcome.kind !== 'no-repro') return;
  assert.equal(outcome.gaveUp, false);
  assert.equal(outcome.attempts.length, 3);
  assert.equal(outcome.checks, 3);
  assert.match(agent.prompts[2], /attempt 3 of 3/);
});

test('a custom agent command gets the prompt on stdin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whobrokeit-fake-agent-'));
  try {
    const script = join(dir, 'agent.mjs');
    const reply = answer('whobrokeit-repro.mjs', REPRO);
    await writeFile(
      script,
      `let prompt = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (d) => (prompt += d));\n` +
        `process.stdin.on('end', () => {\n  if (!prompt.includes(${JSON.stringify(DEMO_BUG_REPORT)})) process.exit(3);\n` +
        `  process.stdout.write(${JSON.stringify(reply)});\n});\n`,
    );
    const agent = await pickAgent(`node "${script}"`, repo);
    const outcome = await findCulprit({ cwd: repo, describe: { bug: DEMO_BUG_REPORT, agent } });
    assert.equal(outcome.kind, 'found');
    if (outcome.kind === 'found') assert.equal(outcome.culprit.subject, BUG_SUBJECT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const explainReply = (replace: string, path = 'src/cart.js'): string =>
  `The reduce drops the quantity.\n<why>subtotal() now adds item.price once per item\nand ignores item.qty.</why>\n` +
  `<fix>\n<edit path="${path}">\n<find>\nsum + item.price, 0\n</find>\n<replace>\n${replace}\n</replace>\n</edit>\n</fix>\n`;

test('explains the culprit and keeps only a fix the test agrees with', async () => {
  const agent = scripted(
    answer('whobrokeit-repro.mjs', REPRO),
    explainReply('sum + item.price + 0, 0'),
    explainReply('sum + item.price * item.qty, 0'),
  );
  const events: EngineEvent[] = [];
  const outcome = await findCulprit({
    cwd: repo,
    describe: { bug: DEMO_BUG_REPORT, agent },
    explain: { agent },
    onEvent: (e) => events.push(e),
  });

  assert.equal(outcome.kind, 'found');
  if (outcome.kind !== 'found') return;
  const { explanation } = outcome;
  assert.equal(explanation?.why, 'subtotal() now adds item.price once per item and ignores item.qty.');
  assert.equal(explanation?.fix?.verified, true);
  assert.equal(explanation?.fix?.attempts, 2);
  assert.deepEqual(explanation?.fix?.files, ['src/cart.js']);
  assert.match(explanation?.fix?.patch ?? '', /^\+.*sum \+ item\.price \* item\.qty, 0/m);

  assert.ok(agent.prompts[1].includes(`"${BUG_SUBJECT}"`));
  assert.match(agent.prompts[1], /<diff>[\s\S]*-\s+sum \+= item\.price \* item\.qty;/);
  assert.match(agent.prompts[1], /<test_file path="whobrokeit-repro\.mjs">/);
  assert.match(agent.prompts[2], /### Fix 1[\s\S]*the test still fails/);
  const fixChecks = events.filter((e) => e.type === 'check' && e.phase === 'explain');
  assert.deepEqual(
    fixChecks.map((e) => e.type === 'check' && e.verdict),
    ['bad', 'good'],
  );
});

test('a fix may not touch the tests', async () => {
  const agent = scripted(
    explainReply('sum', DEMO_REPRO),
    '<why>The refactor dropped item.qty.</why>\n<nofix>Not sure what the intended rounding is.</nofix>',
  );
  const outcome = await findCulprit({ cwd: repo, test: DEMO_TEST, withFiles: [DEMO_REPRO], explain: { agent } });

  assert.equal(outcome.kind, 'found');
  if (outcome.kind !== 'found') return;
  assert.match(agent.prompts[1], /repro\.test\.mjs is a test\. The fix must change the code/);
  assert.equal(outcome.explanation?.fix, undefined);
  assert.equal(outcome.explanation?.why, 'The refactor dropped item.qty.');
  assert.match(outcome.explanation?.note ?? '', /did not suggest a fix: Not sure/);
});

test('a failing agent does not lose the culprit, whatever it throws', async () => {
  for (const error of [new UserError('Broken Agent did not answer within 15 minutes.'), new Error('socket hang up')]) {
    const broken: Agent = {
      label: 'Broken Agent',
      async ask() {
        throw error;
      },
    };
    const outcome = await findCulprit({
      cwd: repo,
      test: DEMO_TEST,
      withFiles: [DEMO_REPRO],
      good: 'HEAD~20',
      explain: { agent: broken },
    });
    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    assert.equal(outcome.proven, true);
    assert.ok(outcome.explanation?.note?.includes(error.message), outcome.explanation?.note);
  }
});

test('the saved fix applies with git apply, even with diff.noprefix set', async () => {
  await git(['config', 'diff.noprefix', 'true'], repo);
  try {
    const agent = scripted(explainReply('sum + item.price * item.qty, 0'));
    const outcome = await findCulprit({
      cwd: repo,
      test: DEMO_TEST,
      withFiles: [DEMO_REPRO],
      good: 'HEAD~20',
      explain: { agent },
    });
    assert.equal(outcome.kind, 'found');
    if (outcome.kind !== 'found') return;
    const patch = outcome.explanation?.fix?.patch ?? '';
    assert.match(patch, /^diff --git a\/src\/cart\.js b\/src\/cart\.js$/m);
    const file = join(repo, '.git', 'test-fix.patch');
    await writeFile(file, patch);
    await git(['apply', '--check', file], repo);
  } finally {
    await git(['config', '--unset', 'diff.noprefix'], repo);
  }
});

test('a fix may only change files git tracks', async () => {
  // An edit in node_modules can make the test pass and still leave nothing in the patch.
  const dir = await mkdtemp(join(tmpdir(), 'whobrokeit-untracked-'));
  try {
    const file = join(dir, 'node_modules', 'dep', 'index.js');
    await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
    await writeFile(file, 'module.exports = 1;\n');
    const result = await applyEdits(dir, [{ path: 'node_modules/dep/index.js', find: '1', replace: '2' }], [], async () => false);
    assert.ok('problem' in result && /is not part of the repository/.test(result.problem), JSON.stringify(result));
    assert.equal(await readFile(file, 'utf8'), 'module.exports = 1;\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('from a subfolder, the apply command it prints really applies the fix', async () => {
  // `git apply` in a subfolder skips files outside it and still exits 0.
  const dir = await mkdtemp(join(tmpdir(), 'whobrokeit-cli-'));
  const out = await mkdtemp(join(tmpdir(), 'whobrokeit-report-'));
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.GITHUB_TOKEN };
  process.env.ANTHROPIC_API_KEY = 'sk-fake'; // the stand-in agent checks that it gets the key
  delete process.env.GITHUB_TOKEN;
  try {
    await createDemoRepo(dir);
    await rm(join(dir, DEMO_REPRO));
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const agent = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
    // The report folder does not exist yet.
    const report = join(out, 'nested', 'report.md');
    const run = await runCommand(
      `node --import ${import.meta.resolve('tsx')} "${cli}" --agent "node \\"${agent}\\"" --report "${report}" "${DEMO_BUG_REPORT}"`,
      join(dir, 'src'),
      180_000,
    );
    assert.equal(run.code, 0, run.output);
    const apply = /Apply it: (.+)/.exec(run.output)?.[1].trim() ?? '';
    assert.equal(apply, 'git -C .. apply .git/whobrokeit/fix.patch', run.output);
    assert.match(run.output, /wrote \(\d+ lines\): \.\.\/\.git\/whobrokeit\/whobrokeit-repro\.mjs\n/);
    assert.match(run.output, /It runs from the repository root as whobrokeit-repro\.mjs: node whobrokeit-repro\.mjs/);
    const applied = await runCommand(apply, join(dir, 'src'), 30_000);
    assert.equal(applied.code, 0, applied.output);
    assert.equal(await git(['status', '--porcelain'], dir), ' M src/cart.js');
    assert.match(await readFile(report, 'utf8'), /^# whobrokeit report\n\n\*\*Introduced by\*\* `[0-9a-f]+` refactor: simplify subtotal with reduce/);
  } finally {
    for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['GITHUB_TOKEN', saved.token]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(out, { recursive: true, force: true });
  }
});

test('the working copy is still untouched', async () => {
  assert.equal(await git(['status', '--porcelain'], repo), `?? ${DEMO_REPRO}`);
  const worktrees = await git(['worktree', 'list', '--porcelain'], repo);
  assert.equal(worktrees.match(/^worktree /gm)?.length, 1);
});

const run = (code: number, output: string, timedOut = false): RunResult => ({ code, output, timedOut, durationMs: 1 });

test('classifyRepro only calls it broken when the script says so', () => {
  assert.equal(classifyRepro(run(1, 'WHOBROKEIT_BUG: expected 3, got 1\n')).verdict, 'bad');
  assert.equal(classifyRepro(run(1, '    repro_test.go:12: WHOBROKEIT_BUG: expected 3\nFAIL\n')).verdict, 'bad');
  assert.equal(classifyRepro(run(1, 'SyntaxError: The requested module does not provide an export\n')).verdict, 'skip');
  assert.equal(classifyRepro(run(0, '')).verdict, 'good');
  assert.equal(classifyRepro(run(125, '')).verdict, 'skip');
  assert.equal(classifyRepro(run(1, 'WHOBROKEIT_BUG: x', true)).verdict, 'skip');
});

test('parseReply reads the tags and tolerates a code fence', () => {
  const parsed = parseReply(answer('repro.py', '```python\nprint("hi")\n```\n', 'python repro.py'));
  assert.deepEqual(parsed, { kind: 'repro', repro: { path: 'repro.py', command: 'python repro.py', code: 'print("hi")\n' } });
  assert.deepEqual(parseReply('<cannot> Too vague. </cannot>'), { kind: 'cannot', reason: 'Too vague.' });
  assert.equal(parseReply('Sorry, I could not read the files.').kind, 'invalid');
  assert.equal(parseReply('<path>a.js</path><command>node a.js\nrm -rf x</command><code>x</code>').kind, 'invalid');
});

test('parseExplanation reads why, edits and nofix', () => {
  const parsed = parseExplanation(explainReply('x'));
  assert.equal(parsed.kind, 'fix');
  if (parsed.kind === 'fix') {
    assert.deepEqual(parsed.edits, [{ path: 'src/cart.js', find: 'sum + item.price, 0', replace: 'x' }]);
  }
  assert.deepEqual(parseExplanation('<why>Because.</why><nofix>Unclear.</nofix>'), {
    kind: 'nofix',
    why: 'Because.',
    reason: 'Unclear.',
  });
  assert.equal(parseExplanation('<why>Because.</why>').kind, 'invalid');
  assert.equal(parseExplanation('<fix><edit path="a.js"><find>x</find></edit></fix>').kind, 'invalid');
});

test('buildPrompt includes what happened on earlier attempts', () => {
  const prompt = buildPrompt({
    bug: 'Totals are wrong',
    commit: { short: 'abc1234', subject: 'feat: things' },
    attempts: [
      { repro: { path: 'r.mjs', command: 'node r.mjs', code: 'x()' }, problem: 'it crashed.', output: 'ReferenceError: x' },
    ],
    maxAttempts: 3,
  });
  assert.match(prompt, /Totals are wrong/);
  assert.match(prompt, /abc1234/);
  assert.match(prompt, /<command>node r\.mjs<\/command>/);
  assert.match(prompt, /Result at abc1234: it crashed\./);
  assert.match(prompt, /ReferenceError: x/);
  assert.match(prompt, /attempt 2 of 3/);
  // Build output is not refreshed per commit, so a built project's test has to build.
  assert.match(prompt, /start the command with the build, for example `npm run build && node whobrokeit-repro\.mjs`/);
});

test('the agent may not write into .git, in any spelling', () => {
  for (const path of ['.git/hooks/pre-commit', '.GIT/config', './.Git/x', '../outside.js', '/etc/passwd', 'C:\\x.js']) {
    assert.ok('problem' in normalizeReproPath(path), path);
  }
  assert.deepEqual(normalizeReproPath('./test\\repro.mjs'), { path: 'test/repro.mjs' });
});

test('test output with a code fence of its own cannot break the report', async () => {
  const outcome = await findCulprit({ cwd: repo, test: DEMO_TEST, withFiles: [DEMO_REPRO], good: 'HEAD~20' });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind !== 'found') return;
  const markdown = toMarkdown({ ...outcome, failureOutput: 'WHOBROKEIT_BUG: got\n```\n# not a heading\n' }, DEMO_TEST);
  assert.ok(markdown.includes('\n````text\nWHOBROKEIT_BUG: got\n```\n# not a heading\n````\n'), markdown);
});

test('the report pings nobody, and one huge output line cannot swamp it', async () => {
  const outcome = await findCulprit({ cwd: repo, test: DEMO_TEST, withFiles: [DEMO_REPRO], good: 'HEAD~20' });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind !== 'found') return;
  const markdown = toMarkdown(
    {
      ...outcome,
      failureOutput: `WHOBROKEIT_BUG: ${'x'.repeat(5000)}\n`,
      explanation: { agent: 'Fake Agent', why: 'Since @alice bumped `@scope/pkg`, (@bob) and mail me@example.com.' },
    },
    'node -e "console.log(`x`)"',
  );
  // GitHub notifies "@name" outside code; a zero-width space stops that and stays invisible.
  const at = `@${String.fromCharCode(0x200b)}`;
  assert.ok(markdown.includes(`Since ${at}alice bumped \`@scope/pkg\`, (${at}bob) and mail me@example.com.`), markdown);
  assert.ok(!/x{401}/.test(markdown), 'a 5000-character line went into the report whole');
  // A command with backticks of its own still reads as code.
  assert.ok(markdown.includes('_Test: ``node -e "console.log(`x`)"`` · '), markdown);
});

