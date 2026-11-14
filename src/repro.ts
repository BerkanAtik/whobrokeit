import type { RunResult } from './exec.js';
import type { Verdict } from './sandbox.js';

/**
 * The agent writes a script that prints this marker when it sees the bug. Only a failing run
 * that printed it counts as "broken"; any other failure (an import that doesn't exist on an
 * older commit, a syntax error in the script) counts as "can't tell", so bisect skips that
 * commit instead of blaming it.
 */
export const BUG_MARKER = 'WHOBROKEIT_BUG:';
// Optionally after a "file.go:12: " style prefix, as test runners print it.
const MARKER_LINE = /^\s*(?:\S+:\d+:\s*)?WHOBROKEIT_BUG:/m;

export interface Repro {
  /** Path of the new file, relative to the repository root, with forward slashes. */
  path: string;
  /** Shell command run from the repository root. */
  command: string;
  code: string;
}

/** An attempt that did not reproduce the bug, and why, in words the agent can act on. */
export interface Attempt {
  repro?: Repro;
  problem: string;
  output?: string;
}

export type Reply =
  | { kind: 'repro'; repro: Repro }
  | { kind: 'cannot'; reason: string }
  | { kind: 'invalid'; problem: string };

export function classifyRepro(run: RunResult): { verdict: Verdict; reason?: string } {
  if (run.timedOut) return { verdict: 'skip', reason: 'timed out' };
  if (run.code === 125) return { verdict: 'skip', reason: 'test cannot run here' };
  if (run.code === 0) return { verdict: 'good' };
  if (MARKER_LINE.test(run.output)) return { verdict: 'bad' };
  return { verdict: 'skip', reason: 'test crashed' };
}

/** Why a verification run at the bad commit did not count as reproducing the bug. */
export function explainMiss(run: RunResult | undefined, timeoutMs: number): string {
  if (!run) return 'it could not be run.';
  if (run.timedOut) return `it did not finish within ${Math.round(timeoutMs / 1000)} seconds.`;
  if (run.code === 0) {
    return 'it exited 0, which means "the behavior is correct". It does not catch the bug: it checks the wrong thing, or a different scenario than the report.';
  }
  if (run.code === 125) {
    return 'it exited 125 ("cannot run on this version"). This commit is where the bug is, so the script must run here.';
  }
  return `it exited ${run.code} without printing a line that starts with ${BUG_MARKER}, so the script itself probably crashed.`;
}

export function parseReply(text: string): Reply {
  const cannot = /<cannot>([\s\S]*?)<\/cannot>/i.exec(text);
  const path = lastTag(text, 'path');
  const command = lastTag(text, 'command');

  if (cannot && !path) return { kind: 'cannot', reason: cannot[1].trim() || 'no reason given' };

  const commandEnd = command ? text.lastIndexOf('</command>') : -1;
  const codeStart = text.indexOf('<code>', Math.max(0, commandEnd));
  const codeEnd = text.lastIndexOf('</code>');
  if (!path || !command || codeStart === -1 || codeEnd <= codeStart) {
    return { kind: 'invalid', problem: 'the reply did not contain <path>, <command> and <code>, in that order.' };
  }
  if (/[\r\n]/.test(command)) return { kind: 'invalid', problem: 'the <command> must be a single line.' };

  let code = text.slice(codeStart + '<code>'.length, codeEnd).replace(/^\r?\n/, '');
  // Tolerate a Markdown fence around the code.
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n\s*```\s*$/.exec(code);
  if (fenced) code = `${fenced[1]}\n`;
  if (!code.trim()) return { kind: 'invalid', problem: 'the <code> was empty.' };

  return {
    kind: 'repro',
    repro: { path: path.replace(/^[`'"]|[`'"]$/g, ''), command: command.replace(/^`|`$/g, ''), code },
  };
}

function lastTag(text: string, tag: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi'))];
  const value = matches.at(-1)?.[1].trim();
  return value || undefined;
}

