#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pickAgent } from './agent.js';
import { DEMO_BUG_REPORT, DEMO_REPRO, DEMO_TEST, createDemoRepo } from './demo.js';
import { UserError, findCulprit, type DescribeOptions, type ExplainOptions, type Outcome } from './engine.js';
import { killActiveCommands } from './exec.js';
import { git } from './git.js';
import { colorFor, liveReporter, renderOutcome, toMarkdown, type SavedFiles } from './report.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

const HELP = `whobrokeit: find the commit that broke it, and prove it.

Usage
  whobrokeit "<what is broken>" [options]   an AI agent writes a test that shows the bug
  whobrokeit --test "<command>" [options]   bring your own failing test
  whobrokeit demo [dir] [--ai]              try it on a generated repo with a hidden bug

Options
  -t, --test <cmd>     A command that fails while the bug is present.
                       Exit 0 = works, 125 = can't tell (skip), anything else = broken.
      --agent <name>   Who writes the test: claude, codex, or any command that reads a
                       prompt on stdin and answers on stdout. Default: claude, else codex.
      --model <name>   Model for the agent, e.g. sonnet.
      --explain        Also explain the culprit and test a fix when you use --test.
      --no-explain     Skip the explanation and fix when you describe a bug.
  -w, --with <file>    Copy this file from your working copy into every commit tested.
                       Use it for a repro test you haven't committed. Repeatable.
  -g, --good <ref>     A commit where it still worked. Default: found automatically.
  -b, --bad <ref>      A commit where it is broken. Default: HEAD.
      --setup <cmd>    Install command, re-run when dependency files change. Default: auto (npm/pnpm/yarn/bun).
      --no-setup       Never install dependencies.
      --timeout <sec>  Time limit for each test run. Default: 600, or 300 for agent-written tests.
      --report <file>  Also write a Markdown report.
      --json           Print the result as JSON.
  -h, --help
  -v, --version

Your working copy is never touched: every check runs in a temporary git worktree.
The agent can only read the code. whobrokeit runs the test it writes, and trusts it
only after seeing it fail where the bug is. A suggested fix is shown only after the
test passes with it.

Exit codes
  0 found and proven · 1 error · 2 bug not reproduced · 3 no working commit found · 4 inconclusive
`;

/**
 * Keeps the agent-written test and the fix in .git/whobrokeit/, next to git's own state: out
 * of the working copy, but easy to open, copy or `git apply`. Returns a path to show, or
 * undefined if it could not be saved.
 */
async function saveFile(cwd: string, name: string, content: string): Promise<string | undefined> {
  try {
    const gitDir = resolve(cwd, await git(['rev-parse', '--git-common-dir'], cwd));
    const target = join(gitDir, 'whobrokeit', basename(name));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    const shown = relative(process.cwd(), target);
    return shown.startsWith('..') ? target : shown.split(sep).join('/');
  } catch {
    return undefined;
  }
}

