import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pickAgent, type Agent } from '../src/agent.js';
import { DEMO_BUG_REPORT, DEMO_REPRO, DEMO_TEST, createDemoRepo } from '../src/demo.js';
import { UserError, findCulprit, type EngineEvent } from '../src/engine.js';
import type { RunResult } from '../src/exec.js';
import { parseExplanation } from '../src/explain.js';
import { git } from '../src/git.js';
import { buildPrompt, classifyRepro, parseReply } from '../src/repro.js';

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

test('a failing agent does not lose the culprit', async () => {
  const broken: Agent = {
    label: 'Broken Agent',
    async ask() {
      throw new UserError('Broken Agent did not answer within 15 minutes.');
    },
  };
  const outcome = await findCulprit({ cwd: repo, test: DEMO_TEST, withFiles: [DEMO_REPRO], explain: { agent: broken } });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind !== 'found') return;
  assert.equal(outcome.proven, true);
  assert.match(outcome.explanation?.note ?? '', /did not answer/);
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
});
