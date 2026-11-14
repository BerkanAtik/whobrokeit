import type { CommitInfo, EngineEvent, Outcome, Phase, Verdict } from './engine.js';

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

export function colorFor(stream: NodeJS.WriteStream): Palette {
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
  reproduce: 'Checking that the test fails now',
  'find-good': 'Walking back to find a commit where it still worked',
  bisect: 'Bisecting',
  proof: 'Proving it',
};

function verdictLabel(verdict: Verdict, c: Palette): string {
  if (verdict === 'good') return c.green('✓ works');
  if (verdict === 'bad') return c.red('✗ broken');
  return c.yellow('↷ skipped');
}

/** Live progress, one line per check. */
export function liveReporter(stream: NodeJS.WriteStream, c: Palette, testCommand: string): (event: EngineEvent) => void {
  const columns = (): number => Math.min(stream.columns || 100, 120);

  return (event) => {
    switch (event.type) {
      case 'start': {
        stream.write(`\n${c.bold('whobrokeit')}  ${c.dim('test:')} ${testCommand}\n`);
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
        stream.write(`\n${c.cyan('●')} ${title}\n`);
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
        const subject = truncate(event.commit.subject, Math.max(10, columns() - fixed - 2));
        stream.write(`  ${verdict}${label}${c.yellow(event.commit.short)}  ${subject}  ${time}${note}\n`);
        break;
      }
    }
  };
}

/** The final result, for humans. */
export function renderOutcome(outcome: Outcome, c: Palette, columns = 100): string {
  const max = Math.min(columns, 100);
  const footer = c.dim(`${outcome.checks} check${outcome.checks === 1 ? '' : 's'} · ${formatDuration(outcome.durationMs)}`);

  switch (outcome.kind) {
    case 'found':
      return renderFound(outcome, c, max, footer);
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
  }

  function message(p: Palette, headline: string, detail: string, output: string[] = []): string {
    const tail = output.length > 0 ? `\n${p.dim('Test output:')}\n${output.map((l) => p.dim(`  ${l}`)).join('\n')}\n` : '';
    return `\n${headline}\n${detail}\n${tail}\n${footer}\n`;
  }
}

function renderFound(outcome: Extract<Outcome, { kind: 'found' }>, c: Palette, max: number, footer: string): string {
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

  return `\n${box}\n${tail}\n${c.dim('See the change:')} git show ${culprit.short}\n`;
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

const ERROR_LINE = /(AssertionError|\bError\b|expected|received|!==|panicked)/i;
const FAILURE_LINE = /(✖|✗|×|not ok|\bFAIL|failed)/i;
const NOISE_LINE = /^\s*(error: \|-?|---|\.\.\.|duration_ms:.*|type: '.*'|location: .*|failureType: .*)$/;

/** The interesting part of a test log: the first error message, else the first failure, else the tail. */
export function excerpt(output: string, max = 8): string[] {
  const lines = output
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !NOISE_LINE.test(line));
  let from = lines.findIndex((line) => ERROR_LINE.test(line));
  if (from === -1) from = lines.findIndex((line) => FAILURE_LINE.test(line));
  if (from === -1) from = Math.max(0, lines.length - max);
  return lines.slice(from, from + max);
}

/** A Markdown report, for issues and PRs. */
export function toMarkdown(outcome: Outcome, testCommand: string): string {
  const meta = `_Test: \`${testCommand}\` · ${outcome.checks} checks · ${formatDuration(outcome.durationMs)}_`;
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
    outcome.proven ? '' : '> The re-runs disagreed with the bisect. The test may be flaky.\n',
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
    meta,
    '',
  ].join('\n');
}
