import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly detail: string,
    readonly code: number,
  ) {
    super(`git ${args.join(' ')} failed: ${detail.trim()}`);
    this.name = 'GitError';
  }
}

/**
 * The repository's hooks (husky, lefthook) are for the user's own checkouts. In ours, a
 * post-checkout hook would run for every commit tested, and one that fails would stop the search.
 */
export const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

/** Runs git and returns the result, whatever the exit code. Exit code 127 means git is missing. */
export function gitRaw(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...NO_HOOKS, ...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        // English messages, so bisect output can be parsed on any locale.
        env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const raw = (err as NodeJS.ErrnoException).code;
          code = typeof raw === 'number' ? raw : raw === 'ENOENT' ? 127 : 1;
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Runs git and returns trimmed stdout; throws GitError on failure. */
export async function git(args: string[], cwd: string): Promise<string> {
  const result = await gitRaw(args, cwd);
  if (result.code !== 0) throw new GitError(args, result.stderr || result.stdout, result.code);
  return result.stdout.trimEnd();
}
