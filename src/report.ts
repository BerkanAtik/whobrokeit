import type { CommitInfo, EngineEvent, Explanation, Outcome, Phase, ReproInfo, Verdict } from './engine.js';

export interface Palette {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
}

export function palette(enabled: boolean): Palette {
  const wrap =
    (open: number, close: number) =>
    (s: string): string =>
      enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

/** Color on a terminal. FORCE_COLOR (Node's rule: it wins over NO_COLOR, and 0 turns it off) works for CI logs. */
export function colorFor(stream: NodeJS.WriteStream): Palette {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '') return palette(force !== '0' && force !== 'false');
  return palette(Boolean(stream.isTTY) && !('NO_COLOR' in process.env));
}

const ANSI = /\x1b\[[0-9;]*m/g;
const width = (s: string): number => s.replace(ANSI, '').length;
const padEnd = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - width(s)));
const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = (now - Date.parse(iso)) / 1000;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(-Math.round(seconds / size), unit);
  }
  return 'just now';
}

const PHASE_TITLES: Record<Phase, string> = {
  'write-test': 'Writing a test that reproduces the bug',
  reproduce: 'Checking that the test fails now',
  'find-good': 'Walking back to find a commit where it still worked',
  bisect: 'Bisecting',
  proof: 'Proving it',
  explain: 'Explaining it and testing a fix',
};

function verdictLabel(verdict: Verdict, c: Palette): string {
  if (verdict === 'good') return c.green('✓ works');
  if (verdict === 'bad') return c.red('✗ broken');
  return c.yellow('↷ skipped');
}

const MAX_ACTIVITY_LINES = 8;

/** Live progress, one line per check. `subject` is the test command, or the bug report in quotes. */
export function liveReporter(
  stream: NodeJS.WriteStream,
  c: Palette,
  subject: { test: string } | { bug: string },
): (event: EngineEvent) => void {
  const columns = (): number => Math.min(stream.columns || 100, 120);
  let agent = 'the agent';
  let activity = 0;

  return (event) => {
    switch (event.type) {
      case 'start': {
        const what =
          'test' in subject
            ? `${c.dim('test:')} ${subject.test}`
            : `${c.dim('bug:')} ${truncate(`"${subject.bug.replace(/\s+/g, ' ').trim()}"`, columns() - 18)}`;
        stream.write(`\n${c.bold('whobrokeit')}  ${what}\n`);
        if (event.overlays.length > 0) {
          stream.write(c.dim(`  using ${event.overlays.join(', ')} from your working copy in every commit\n`));
        }
        if (event.dirty) stream.write(c.yellow('  note: uncommitted changes are ignored, only commits are tested\n'));
        if (event.shallow) stream.write(c.yellow('  note: this is a shallow clone, so history may be cut short\n'));
        break;
      }
      case 'phase': {
        let title = PHASE_TITLES[event.phase];
        if (event.phase === 'bisect') {
          const n = event.commits ?? 0;
          title = `Bisecting ${n} commit${n === 1 ? '' : 's'}${event.steps ? c.dim(` (~${event.steps} checks)`) : ''}`;
        }
        if (event.agent) {
          agent = event.agent;
          title += c.dim(` with ${agent}`);
        }
        stream.write(`\n${c.cyan('●')} ${title}\n`);
        break;
      }
      case 'agent': {
        activity = 0;
        const which = event.attempt === 1 ? '' : ` again (attempt ${event.attempt} of ${event.of})`;
        stream.write(c.dim(`  asking ${agent}${which}…\n`));
        break;
      }
      case 'activity': {
        activity++;
        if (activity <= MAX_ACTIVITY_LINES) stream.write(c.dim(`    ${truncate(event.text, columns() - 6)}\n`));
        else if (activity === MAX_ACTIVITY_LINES + 1) stream.write(c.dim('    …\n'));
        break;
      }
      case 'repro': {
        stream.write(`  wrote ${c.bold(event.repro.path)}  ${c.dim(`run: ${truncate(event.repro.command, columns() - 20)}`)}\n`);
        break;
      }
      case 'rejected': {
        stream.write(c.yellow(`  ↷ unusable reply: ${event.problem}\n`));
        break;
      }
      case 'fix': {
        stream.write(`  proposed a fix in ${c.bold(truncate(event.files.join(', '), columns() - 22))}\n`);
        break;
      }
      case 'setup': {
        stream.write(c.dim(`    installing dependencies at ${event.commit.short}: ${event.command}\n`));
        break;
      }
      case 'check': {
        const verdict = padEnd(verdictLabel(event.verdict, c), 11);
        const label = padEnd(event.label ? c.dim(truncate(event.label, 12)) : '', 13);
        const time = c.dim(formatDuration(event.durationMs));
        const note = event.note ? c.yellow(` (${event.note})`) : '';
        const fixed = 2 + 11 + 13 + event.commit.short.length + 2 + 2 + width(time) + width(note);
        const subjectLine = truncate(event.commit.subject, Math.max(10, columns() - fixed - 2));
        stream.write(`  ${verdict}${label}${c.yellow(event.commit.short)}  ${subjectLine}  ${time}${note}\n`);
        if (event.phase === 'write-test') {
          if (event.verdict === 'bad') stream.write(`  ${c.green('✓')} it fails here, so it catches the bug\n`);
          else if (event.verdict === 'good') stream.write(c.yellow("  ↷ it passes here, so it doesn't catch the bug\n"));
        }
        if (event.phase === 'explain') {
          if (event.verdict === 'good') stream.write(`  ${c.green('✓')} the test passes with the fix\n`);
          else stream.write(c.yellow(`  ↷ the test ${event.verdict === 'bad' ? 'still fails' : 'could not run'} with the fix\n`));
        }
        break;
      }
    }
  };
}

