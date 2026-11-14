import { spawn, type ChildProcess } from 'node:child_process';

export interface RunResult {
  code: number;
  /** stdout and stderr interleaved, capped at the last 200 KB. */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  /** Written to stdin, which is then closed. Without it, stdin is empty. */
  input?: string;
  /** Called with stdout as it arrives (whole characters, any chunking). */
  onStdout?: (text: string) => void;
  /**
   * The command is the code under test or a test an agent wrote, not something we trust. It
   * gets no AI keys or GitHub tokens, so a test cannot simply read them from its environment.
   */
  untrusted?: boolean;
}

/** Credentials whobrokeit or its agent may need, but the tested code never does. */
const SECRET_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
];

const MAX_OUTPUT = 200_000;
const active = new Set<ChildProcess>();

/** Runs a shell command and captures combined stdout/stderr. Never rejects. */
export function runCommand(command: string, cwd: string, timeoutMs: number, options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', NO_COLOR: '1' };
    delete env.FORCE_COLOR;
    // Set when whobrokeit itself runs under `node --test`; a nested `node --test` would then exit 0.
    delete env.NODE_TEST_CONTEXT;
    if (options.untrusted) {
      for (const name of Object.keys(env)) {
        if (SECRET_ENV.includes(name.toUpperCase())) delete env[name];
      }
    }

    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so a timeout can kill the whole tree.
      detached: process.platform !== 'win32',
    });
    active.add(child);

    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {}); // the command may exit without reading it
      child.stdin.end(options.input);
    }

    let output = '';
    const collect = (text: string): void => {
      output += text;
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout?.setEncoding('utf8').on('data', (text: string) => {
      collect(text);
      options.onStdout?.(text);
    });
    child.stderr?.setEncoding('utf8').on('data', collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (code: number, extra = ''): void => {
      clearTimeout(timer);
      active.delete(child);
      resolve({ code, output: output + extra, timedOut, durationMs: Date.now() - started });
    };
    child.on('error', (err) => finish(127, `\n${err.message}`));
    child.on('close', (code) => finish(code ?? 1));
  });
}

export function killActiveCommands(): void {
  for (const child of active) killTree(child);
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
