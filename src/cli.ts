#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEMO_BUG_REPORT, DEMO_REPRO, DEMO_TEST, createDemoRepo } from './demo.js';
import { UserError, findCulprit, type Outcome } from './engine.js';
import { killActiveCommands } from './exec.js';
import { colorFor, liveReporter, renderOutcome, toMarkdown } from './report.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

const HELP = `whobrokeit: find the commit that broke it, and prove it.

Usage
  whobrokeit --test "<command>" [options]
  whobrokeit demo [dir]            try it on a generated repo with a hidden bug

Options
  -t, --test <cmd>     A command that fails while the bug is present.
                       Exit 0 = works, 125 = can't tell (skip), anything else = broken.
  -w, --with <file>    Copy this file from your working copy into every commit tested.
                       Use it for a repro test you haven't committed. Repeatable.
  -g, --good <ref>     A commit where it still worked. Default: found automatically.
  -b, --bad <ref>      A commit where it is broken. Default: HEAD.
      --setup <cmd>    Install command, re-run when dependency files change. Default: auto (npm/pnpm/yarn/bun).
      --no-setup       Never install dependencies.
      --timeout <sec>  Time limit for each run. Default: 600.
      --report <file>  Also write a Markdown report.
      --json           Print the result as JSON.
  -h, --help
  -v, --version

Your working copy is never touched: every check runs in a temporary git worktree.

Exit codes
  0 found and proven · 1 error · 2 bug not reproduced · 3 no working commit found · 4 inconclusive
`;

function exitCode(outcome: Outcome): number {
  switch (outcome.kind) {
    case 'found':
      return outcome.proven ? 0 : 4;
    case 'not-reproduced':
    case 'cannot-test':
      return 2;
    case 'no-good-commit':
    case 'good-fails':
      return 3;
    case 'ambiguous':
      return 4;
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      test: { type: 'string', short: 't' },
      with: { type: 'string', short: 'w', multiple: true },
      good: { type: 'string', short: 'g' },
      bad: { type: 'string', short: 'b' },
      setup: { type: 'string' },
      'no-setup': { type: 'boolean' },
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
  let withFiles = values.with ?? [];

  if (positionals[0] === 'demo') {
    const dir = positionals[1] ? resolve(positionals[1]) : await mkdtemp(join(tmpdir(), 'whobrokeit-demo-'));
    await createDemoRepo(dir);
    process.stderr.write(
      `\n${progress.bold('Demo repo:')} ${dir}\n` +
        `24 commits of a tiny shopping-cart library. A user reports: "${DEMO_BUG_REPORT}"\n` +
        `${progress.dim(`The repro test ${DEMO_REPRO} is not committed; --with brings it into every commit.`)}\n`,
    );
    cwd = dir;
    test = DEMO_TEST;
    withFiles = [DEMO_REPRO];
  } else if (positionals.length > 0 && !test) {
    throw new UserError(
      'Describing the bug in plain words needs the AI step, which is not released yet.',
      'For now, pass a command that fails while the bug is present, e.g. whobrokeit --test "npm test"',
    );
  }

  if (!test) {
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
  const onSigint = (): void => {
    if (controller.signal.aborted) process.exit(130);
    process.stderr.write('\nStopping and cleaning up…\n');
    controller.abort();
    killActiveCommands();
  };
  process.on('SIGINT', onSigint);

  try {
    const outcome = await findCulprit({
      cwd,
      test,
      withFiles,
      good: values.good,
      bad: values.bad,
      setup: values['no-setup'] ? false : values.setup,
      timeoutMs,
      signal: controller.signal,
      onEvent: values.json ? undefined : liveReporter(process.stderr, progress, test),
    });

    if (values.report) await writeFile(resolve(values.report), toMarkdown(outcome, test));
    if (values.json) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    else process.stdout.write(renderOutcome(outcome, colorFor(process.stdout), process.stdout.columns || 100));
    return exitCode(outcome);
  } catch (err) {
    if (controller.signal.aborted) return 130;
    throw err;
  } finally {
    process.off('SIGINT', onSigint);
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
      process.stderr.write(`${c.red('error:')} ${err.message}\n${c.dim('Run whobrokeit --help for usage.')}\n`);
    } else {
      process.stderr.write(`${c.red('Unexpected error:')} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exitCode = 1;
  },
);