/** Where the agent-written test and the verified fix were saved, if anywhere. */
export interface SavedFiles {
  test?: string;
  fix?: string;
}

/** The final result, for humans. */
export function renderOutcome(outcome: Outcome, c: Palette, columns = 100, saved: SavedFiles = {}): string {
  const max = Math.min(columns, 100);
  const footer = c.dim(`${outcome.checks} check${outcome.checks === 1 ? '' : 's'} · ${formatDuration(outcome.durationMs)}`);

  switch (outcome.kind) {
    case 'found':
      return renderFound(outcome, c, max, footer, saved);
    case 'not-reproduced':
      return message(
        c,
        c.yellow('The test passes at ' + outcome.bad.short + ', so there is no bug to hunt.'),
        'whobrokeit needs a command that fails while the bug is present. Check the test really catches it.',
        excerpt(outcome.output),
      );
    case 'cannot-test':
      return message(
        c,
        c.yellow(`Could not run the test at ${outcome.bad.short}: ${outcome.reason}.`),
        'Fix the setup (or pass --setup / --no-setup) and try again.',
        excerpt(outcome.output),
      );
    case 'no-good-commit':
      return message(
        c,
        c.yellow(`The test fails all the way back to ${outcome.oldest.short}, the oldest commit.`),
        outcome.shallow
          ? 'This is a shallow clone. Run `git fetch --unshallow` and try again.'
          : outcome.untestable
            ? 'It fails wherever it can run, and older commits cannot run it at all. If you know a commit where it worked, try --good <commit>.'
            : 'Either the bug was always there, or the test cannot run on old code (it may use something that did not exist yet). Try --good <commit>.',
      );
    case 'good-fails':
      return message(
        c,
        c.yellow(`The test also fails at --good ${outcome.good.short}.`),
        'Pick an older commit where it really worked, or leave out --good and let whobrokeit find one.',
        excerpt(outcome.output),
      );
    case 'ambiguous':
      return message(
        c,
        c.yellow(`Narrowed it down to ${outcome.candidates.length} commits, but some of them could not be tested:`),
        outcome.candidates.map((x) => `  ${c.yellow(x.short)}  ${x.subject}`).join('\n'),
      );
    case 'no-repro': {
      const last = outcome.attempts.at(-1);
      const advice =
        'Say what you did, what you expected and what happened instead, then try again. Or pass your own test with --test.';
      return message(
        c,
        c.yellow(
          outcome.gaveUp
            ? `${outcome.agent} could not write a test for this bug at ${outcome.bad.short}.`
            : `Could not reproduce the bug at ${outcome.bad.short}.`,
        ),
        outcome.gaveUp
          ? `It said: ${outcome.reason}\n${advice}`
          : `${outcome.reason}${last ? ` The last one: ${last.problem}` : ''}\n${advice}`,
        last?.output ? excerpt(last.output) : [],
      );
    }
  }

  function message(p: Palette, headline: string, detail: string, output: string[] = []): string {
    const tail = output.length > 0 ? `\n${p.dim('Test output:')}\n${output.map((l) => p.dim(`  ${l}`)).join('\n')}\n` : '';
    return `\n${headline}\n${detail}\n${tail}\n${footer}\n`;
  }
}

