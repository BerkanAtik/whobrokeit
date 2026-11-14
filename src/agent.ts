import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { UserError } from './errors.js';
import { runCommand, type RunResult } from './exec.js';

export interface AskOptions {
  timeoutMs: number;
  /** Things the agent is doing right now, like "reading src/cart.js". */
  onActivity?: (text: string) => void;
}

/** A coding agent that can read the repository and answer with text. It never gets to change files. */
export interface Agent {
  /** Shown to the user, e.g. "Claude Code". */
  readonly label: string;
  ask(prompt: string, cwd: string, options: AskOptions): Promise<string>;
}

const PRESETS = ['claude', 'codex'] as const;
type Preset = (typeof PRESETS)[number];

const LABELS: Record<Preset, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * `undefined` picks the first installed preset. A preset name picks that one.
 * Anything else is a custom command: it gets the prompt on stdin and answers on stdout.
 */
export async function pickAgent(choice: string | undefined, cwd: string, model?: string): Promise<Agent> {
  if (model !== undefined && !/^[\w.:/@[\]-]+$/.test(model)) throw new UserError(`--model ${model} is not a valid model name.`);

  if (choice !== undefined && !(PRESETS as readonly string[]).includes(choice)) {
    if (model !== undefined) throw new UserError('--model only works with --agent claude or --agent codex.');
    return customAgent(choice);
  }

  const candidates = choice ? [choice as Preset] : [...PRESETS];
  for (const name of candidates) {
    const probe = await runCommand(`${name} --version`, cwd, 30_000);
    if (probe.code === 0) return name === 'claude' ? claudeAgent(model) : codexAgent(model);
  }

  if (choice) {
    throw new UserError(`${LABELS[choice as Preset]} (\`${choice}\`) is not installed or not on your PATH.`);
  }
  throw new UserError(
    'Describing a bug in plain words needs Claude Code or Codex installed.',
    'Install one of them, use --agent "<command>" for another tool, or pass your own test with --test "<command>".',
  );
}

function claudeAgent(model?: string): Agent {
  const label = LABELS.claude;
  const command = [
    'claude -p',
    '--output-format stream-json --verbose',
    // Read-only tools, no hooks, plugins or MCP servers, nothing left in the session list.
    '--tools Read,Grep,Glob',
    '--permission-prompts none',
    '--safe-mode --strict-mcp-config',
    '--no-session-persistence',
    model ? `--model ${model}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    label,
    async ask(prompt, cwd, { timeoutMs, onActivity }) {
      let result: { text: string; isError: boolean; subtype?: string } | undefined;
      const lines = lineSplitter((line) => {
        if (!line.startsWith('{')) return;
        let event: StreamEvent;
        try {
          event = JSON.parse(line) as StreamEvent;
        } catch {
          return;
        }
        if (event.type === 'assistant') {
          for (const part of event.message?.content ?? []) {
            if (part.type === 'tool_use') onActivity?.(describeTool(part.name, part.input ?? {}, cwd));
          }
        } else if (event.type === 'result') {
          result = { text: event.result ?? '', isError: Boolean(event.is_error), subtype: event.subtype };
        }
      });

      // The user's `language` setting survives --safe-mode and beats the prompt's "write in the bug
      // report's language" rule, so a Turkish setting turned English reports into Turkish answers.
      const dir = await mkdtemp(join(tmpdir(), 'whobrokeit-claude-'));
      const settings = join(dir, 'settings.json');
      let run: RunResult;
      try {
        await writeFile(settings, JSON.stringify({ language: '' }));
        run = await runCommand(`${command} --settings "${settings}"`, cwd, timeoutMs, { input: prompt, onStdout: lines.push });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      lines.flush();
      failIfBroken(label, run, timeoutMs, result === undefined);
      if (result?.isError) {
        throw new UserError(`${label} stopped with an error: ${result.text || result.subtype || 'unknown error'}`);
      }
      return result?.text ?? '';
    },
  };
}

function codexAgent(model?: string): Agent {
  const label = LABELS.codex;
  return {
    label,
    async ask(prompt, cwd, { timeoutMs }) {
      const dir = await mkdtemp(join(tmpdir(), 'whobrokeit-codex-'));
      const answerFile = join(dir, 'answer.txt');
      try {
        const command = [
          'codex exec',
          '--sandbox read-only --skip-git-repo-check --ephemeral --color never',
          model ? `-m ${model}` : '',
          `-o "${answerFile}"`,
          '-',
        ]
          .filter(Boolean)
          .join(' ');
        const run = await runCommand(command, cwd, timeoutMs, { input: prompt });
        const answer = await readFile(answerFile, 'utf8').catch(() => null);
        failIfBroken(label, run, timeoutMs, answer === null);
        return answer ?? '';
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

function customAgent(command: string): Agent {
  return {
    label: command,
    async ask(prompt, cwd, { timeoutMs }) {
      let stdout = '';
      const run = await runCommand(command, cwd, timeoutMs, { input: prompt, onStdout: (text) => (stdout += text) });
      failIfBroken(command, run, timeoutMs, false);
      return stdout;
    },
  };
}

function failIfBroken(label: string, run: RunResult, timeoutMs: number, noAnswer: boolean): void {
  if (run.timedOut) {
    throw new UserError(`${label} did not answer within ${Math.round(timeoutMs / 60_000)} minutes.`);
  }
  if (run.code === 0 && !noAnswer) return;

  // Drop the JSON event stream; keep what a human would read.
  const said = run.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('{'))
    .slice(-8)
    .join('\n');
  throw new UserError(
    `${label} failed (exit code ${run.code}).${said ? `\n${said}` : ''}`,
    'Check that it works on its own in this terminal (is it logged in?), or pass your own test with --test.',
  );
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> };
}

function describeTool(name: string | undefined, input: Record<string, unknown>, cwd: string): string {
  const str = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '');
  const where = (path: string): string => {
    if (!path) return '';
    const rel = isAbsolute(path) ? relative(cwd, path) : path;
    if (!rel) return '.';
    return rel.startsWith('..') ? path : rel.split(sep).join('/');
  };
  switch (name) {
    case 'Read':
      return `reading ${where(str('file_path'))}`;
    case 'Grep':
      return `searching for "${str('pattern')}"${str('path') ? ` in ${where(str('path'))}` : ''}`;
    case 'Glob':
      return `looking for ${str('pattern')}${str('path') ? ` in ${where(str('path'))}` : ''}`;
    default:
      return `using ${name ?? 'a tool'}`;
  }
}

/** Turns arbitrary stdout chunks into whole lines. */
function lineSplitter(onLine: (line: string) => void): { push: (text: string) => void; flush: () => void } {
  let buffer = '';
  return {
    push: (text) => {
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        onLine(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
      }
    },
    flush: () => {
      if (buffer.trim()) onLine(buffer.trim());
      buffer = '';
    },
  };
}
