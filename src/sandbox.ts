import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand, type RunResult } from './exec.js';
import { git, gitRaw } from './git.js';

export type Verdict = 'good' | 'bad' | 'skip';

export interface Evaluation {
  verdict: Verdict;
  run?: RunResult;
  reason?: string;
}

/** A file from the user's working copy that is dropped into every commit we test. */
export interface Overlay {
  path: string;
  content: Buffer;
}

/** `undefined` = detect automatically, `false` = never install, string = custom command. */
export type SetupOption = string | false | undefined;

/** Turns a finished run into a verdict. */
export type Classifier = (run: RunResult) => { verdict: Verdict; reason?: string };

/** The git bisect convention: 0 = good, 125 = skip, anything else = bad. */
export const exitCodeVerdict: Classifier = (run) => ({
  verdict: run.code === 0 ? 'good' : run.code === 125 ? 'skip' : 'bad',
  reason: run.timedOut ? 'timed out' : undefined,
});

const JS_LOCKFILES: Array<[file: string, command: string]> = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
  ['package-lock.json', 'npm ci --no-audit --no-fund'],
  ['npm-shrinkwrap.json', 'npm ci --no-audit --no-fund'],
];

// No lockfile is written: it would be an untracked file that outlives the commit it belongs to.
const NPM_INSTALL = 'npm install --no-audit --no-fund --no-package-lock';

const DEPENDENCY_FILES = [
  'package.json',
  ...JS_LOCKFILES.map(([file]) => file),
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'go.sum',
];

const hash = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex');

/**
 * A throwaway git worktree. Every check happens here, so the user's checkout,
 * branch and uncommitted changes are never touched.
 */
export class Sandbox {
  private installedKey: string | null = null;
  private readonly tools = new Map<string, boolean>();

  private constructor(
    readonly repoRoot: string,
    readonly dir: string,
    private readonly base: string,
    /** Files written into every commit before the test runs. Can change between runs. */
    public overlays: Overlay[],
    private readonly setup: SetupOption,
    private readonly timeoutMs: number,
  ) {}

  static async create(
    repoRoot: string,
    sha: string,
    overlays: Overlay[],
    setup: SetupOption,
    timeoutMs: number,
  ): Promise<Sandbox> {
    const base = await mkdtemp(join(tmpdir(), 'whobrokeit-'));
    const dir = join(base, 'wt');
    try {
      await git(['worktree', 'add', '--detach', '--force', dir, sha], repoRoot);
    } catch (err) {
      await rm(base, { recursive: true, force: true });
      throw err;
    }
    return new Sandbox(repoRoot, dir, base, overlays, setup, timeoutMs);
  }

  async checkout(sha: string): Promise<void> {
    await this.clean();
    await git(['checkout', '-q', '--detach', '--force', sha], this.dir);
  }

  /** Back to the pristine commit. Ignored files (like node_modules) survive. */
  async clean(): Promise<void> {
    for (const overlay of this.overlays) await rm(join(this.dir, overlay.path), { force: true });
    await git(['reset', '-q', '--hard'], this.dir);
    await git(['clean', '-fdq'], this.dir);
  }

  /** Runs the test on whatever commit is checked out and leaves the tree clean. */
  async evaluate(
    test: string,
    onSetup?: (command: string) => void,
    classify: Classifier = exitCodeVerdict,
  ): Promise<Evaluation> {
    try {
      for (const overlay of this.overlays) {
        const target = join(this.dir, overlay.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, overlay.content);
      }

      const setup = await this.pendingSetup();
      if (setup) {
        onSetup?.(setup.command);
        const result = await runCommand(setup.command, this.dir, this.timeoutMs, { untrusted: true });
        if (result.code !== 0) {
          this.installedKey = null;
          return { verdict: 'skip', run: result, reason: 'dependencies failed to install' };
        }
        this.installedKey = setup.key;
      }

      const run = await runCommand(test, this.dir, this.timeoutMs, { untrusted: true });
      return { ...classify(run), run };
    } finally {
      await this.clean();
    }
  }

  async dispose(): Promise<void> {
    await gitRaw(['worktree', 'remove', '--force', '--force', this.dir], this.repoRoot);
    await rm(this.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    await gitRaw(['worktree', 'prune'], this.repoRoot);
  }

  /** The install command to run now, or null if dependencies are already in place. */
  private async pendingSetup(): Promise<{ command: string; key: string | null } | null> {
    if (this.setup === false) return null;

    if (typeof this.setup === 'string') {
      const key = await this.dependencyFingerprint();
      if (key !== null && key === this.installedKey) return null;
      return { command: this.setup, key };
    }

    const auto = await this.detectJsInstall();
    if (!auto) return null;
    if (auto.key === this.installedKey && existsSync(join(this.dir, 'node_modules'))) return null;
    return auto;
  }

  private async detectJsInstall(): Promise<{ command: string; key: string } | null> {
    const raw = await readFile(join(this.dir, 'package.json'), 'utf8').catch(() => null);
    if (raw === null) return null;

    for (const [file, command] of JS_LOCKFILES) {
      const lock = await readFile(join(this.dir, file)).catch(() => null);
      // Only a committed lockfile counts. An ignored one is left over from an install at another
      // commit; trusting it kept that commit's dependencies in place for the whole search.
      if (!lock || !(await this.isTracked(file))) continue;
      if (await this.hasTool(command.split(' ')[0])) return { command, key: `${command}:${hash(lock)}` };
      // pnpm, yarn or bun is not installed: npm can still install from package.json.
      return { command: NPM_INSTALL, key: `${NPM_INSTALL}:${hash(lock)}` };
    }

    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
    const deps = {
      ...(pkg.dependencies as object | undefined),
      ...(pkg.devDependencies as object | undefined),
      ...(pkg.optionalDependencies as object | undefined),
    };
    if (Object.keys(deps).length === 0) return null;
    return { command: NPM_INSTALL, key: `${NPM_INSTALL}:${hash(JSON.stringify(deps))}` };
  }

  private async isTracked(file: string): Promise<boolean> {
    return (await gitRaw(['ls-files', '--error-unmatch', '--', file], this.dir)).code === 0;
  }

  private async hasTool(tool: string): Promise<boolean> {
    let found = this.tools.get(tool);
    if (found === undefined) {
      found = (await runCommand(`${tool} --version`, this.dir, 30_000)).code === 0;
      this.tools.set(tool, found);
    }
    return found;
  }

  private async dependencyFingerprint(): Promise<string | null> {
    const parts: string[] = [];
    for (const file of DEPENDENCY_FILES) {
      const content = await readFile(join(this.dir, file)).catch(() => null);
      if (content) parts.push(`${file}:${hash(content)}`);
    }
    return parts.length > 0 ? parts.join('|') : null;
  }
}
