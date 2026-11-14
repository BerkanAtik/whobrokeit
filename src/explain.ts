import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeReproPath } from './repro.js';

/** One search-and-replace edit, the format agents get right far more often than diffs. */
export interface Edit {
  path: string;
  find: string;
  replace: string;
}

export type ExplainReply =
  | { kind: 'fix'; why?: string; edits: Edit[] }
  | { kind: 'nofix'; why?: string; reason: string }
  | { kind: 'invalid'; why?: string; problem: string };

/** A fix that did not work, and why, in words the agent can act on. */
export interface FixAttempt {
  edits: Edit[];
  problem: string;
  output?: string;
}

export function parseExplanation(text: string): ExplainReply {
  const why = lastTag(text, 'why')?.replace(/\s*\n\s*/g, ' ');
  const nofix = lastTag(text, 'nofix');
  const fixStart = text.lastIndexOf('<fix>');
  const fixEnd = text.lastIndexOf('</fix>');

  if (fixStart === -1) {
    if (nofix) return { kind: 'nofix', why, reason: nofix };
    return { kind: 'invalid', why, problem: 'the reply had no <fix> (or <nofix>).' };
  }
  const body = text.slice(fixStart, fixEnd > fixStart ? fixEnd : undefined);

  const edits: Edit[] = [];
  for (const match of body.matchAll(/<edit\s+path\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/edit>/gi)) {
    const find = /<find>([\s\S]*?)<\/find>/i.exec(match[2]);
    const replace = /<replace>([\s\S]*?)<\/replace>/i.exec(match[2]);
    if (!find || !replace) {
      return { kind: 'invalid', why, problem: `the edit for ${match[1]} needs both <find> and <replace>.` };
    }
    edits.push({ path: match[1].trim(), find: unwrap(find[1]), replace: unwrap(replace[1]) });
  }
  if (edits.length === 0) return { kind: 'invalid', why, problem: 'the <fix> had no <edit path="..."> blocks.' };
  return { kind: 'fix', why, edits };
}

function lastTag(text: string, tag: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi'))];
  const value = matches.at(-1)?.[1].trim();
  return value || undefined;
}