/** Checks the path the agent chose; returns a problem, or the normalized path. */
export function normalizeReproPath(path: string): { path: string } | { problem: string } {
  const clean = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const parts = clean.split('/');
  if (!clean || /^[a-zA-Z]:/.test(clean) || clean.startsWith('/') || parts.includes('..') || parts.includes('')) {
    return { problem: `<path> ${path} must be a relative path inside the repository.` };
  }
  // Windows and macOS file systems ignore case: `.GIT` is the same folder there.
  if (parts[0].toLowerCase() === '.git') return { problem: '<path> must not be inside .git.' };
  return { path: clean };
}

const ATTEMPT_OUTPUT_LINES = 60;

export function buildPrompt(input: {
  bug: string;
  commit: { short: string; subject: string };
  attempts: Attempt[];
  maxAttempts: number;
}): string {
  const { bug, commit, attempts, maxAttempts } = input;
  const parts = [
    `You are helping whobrokeit find the commit that introduced a bug. Your only job: write one small script that shows the bug at the current commit. whobrokeit will then run that script on older commits with git bisect.

## Bug report

<bug_report>
${bug.trim()}
</bug_report>

The repository is checked out in the current directory at commit ${commit.short} ("${commit.subject}"). You can read and search the files, but you cannot change them or run anything. whobrokeit runs your script and tells you what happened.

## The script

It will run unchanged on many older commits, so it must follow this contract exactly:

- The behavior is correct: exit 0.
- The bug is present: print one line that starts with \`${BUG_MARKER}\` and says what was expected and what actually happened, then exit 1.
- The check cannot run on this version of the code, because something it needs (a module, function or option) does not exist yet: exit 125. Never use 125 for the bug itself.
- If the bug shows up as an exception or a crash, catch it around the one call that triggers it and report it as the bug, but only when it is the error from the report: check its message or type, and rethrow anything else. Never put imports or setup inside that try, because on an older commit they can fail for unrelated reasons.
- Any other failure, like a crash in the script itself, counts as "can't tell" rather than as the bug.

Keep it short (usually under 40 lines) and deterministic: no network, no sleeping, no dependence on today's date or on random values, done in a few seconds. Use only the language runtime, the project's own code and the dependencies it already has (they are installed before the script runs). Load the code under test through stable entry points so the script still works on older commits. Prefer a plain script over a test framework. Write comments and messages in the language the bug report is written in (an English report gets English messages), whatever language you usually reply in. In Node.js, set process.exitCode instead of calling process.exit(), so the output is not cut off.

Put the script in a new file, never an existing one, at the repository root unless the language needs it somewhere else. The command runs from the repository root and must run only this script, not the whole test suite.

## Reply format

Reply with these three tags, and nothing after them:

<path>whobrokeit-repro.mjs</path>
<command>node whobrokeit-repro.mjs</command>
<code>
...the complete file...
</code>

If the report does not describe something you can check, or the code shows that the described behavior is intended, reply with <cannot>one sentence saying why</cannot> instead.`,
  ];

  if (attempts.length > 0) {
    parts.push('## Earlier attempts that did not work');
    attempts.forEach((attempt, i) => {
      const lines = [`### Attempt ${i + 1}`];
      if (attempt.repro) {
        lines.push(
          `<path>${attempt.repro.path}</path>`,
          `<command>${attempt.repro.command}</command>`,
          `<code>\n${attempt.repro.code.trimEnd()}\n</code>`,
        );
      }
      lines.push(`Result at ${commit.short}: ${attempt.problem}`);
      if (attempt.output?.trim()) {
        const tail = attempt.output.replace(/\r/g, '').trimEnd().split('\n').slice(-ATTEMPT_OUTPUT_LINES).join('\n');
        lines.push(`Output:\n<output>\n${tail}\n</output>`);
      }
      parts.push(lines.join('\n'));
    });
    parts.push(
      `Write a better script. This is attempt ${attempts.length + 1} of ${maxAttempts}. If you now think the bug cannot be reproduced, reply with <cannot> instead.`,
    );
  }

  return `${parts.join('\n\n')}\n`;
}