function renderFound(
  outcome: Extract<Outcome, { kind: 'found' }>,
  c: Palette,
  max: number,
  footer: string,
  saved: SavedFiles,
): string {
  const inner = max - 6;
  const { culprit, parent } = outcome;

  const lines: string[] = [
    c.bold(outcome.proven ? 'Found it.' : 'Probably this one, but the proof did not hold.'),
    '',
    `${c.yellow(culprit.short)}  ${c.bold(truncate(culprit.subject, inner - culprit.short.length - 2))}`,
    c.dim(truncate(`${culprit.author} · ${timeAgo(culprit.date)}`, inner)),
    '',
    ...fileLines(culprit, c, inner),
    '',
  ];

  if (outcome.proven) {
    lines.push(`${c.red('✗')} broken at ${c.yellow(culprit.short)}`, `${c.green('✓')} works at its parent ${c.yellow(parent.short)}`);
  } else {
    lines.push(
      `${verdictLabel(outcome.proof.culprit, c)} on a re-run at ${c.yellow(culprit.short)}`,
      `${verdictLabel(outcome.proof.parent, c)} on a re-run at its parent ${c.yellow(parent.short)}`,
      c.yellow('The test gave different answers on re-runs. It may be flaky.'),
    );
  }

  lines.push('', footer);

  const boxWidth = Math.min(inner, Math.max(...lines.map(width)));
  const border = outcome.proven ? c.green : c.yellow;
  const body = lines.map((line) => `${border('│')}  ${padEnd(line, boxWidth)}  ${border('│')}`);
  const box = [border(`╭${'─'.repeat(boxWidth + 4)}╮`), ...body, border(`╰${'─'.repeat(boxWidth + 4)}╯`)].join('\n');

  const output = excerpt(outcome.failureOutput);
  const tail =
    output.length > 0
      ? `\n${c.dim(`Test output at ${culprit.short}:`)}\n${output.map((l) => c.dim(`  ${truncate(l, max - 2)}`)).join('\n')}\n`
      : '';

  const explained = outcome.explanation ? explanationLines(outcome.explanation, outcome.bad.short, c, max, saved.fix) : '';
  const repro = outcome.repro ? reproLine(outcome.repro, c, saved.test) : '';
  return `\n${box}\n${tail}${explained}\n${repro}${c.dim('See the change:')} git show ${culprit.short}\n`;
}

const MAX_PATCH_LINES = 24;