/** The text between the tags, without the one newline that follows `<find>` and precedes `</find>`. */
function unwrap(text: string): string {
  return text.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;

/**
 * Applies the edits to the files in `dir`. Returns the changed paths, or a problem.
 * The fix has to change the code, so test files and the files whobrokeit drops in are off limits.
 */
export async function applyEdits(
  dir: string,
  edits: Edit[],
  protectedPaths: string[],
): Promise<{ files: string[] } | { problem: string }> {
  const contents = new Map<string, string>();

  for (const edit of edits) {
    const normalized = normalizeReproPath(edit.path);
    if ('problem' in normalized) return { problem: normalized.problem.replace('<path>', 'The edit path') };
    const path = normalized.path;
    if (protectedPaths.includes(path) || TEST_PATH.test(path)) {
      return { problem: `${path} is a test. The fix must change the code, not the tests.` };
    }

    let content = contents.get(path) ?? (await readFile(join(dir, path), 'utf8').catch(() => null));
    if (content === null) return { problem: `${path} does not exist. Edits can only change existing files.` };

    let { find, replace } = edit;
    if (!find) return { problem: `the <find> for ${path} is empty.` };
    if (!content.includes(find) && content.includes('\r\n')) {
      find = find.replace(/\r?\n/g, '\r\n');
      replace = replace.replace(/\r?\n/g, '\r\n');
    }
    const count = content.split(find).length - 1;
    if (count === 0) {
      return { problem: `the <find> text was not found in ${path}. Copy it exactly from the file, including indentation.` };
    }
    if (count > 1) {
      return { problem: `the <find> text appears ${count} times in ${path}. Include more lines so it is unique.` };
    }
    content = content.replace(find, () => replace);
    contents.set(path, content);
  }

  for (const [path, content] of contents) await writeFile(join(dir, path), content);
  return { files: [...contents.keys()] };
}

const MAX_DIFF_CHARS = 40_000;
const OUTPUT_LINES = 60;

const tail = (output: string, lines = OUTPUT_LINES): string =>
  output.replace(/\r/g, '').trimEnd().split('\n').slice(-lines).join('\n');

export function buildExplainPrompt(input: {
  bug?: string;
  test: string;
  testFile?: { path: string; code: string };
  failureOutput: string;
  culprit: { short: string; subject: string; author: string };
  diff: string;
  bad: { short: string; subject: string };
  behind: number;
  attempts: FixAttempt[];
  maxAttempts: number;
}): string {
  const { bug, test, testFile, culprit, bad, behind, attempts, maxAttempts } = input;
  const diff =
    input.diff.length > MAX_DIFF_CHARS
      ? `${input.diff.slice(0, MAX_DIFF_CHARS)}\n... (diff cut off here; read the files for the rest)`
      : input.diff;
  const where =
    behind === 0
      ? 'which is the culprit itself'
      : `the newest broken commit, ${behind} commit${behind === 1 ? '' : 's'} after the culprit`;

  const parts = [
    `whobrokeit has proven which commit introduced a bug: the test below fails at that commit and passes at its parent. Explain why, and fix it.`,
  ];
  if (bug) parts.push(`## The bug report\n\n<bug_report>\n${bug.trim()}\n</bug_report>`);

  const testLines = [`## The test\n\nCommand, run from the repository root: \`${test}\``];
  if (testFile) testLines.push(`<test_file path="${testFile.path}">\n${testFile.code.trimEnd()}\n</test_file>`);
  testLines.push(`Output at the culprit:\n<output>\n${tail(input.failureOutput)}\n</output>`);
  parts.push(testLines.join('\n\n'));

  parts.push(
    `## The commit that introduced it\n\n${culprit.short} "${culprit.subject}" by ${culprit.author}\n\n<diff>\n${diff.trimEnd()}\n</diff>`,
  );

  parts.push(`## Your answer

The repository is checked out in the current directory at ${bad.short} ("${bad.subject}"), ${where}. You can read and search the files, but you cannot change them or run anything.

First, <why>: in 2 to 4 plain sentences, say what in this change causes the bug. Name the file and function, and say how the behavior changed. Write it for the developer who will read it on a pull request or issue. Write it in the language the bug report is written in (English if there is no report), whatever language you usually reply in.

Then <fix>: the smallest change to the code as it is now, at ${bad.short}, that makes the test pass. Write it as search-and-replace edits:

<why>...</why>
<fix>
<edit path="src/example.js">
<find>
lines copied exactly from the current file, enough of them to be unique
</find>
<replace>
the lines that replace them
</replace>
</edit>
</fix>

Rules for the fix:
- Change the code, never the tests.
- <find> must match the current file exactly, including indentation, and appear in it exactly once. Use one <edit> per place you change.
- Keep what the commit was trying to do: if it was a refactor, correct the refactor rather than reverting all of it.
- whobrokeit applies the edits and runs the test again. The fix is only shown as verified if the test passes.

If you see no safe fix, reply with <why> and then <nofix>one sentence saying why</nofix> instead of <fix>. Reply with these tags and nothing after them.`);

  if (attempts.length > 0) {
    parts.push('## Earlier fixes that did not work');
    attempts.forEach((attempt, i) => {
      const lines = [`### Fix ${i + 1}`];
      for (const edit of attempt.edits) {
        lines.push(`<edit path="${edit.path}">\n<find>\n${edit.find}\n</find>\n<replace>\n${edit.replace}\n</replace>\n</edit>`);
      }
      lines.push(`Result: ${attempt.problem}`);
      if (attempt.output?.trim()) lines.push(`Output:\n<output>\n${tail(attempt.output)}\n</output>`);
      parts.push(lines.join('\n'));
    });
    parts.push(
      `Send your <why> again (improved if you learned something) and a corrected <fix>. This is attempt ${attempts.length + 1} of ${maxAttempts}.`,
    );
  }

  return `${parts.join('\n\n')}\n`;
}
