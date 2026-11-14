import { spawn, type ChildProcess } from 'node:child_process';

export interface RunResult {
  code: number;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_OUTPUT = 200_000;
const active = new Set<ChildProcess>();

/** Runs a shell command and captures combined stdout/stderr. Never rejects. */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', NO_COLOR: '1' };
    delete env.FORCE_COLOR;
    // Set when whobrokeit itself runs under `node --test`; a nested `node --test` would then exit 0.
    delete env.NODE_TEST_CONTEXT;

    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so a timeout can kill the whole tree.
      detached: process.platform !== 'win32',
    });
    active.add(child);

    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

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