function explanationLines(explanation: Explanation, badShort: string, c: Palette, max: number, savedFix?: string): string {
  const out: string[] = [];
  if (explanation.why) {
    out.push('', `${c.bold('Why it broke')}  ${c.dim(`(${explanation.agent})`)}`);
    // Markdown code spans read fine in a report, but a terminal would show the raw backticks.
    const plain = explanation.why.replace(/`([^`\n]+)`/g, '$1');
    out.push(...wrap(plain, max - 2).map((line) => `  ${line}`));
  }
  const { fix } = explanation;
  if (fix?.verified) {
    out.push('', `${c.bold('Suggested fix')}  ${c.green('✓')} ${c.dim(`the test passes with it at ${badShort}`)}`);
    const lines = patchLines(fix.patch, c, max - 2);
    out.push(...lines.slice(0, MAX_PATCH_LINES).map((line) => `  ${line}`));
    if (lines.length > MAX_PATCH_LINES) out.push(c.dim(`  … ${lines.length - MAX_PATCH_LINES} more lines`));
    if (savedFix) out.push('', `${c.dim('Apply it:')} git apply ${savedFix}`);
  } else if (explanation.note) {
    out.push('', c.yellow(`No verified fix. ${explanation.note}`));
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

/** A unified diff, colored, without git's header lines. */
function patchLines(patch: string, c: Palette, max: number): string[] {
  const out: string[] = [];
  for (const line of patch.replace(/\r/g, '').trimEnd().split('\n')) {
    if (/^(diff --git|index |--- |new file|deleted file|similarity|rename )/.test(line)) continue;
    if (line.startsWith('+++ ')) out.push(c.bold(line.replace(/^\+\+\+ (b\/)?/, '')));
    else if (line.startsWith('@@')) out.push(c.cyan(truncate(line, max)));
    else if (line.startsWith('+')) out.push(c.green(truncate(line, max)));
    else if (line.startsWith('-')) out.push(c.red(truncate(line, max)));
    else out.push(c.dim(truncate(line, max)));
  }
  return out;
}

function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function reproLine(repro: ReproInfo, c: Palette, savedTest?: string): string {
  const lines = repro.code.replace(/\r/g, '').trimEnd().split('\n').length;
  return `${c.dim(`The test ${repro.agent} wrote (${lines} lines):`)} ${savedTest ?? repro.path}\n`;
}

function fileLines(commit: CommitInfo, c: Palette, inner: number): string[] {
  const shown = commit.files.slice(0, 6).map((file) => {
    const stat =
      file.added === null ? c.dim('binary') : `${c.green(`+${file.added}`)} ${c.red(`−${file.removed}`)}`;
    return `${truncate(file.path, inner - 14)}  ${stat}`;
  });
  if (commit.files.length > 6) shown.push(c.dim(`and ${commit.files.length - 6} more files`));
  return shown;
}

const MARKER_LINE = /WHOBROKEIT_BUG:/;
const ERROR_LINE = /(AssertionError|\bError\b|expected|received|!==|panicked)/i;
const FAILURE_LINE = /(✖|✗|×|not ok|\bFAIL|failed)/i;
const NOISE_LINE = /^\s*(error: \|-?|---|\.\.\.|duration_ms:.*|type: '.*'|location: .*|failureType: .*)$/;

/** The interesting part of a test log: the first error message, else the first failure, else the tail. */
export function excerpt(output: string, max = 8): string[] {
  const lines = output
    // Test runners color their output when FORCE_COLOR is set (common in CI).
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !NOISE_LINE.test(line));
  let from = lines.findIndex((line) => MARKER_LINE.test(line));
  if (from === -1) from = lines.findIndex((line) => ERROR_LINE.test(line));
  if (from === -1) from = lines.findIndex((line) => FAILURE_LINE.test(line));
  if (from === -1) from = Math.max(0, lines.length - max);
  return lines.slice(from, from + max);
}

/** A Markdown report, for issues and PRs. */
export function toMarkdown(outcome: Outcome, testCommand: string): string {
  const command = outcome.repro?.command ?? testCommand;
  const meta = `_Test: \`${command}\` · ${outcome.checks} checks · ${formatDuration(outcome.durationMs)}_`;
  const reproSection = outcome.repro
    ? [
        `## The test ${outcome.repro.agent} wrote`,
        '',
        `\`${outcome.repro.path}\`, run with \`${outcome.repro.command}\`. It fails at the culprit and passes at its parent.`,
        '',
        `${fence(outcome.repro.code)}${fenceLanguage(outcome.repro.path)}`,
        outcome.repro.code.trimEnd(),
        fence(outcome.repro.code),
        '',
      ].join('\n')
    : '';
  if (outcome.kind !== 'found') {
    const plain = renderOutcome(outcome, palette(false)).trim();
    return `# whobrokeit report\n\n${plain}\n\n${meta}\n`;
  }

  const { culprit, parent } = outcome;
  const mark = (v: Verdict): string => (v === 'good' ? '✓ works' : v === 'bad' ? '✗ broken' : '↷ skipped');
  const files = culprit.files
    .map((f) => `- \`${f.path}\` ${f.added === null ? '(binary)' : `+${f.added} −${f.removed}`}`)
    .join('\n');
  const output = excerpt(outcome.failureOutput, 30).join('\n');
  const explanation = outcome.explanation;
  const explainSection: string[] = [];
  if (explanation?.why) explainSection.push('## Why it broke', '', explanation.why, '', `_Explained by ${explanation.agent}._`, '');
  if (explanation?.fix?.verified) {
    explainSection.push(
      '## Suggested fix',
      '',
      `The test passes at \`${outcome.bad.short}\` with this patch applied. Review it before merging.`,
      '',
      `${fence(explanation.fix.patch)}diff`,
      explanation.fix.patch.trimEnd(),
      fence(explanation.fix.patch),
      '',
    );
  } else if (explanation?.note) {
    explainSection.push(`> No verified fix. ${explanation.note}`, '');
  }

  return [
    '# whobrokeit report',
    '',
    `**Introduced by** \`${culprit.short}\` ${culprit.subject}`,
    `**Author** ${culprit.author}, ${culprit.date.slice(0, 10)} (${timeAgo(culprit.date)})`,
    '',
    '## Proof',
    '',
    '| Commit | Result |',
    '| --- | --- |',
    `| \`${culprit.short}\` (culprit) | ${mark(outcome.proof.culprit)} |`,
    `| \`${parent.short}\` (parent) | ${mark(outcome.proof.parent)} |`,
    '',
    ...(outcome.proven ? [] : ['> The re-runs disagreed with the bisect. The test may be flaky.', '']),
    ...explainSection,
    '## Files changed',
    '',
    files || '_No file changes (merge commit?)._',
    '',
    '## Test output at the culprit',
    '',
    '```text',
    output,
    '```',
    '',
    reproSection,
    meta,
    '',
  ].join('\n');
}

/** A code fence longer than any run of backticks in the content. */
function fence(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

function fenceLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
    py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java', kt: 'kotlin', php: 'php',
    sh: 'bash', c: 'c', cpp: 'cpp', cs: 'csharp', swift: 'swift', ex: 'elixir', exs: 'elixir',
  };
  return map[ext] ?? '';
}
