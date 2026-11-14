import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { git, gitRaw } from './git.js';
import { Sandbox, type Evaluation, type Overlay, type SetupOption, type Verdict } from './sandbox.js';

export type { Verdict } from './sandbox.js';

export interface CommitRef {
  sha: string;
  short: string;
  subject: string;
}

export interface FileChange {
  path: string;
  added: number | null;
  removed: number | null;
}

export interface CommitInfo extends CommitRef {
  author: string;
  email: string;
  date: string;
  files: FileChange[];
}

export type Phase = 'reproduce' | 'find-good' | 'bisect' | 'proof';

export type EngineEvent =
  | { type: 'start'; repoRoot: string; bad: CommitRef; dirty: boolean; shallow: boolean; overlays: string[] }
  | { type: 'phase'; phase: Phase; commits?: number; steps?: number }
  | { type: 'setup'; commit: CommitRef; command: string }
  | {
      type: 'check';
      phase: Phase;
      commit: CommitRef;
      label?: string;
      verdict: Verdict;
      durationMs: number;
      note?: string;
    };

export interface EngineOptions {
  /** Directory inside the repository. */
  cwd: string;
  /** Shell command: exit 0 = works, 125 = can't tell, anything else = broken. */
  test: string;
  good?: string;
  bad?: string;
  setup?: SetupOption;
  /** Files from the working copy to drop into every tested commit. */
  withFiles?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
}

interface Stats {
  checks: number;
  durationMs: number;
}

export type Outcome =
  | ({
      kind: 'found';
      culprit: CommitInfo;
      parent: CommitRef;
      good: CommitRef;
      bad: CommitRef;
      /** True when the culprit fails and its parent passes on a fresh re-run. */
      proven: boolean;
      proof: { culprit: Verdict; parent: Verdict };
      failureOutput: string;
    } & Stats)
  | ({ kind: 'not-reproduced'; bad: CommitRef; output: string } & Stats)
  | ({ kind: 'cannot-test'; bad: CommitRef; output: string; reason: string } & Stats)
  | ({ kind: 'no-good-commit'; bad: CommitRef; oldest: CommitRef; shallow: boolean } & Stats)
  | ({ kind: 'good-fails'; good: CommitRef; output: string } & Stats)
  | ({ kind: 'ambiguous'; candidates: CommitRef[] } & Stats);