function exitCode(outcome: Outcome): number {
  switch (outcome.kind) {
    case 'found':
      return outcome.proven ? 0 : 4;
    case 'not-reproduced':
    case 'cannot-test':
    case 'no-repro':
      return 2;
    case 'no-good-commit':
    case 'good-fails':
      return 3;
    case 'ambiguous':
      return 4;
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: {
      test: { type: 'string', short: 't' },
      with: { type: 'string', short: 'w', multiple: true },
      good: { type: 'string', short: 'g' },
      bad: { type: 'string', short: 'b' },
      setup: { type: 'string' },
      'no-setup': { type: 'boolean' },
      agent: { type: 'string' },
      model: { type: 'string' },
      ai: { type: 'boolean' },
      explain: { type: 'boolean' },
      'no-explain': { type: 'boolean' },
      timeout: { type: 'string' },
      report: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const progress = colorFor(process.stderr);
  let cwd = process.cwd();
  let test = values.test;
  let bug = positionals.join(' ').trim() || undefined;
  let withFiles = values.with ?? [];

  // After `--` everything is the bug description, even a bug called "demo".
  const first = tokens.find((token) => token.kind !== 'option');
  if (first?.kind === 'positional' && first.value === 'demo') {
    const dir = positionals[1] ? resolve(positionals[1]) : await mkdtemp(join(tmpdir(), 'whobrokeit-demo-'));
    await createDemoRepo(dir);
    process.stderr.write(
      `\n${progress.bold('Demo repo:')} ${dir}\n` +
        `24 commits of a tiny shopping-cart library. A user reports: "${DEMO_BUG_REPORT}"\n`,
    );
    cwd = dir;
    if (values.ai) {
      bug = DEMO_BUG_REPORT;
      test = undefined;
    } else {
      process.stderr.write(
        progress.dim(
          `The repro test ${DEMO_REPRO} is not committed; --with brings it into every commit.\n` +
            'Add --ai to have an AI agent write the test from the bug report instead.\n',
        ),
      );
      bug = undefined;
      test = DEMO_TEST;
      withFiles = [DEMO_REPRO];
    }
  } else if (values.ai) {
    throw new UserError('--ai only works with `whobrokeit demo`. Elsewhere, just describe the bug in quotes.');
  }

  if (test && bug) {
    throw new UserError('Give either a bug description or --test, not both.');
  }
  if (!test && !bug) {
    process.stdout.write(HELP);
    return 1;
  }

  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const seconds = Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new UserError('--timeout must be a positive number of seconds.');
    timeoutMs = seconds * 1000;
  }

  const controller = new AbortController();
  const onSignal = (): void => {
    if (controller.signal.aborted) process.exit(130);
    process.stderr.write('\nStopping and cleaning up…\n');
    controller.abort();
    killActiveCommands();
  };
  // Also when a CI job is cancelled or the terminal is closed, so no worktree is left behind.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.on(signal, onSignal);

  if (values.explain && values['no-explain']) throw new UserError('Give either --explain or --no-explain, not both.');
  const wantsExplain = bug ? !values['no-explain'] : Boolean(values.explain);

  try {
    let describe: DescribeOptions | undefined;
    let explain: ExplainOptions | undefined;
    if (bug || wantsExplain) {
      const agent = await pickAgent(values.agent, cwd, values.model);
      if (bug) describe = { bug, agent };
      if (wantsExplain) explain = { agent };
    } else if (values.agent || values.model) {
      throw new UserError('--agent and --model need a bug description or --explain; with only --test, no agent is used.');
    }

    const outcome = await findCulprit({
      cwd,
      test,
      describe,
      explain,
      withFiles,
      good: values.good,
      bad: values.bad,
      setup: values['no-setup'] ? false : values.setup,
      timeoutMs,
      signal: controller.signal,
      onEvent: values.json ? undefined : liveReporter(process.stderr, progress, test ? { test } : { bug: bug ?? '' }),
    });

    const fix = outcome.kind === 'found' ? outcome.explanation?.fix : undefined;
    const saved: SavedFiles = {
      test: outcome.repro ? await saveFile(cwd, outcome.repro.path, outcome.repro.code) : undefined,
      fix: fix?.verified ? await saveFile(cwd, 'fix.patch', fix.patch) : undefined,
    };
    if (values.report) await writeFile(resolve(values.report), toMarkdown(outcome, test ?? ''));
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ ...outcome, savedTest: saved.test, savedFix: saved.fix }, null, 2)}\n`);
    } else {
      process.stdout.write(renderOutcome(outcome, colorFor(process.stdout), process.stdout.columns || 100, saved));
    }
    return exitCode(outcome);
  } catch (err) {
    if (controller.signal.aborted) return 130;
    throw err;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const c = colorFor(process.stderr);
    if (err instanceof UserError) {
      process.stderr.write(`${c.red('error:')} ${err.message}\n${err.hint ? `${c.dim(err.hint)}\n` : ''}`);
    } else if (err instanceof Error && 'code' in err && String(err.code).startsWith('ERR_PARSE_ARGS')) {
      const hint = 'Run whobrokeit --help for usage. If the bug description starts with a dash, put -- before it.';
      process.stderr.write(`${c.red('error:')} ${err.message}\n${c.dim(hint)}\n`);
    } else {
      process.stderr.write(`${c.red('Unexpected error:')} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exitCode = 1;
  },
);