/** A problem the user can fix; printed without a stack trace. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// Git 2.4x+ quotes the term ("the first 'bad' commit"); older versions don't.
const FIRST_BAD = /^([0-9a-f]{40,64}) is the first '?bad'? commit/m;
const ONLY_SKIPPED = /only '?skip'?ped commits left to test/;

export async function findCulprit(opts: EngineOptions): Promise<Outcome> {
  const started = Date.now();
  const emit = opts.onEvent ?? (() => {});

  const repoRoot = await resolveRepoRoot(opts.cwd);
  const badInput = opts.bad ?? 'HEAD';
  const badSha = await resolveCommit(repoRoot, badInput, '--bad');
  const givenGood = opts.good ? await resolveCommit(repoRoot, opts.good, '--good') : undefined;
  if (givenGood) {
    const ancestor = await gitRaw(['merge-base', '--is-ancestor', givenGood, badSha], repoRoot);
    if (ancestor.code !== 0) {
      throw new UserError(`--good ${opts.good} is not an ancestor of ${badInput}.`);
    }
  }
  const overlays = await readOverlays(opts.cwd, repoRoot, opts.withFiles ?? []);

  const refs = new Map<string, CommitRef>();
  const ref = async (sha: string): Promise<CommitRef> => {
    let known = refs.get(sha);
    if (!known) {
      const [full, short, subject] = (await git(['show', '-s', '--format=%H%x1f%h%x1f%s', sha], repoRoot)).split('\x1f');
      known = { sha: full, short, subject };
      refs.set(sha, known);
    }
    return known;
  };

  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'], repoRoot)).length > 0;
  const shallow = (await git(['rev-parse', '--is-shallow-repository'], repoRoot)) === 'true';
  const bad = await ref(badSha);
  emit({ type: 'start', repoRoot, bad, dirty, shallow, overlays: overlays.map((o) => o.path) });

  const sandbox = await Sandbox.create(
    repoRoot,
    badSha,
    overlays,
    opts.setup,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let checks = 0;
  const stats = (): Stats => ({ checks, durationMs: Date.now() - started });

  const check = async (phase: Phase, sha: string, label?: string, checkout = true): Promise<Evaluation> => {
    opts.signal?.throwIfAborted();
    if (checkout) await sandbox.checkout(sha);
    const commit = await ref(sha);
    const evaluation = await sandbox.evaluate(opts.test, (command) => emit({ type: 'setup', commit, command }));
    checks++;
    opts.signal?.throwIfAborted();
    emit({
      type: 'check',
      phase,
      commit,
      label,
      verdict: evaluation.verdict,
      durationMs: evaluation.run?.durationMs ?? 0,
      note: evaluation.reason,
    });
    return evaluation;
  };

  try {
    // 1. The test must fail where the user says the bug is.
    emit({ type: 'phase', phase: 'reproduce' });
    const atBad = await check('reproduce', badSha, badInput, false);
    if (atBad.verdict === 'good') {
      return { kind: 'not-reproduced', bad, output: atBad.run?.output ?? '', ...stats() };
    }
    if (atBad.verdict === 'skip') {
      return {
        kind: 'cannot-test',
        bad,
        output: atBad.run?.output ?? '',
        reason: atBad.reason ?? 'the test exited with 125 ("skip")',
        ...stats(),
      };
    }

    // 2. Find a commit where it still worked: walk back 1, 2, 4, 8... commits.
    emit({ type: 'phase', phase: 'find-good' });
    let lastBad = badSha;
    let good: string | undefined;

    if (givenGood) {
      const evaluation = await check('find-good', givenGood, opts.good);
      if (evaluation.verdict !== 'good') {
        return { kind: 'good-fails', good: await ref(givenGood), output: evaluation.run?.output ?? '', ...stats() };
      }
      good = givenGood;
    } else {
      const root = (await git(['rev-list', '--first-parent', '--max-parents=0', badSha], repoRoot)).split('\n')[0];
      if (root === badSha) return { kind: 'no-good-commit', bad, oldest: bad, shallow, ...stats() };

      for (let n = 1; ; n *= 2) {
        const probe = await gitRaw(['rev-parse', '--verify', '--quiet', `${badSha}~${n}^{commit}`], repoRoot);
        const sha = probe.code === 0 ? probe.stdout.trim() : root;
        const distance =
          probe.code === 0 ? n : Number(await git(['rev-list', '--count', '--first-parent', `${root}..${badSha}`], repoRoot));
        const evaluation = await check('find-good', sha, `${badInput}~${distance}`);
        if (evaluation.verdict === 'good') {
          good = sha;
          break;
        }
        if (evaluation.verdict === 'bad') lastBad = sha;
        if (sha === root) return { kind: 'no-good-commit', bad, oldest: await ref(root), shallow, ...stats() };
      }
    }

    // 3. Binary search between the last good and the first known bad commit.
    const commits = Number(await git(['rev-list', '--count', `${good}..${lastBad}`], repoRoot));
    let step = await gitRaw(['bisect', 'start', lastBad, good], sandbox.dir);
    const roughly = /roughly (\d+) step/.exec(step.stdout);
    emit({ type: 'phase', phase: 'bisect', commits, steps: roughly ? Number(roughly[1]) + 1 : 1 });

    let culpritSha: string;
    // Bisect needs ~log2(n) steps; anything far beyond that means we misread git's output.
    const maxSteps = 2 * Math.ceil(Math.log2(commits + 1)) + 10;
    for (let steps = 0; ; steps++) {
      if (steps > maxSteps) {
        throw new Error(`git bisect did not finish after ${steps} steps. Last output:\n${step.stdout.trim()}`);
      }
      const text = `${step.stdout}\n${step.stderr}`;
      const done = FIRST_BAD.exec(text);
      if (done) {
        culpritSha = done[1];
        break;
      }
      if (ONLY_SKIPPED.test(text)) {
        const shas = [...text.matchAll(/^([0-9a-f]{40})$/gm)].map((m) => m[1]);
        await gitRaw(['bisect', 'reset'], sandbox.dir);
        return { kind: 'ambiguous', candidates: await Promise.all(shas.map(ref)), ...stats() };
      }
      if (step.code !== 0) throw new Error(`git bisect failed:\n${text.trim()}`);

      const head = await git(['rev-parse', 'HEAD'], sandbox.dir);
      const evaluation = await check('bisect', head, undefined, false);
      step = await gitRaw(['bisect', evaluation.verdict], sandbox.dir);
    }
    await gitRaw(['bisect', 'reset'], sandbox.dir);

    // 4. Proof: re-run on the culprit and on its parent.
    emit({ type: 'phase', phase: 'proof' });
    const parentSha = await git(['rev-parse', `${culpritSha}^`], repoRoot);
    const atCulprit = await check('proof', culpritSha, 'culprit');
    const atParent = await check('proof', parentSha, 'parent');

    return {
      kind: 'found',
      culprit: await commitInfo(repoRoot, culpritSha, parentSha),
      parent: await ref(parentSha),
      good: await ref(good),
      bad,
      proven: atCulprit.verdict === 'bad' && atParent.verdict === 'good',
      proof: { culprit: atCulprit.verdict, parent: atParent.verdict },
      failureOutput: atCulprit.run?.output ?? '',
      ...stats(),
    };
  } finally {
    await sandbox.dispose();
  }
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  const result = await gitRaw(['rev-parse', '--show-toplevel'], cwd);
  if (result.code === 127) throw new UserError('git is not installed or not on your PATH.');
  if (result.code !== 0) {
    throw new UserError('This folder is not inside a git repository.', 'Run whobrokeit from the repo you want to investigate.');
  }
  return result.stdout.trim();
}

async function resolveCommit(repoRoot: string, input: string, flag: string): Promise<string> {
  const result = await gitRaw(['rev-parse', '--verify', '--quiet', `${input}^{commit}`], repoRoot);
  if (result.code !== 0) throw new UserError(`${flag} ${input} is not a commit in this repository.`);
  return result.stdout.trim();
}

async function readOverlays(cwd: string, repoRoot: string, files: string[]): Promise<Overlay[]> {
  const root = resolve(repoRoot);
  return Promise.all(
    files.map(async (file) => {
      const absolute = resolve(cwd, file);
      const rel = relative(root, absolute);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        throw new UserError(`--with ${file} must be a file inside the repository.`);
      }
      const content = await readFile(absolute).catch(() => null);
      if (!content) throw new UserError(`--with ${file}: file not found.`);
      return { path: rel.split(sep).join('/'), content };
    }),
  );
}

async function commitInfo(repoRoot: string, sha: string, parent: string): Promise<CommitInfo> {
  const [full, short, subject, author, email, date] = (
    await git(['show', '-s', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI', sha], repoRoot)
  ).split('\x1f');
  const numstat = await git(['diff', '--numstat', parent, sha], repoRoot);
  const files = numstat
    ? numstat.split('\n').map((line) => {
        const [added, removed, ...path] = line.split('\t');
        return {
          path: path.join('\t'),
          added: added === '-' ? null : Number(added),
          removed: removed === '-' ? null : Number(removed),
        };
      })
    : [];
  return { sha: full, short, subject, author, email, date, files };
}
