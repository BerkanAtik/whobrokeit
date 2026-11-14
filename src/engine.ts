import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Agent } from './agent.js';
import { UserError } from './errors.js';
import { applyEdits, buildExplainPrompt, parseExplanation, type FixAttempt } from './explain.js';
import { git, gitRaw } from './git.js';
import {
  buildPrompt,
  classifyRepro,
  explainMiss,
  normalizeReproPath,
  parseReply,
  type Attempt,
  type Repro,
} from './repro.js';
import { Sandbox, type Classifier, type Evaluation, type Overlay, type SetupOption, type Verdict } from './sandbox.js';

export { UserError } from './errors.js';
export type { Attempt, Repro } from './repro.js';
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

export type Phase = 'write-test' | 'reproduce' | 'find-good' | 'bisect' | 'proof' | 'explain';

export type EngineEvent =
  | { type: 'start'; repoRoot: string; bad: CommitRef; dirty: boolean; shallow: boolean; overlays: string[] }
  | { type: 'phase'; phase: Phase; commits?: number; steps?: number; agent?: string }
  | { type: 'setup'; commit: CommitRef; command: string }
  /** The agent was asked for attempt `attempt` of `of`. */
  | { type: 'agent'; attempt: number; of: number }
  | { type: 'activity'; text: string }
  | { type: 'repro'; attempt: number; repro: Repro }
  /** The agent's reply could not be used at all. */
  | { type: 'rejected'; attempt: number; problem: string }
  /** The agent proposed a fix touching these files; it is about to be tested. */
  | { type: 'fix'; attempt: number; files: string[] }
  | {
      type: 'check';
      phase: Phase;
      commit: CommitRef;
      label?: string;
      verdict: Verdict;
      durationMs: number;
      note?: string;
    };

export interface DescribeOptions {
  /** The bug in plain words, as a user would report it. */
  bug: string;
  agent: Agent;
  /** How many scripts the agent may try before giving up. Default 3. */
  attempts?: number;
  agentTimeoutMs?: number;
}

export interface ExplainOptions {
  agent: Agent;
  /** The bug in plain words, if the user gave one. In describe mode, the description is used. */
  bug?: string;
  /** How many fixes the agent may try. Default 2. */
  attempts?: number;
  agentTimeoutMs?: number;
}

export interface EngineOptions {
  /** Directory inside the repository. */
  cwd: string;
  /** Shell command: exit 0 = works, 125 = can't tell, anything else = broken. */
  test?: string;
  /** Instead of `test`: describe the bug and let an agent write the test. */
  describe?: DescribeOptions;
  /** Once the culprit is proven, have an agent explain it and propose a fix, then test the fix. */
  explain?: ExplainOptions;
  good?: string;
  bad?: string;
  setup?: SetupOption;
  /** Files from the working copy to drop into every tested commit. */
  withFiles?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
}

/** The test an agent wrote, once it has been seen failing at the bad commit. */
export interface ReproInfo extends Repro {
  agent: string;
  /** Which attempt worked. */
  attempts: number;
}

export interface SuggestedFix {
  /** A unified diff against the bad commit. Apply it from the repository root with `git apply`. */
  patch: string;
  files: string[];
  /** The test passed at the bad commit with this patch applied. */
  verified: boolean;
  /** How many fixes the agent needed. */
  attempts: number;
}

export interface Explanation {
  agent: string;
  /** Why the culprit causes the bug, in a few sentences. */
  why?: string;
  /** Only set when the test passed with it. */
  fix?: SuggestedFix;
  /** Why there is no fix, or what went wrong while asking for one. */
  note?: string;
}

interface Stats {
  checks: number;
  durationMs: number;
  repro?: ReproInfo;
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
      explanation?: Explanation;
    } & Stats)
  | ({ kind: 'not-reproduced'; bad: CommitRef; output: string } & Stats)
  | ({ kind: 'cannot-test'; bad: CommitRef; output: string; reason: string } & Stats)
  | ({
      kind: 'no-good-commit';
      bad: CommitRef;
      oldest: CommitRef;
      shallow: boolean;
      /** Some older commits could not run the test at all. */
      untestable: boolean;
      /** What the test printed at the oldest commit. */
      output: string;
    } & Stats)
  /** The test fails at the given --good commit (`bad`), or cannot run there (`skip`). */
  | ({ kind: 'good-fails'; good: CommitRef; verdict: 'bad' | 'skip'; reason?: string; output: string } & Stats)
  | ({ kind: 'ambiguous'; candidates: CommitRef[] } & Stats)
  | ({
      kind: 'no-repro';
      bad: CommitRef;
      agent: string;
      /** True when the agent itself said the bug can't be reproduced. */
      gaveUp: boolean;
      reason: string;
      attempts: Attempt[];
    } & Stats);

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Agent-written repros are meant to take seconds; this mostly covers a first build. */
const REPRO_TIMEOUT_MS = 5 * 60 * 1000;
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;
// Git 2.4x+ quotes the term ("the first 'bad' commit"); older versions don't.
const FIRST_BAD = /^([0-9a-f]{40,64}) is the first '?bad'? commit/m;
const ONLY_SKIPPED = /only '?skip'?ped commits left to test/;
/** With log.showSignature set, `git show` prints a signature check before the format. */
const NO_SIGNATURE = '--no-show-signature';

export async function findCulprit(opts: EngineOptions): Promise<Outcome> {
  if (Boolean(opts.test) === Boolean(opts.describe)) throw new Error('findCulprit needs exactly one of test or describe.');
  const started = Date.now();
  const emit = opts.onEvent ?? (() => {});

  const repoRoot = await resolveRepoRoot(opts.cwd);
  const badInput = opts.bad ?? 'HEAD';
  const badSha = await resolveCommit(repoRoot, badInput, '--bad', opts.bad ? undefined : 'This repository has no commits yet.');
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
      const shown = await git(['show', '-s', NO_SIGNATURE, '--format=%H%x1f%h%x1f%s', sha], repoRoot);
      const [full, short, subject] = shown.split('\x1f');
      known = { sha: full, short, subject };
      refs.set(sha, known);
    }
    return known;
  };

  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'], repoRoot)).length > 0;
  const shallow = (await git(['rev-parse', '--is-shallow-repository'], repoRoot)) === 'true';
  const bad = await ref(badSha);
  emit({ type: 'start', repoRoot, bad, dirty, shallow, overlays: overlays.map((o) => o.path) });

  const timeoutMs = opts.timeoutMs ?? (opts.describe ? REPRO_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const sandbox = await Sandbox.create(repoRoot, badSha, overlays, opts.setup, timeoutMs);

  let test = opts.test ?? '';
  let classify: Classifier | undefined;
  let repro: ReproInfo | undefined;
  /** What the test printed where the bug is. */
  let badOutput = '';
  let checks = 0;
  const stats = (): Stats => ({ checks, durationMs: Date.now() - started, ...(repro && { repro }) });

  const check = async (phase: Phase, sha: string, label?: string, checkout = true): Promise<Evaluation> => {
    opts.signal?.throwIfAborted();
    if (checkout) await sandbox.checkout(sha);
    const commit = await ref(sha);
    const evaluation = await sandbox.evaluate(test, (command) => emit({ type: 'setup', commit, command }), classify);
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

  /** Has the agent write a test until one fails at the bad commit. Returns an outcome only when it can't. */
  const reproduceWithAgent = async (describe: DescribeOptions): Promise<Outcome | undefined> => {
    const max = describe.attempts ?? 3;
    const agent = describe.agent.label;
    const attempts: Attempt[] = [];
    const miss = (attempt: number, problem: string, candidate?: Repro): void => {
      emit({ type: 'rejected', attempt, problem });
      attempts.push({ repro: candidate, problem: `whobrokeit could not use it: ${problem}` });
    };
    emit({ type: 'phase', phase: 'write-test', agent });

    for (let n = 1; n <= max; n++) {
      opts.signal?.throwIfAborted();
      emit({ type: 'agent', attempt: n, of: max });
      const answer = await describe.agent.ask(
        buildPrompt({ bug: describe.bug, commit: bad, attempts, maxAttempts: max }),
        sandbox.dir,
        { timeoutMs: describe.agentTimeoutMs ?? AGENT_TIMEOUT_MS, onActivity: (text) => emit({ type: 'activity', text }) },
      );
      opts.signal?.throwIfAborted();

      const reply = parseReply(answer);
      if (reply.kind === 'cannot') {
        return { kind: 'no-repro', bad, agent, gaveUp: true, reason: reply.reason, attempts, ...stats() };
      }
      if (reply.kind === 'invalid') {
        miss(n, reply.problem);
        continue;
      }
      const normalized = normalizeReproPath(reply.repro.path);
      if ('problem' in normalized) {
        miss(n, normalized.problem, reply.repro);
        continue;
      }
      const candidate: Repro = { ...reply.repro, path: normalized.path };
      const exists =
        (await gitRaw(['cat-file', '-e', `${badSha}:${candidate.path}`], repoRoot)).code === 0 ||
        // On disk too: an installed file (node_modules), or the same name in other case on Windows and macOS.
        existsSync(join(sandbox.dir, candidate.path)) ||
        overlays.some((o) => o.path === candidate.path);
      if (exists) {
        miss(n, `${candidate.path} already exists. Write a new file and never replace existing ones.`, candidate);
        continue;
      }

      emit({ type: 'repro', attempt: n, repro: candidate });
      sandbox.overlays = [...overlays, { path: candidate.path, content: Buffer.from(candidate.code) }];
      test = candidate.command;
      classify = classifyRepro;
      const evaluation = await check('write-test', badSha, `attempt ${n}`, false);
      if (evaluation.verdict === 'bad') {
        repro = { ...candidate, agent, attempts: n };
        badOutput = evaluation.run?.output ?? '';
        return undefined;
      }
      if (evaluation.reason?.includes('dependencies')) {
        return { kind: 'cannot-test', bad, output: evaluation.run?.output ?? '', reason: evaluation.reason, ...stats() };
      }
      attempts.push({
        repro: candidate,
        problem: explainMiss(evaluation.run, timeoutMs, evaluation.reason),
        output: evaluation.run?.output,
      });
    }

    const reason = `None of the ${max} attempts produced a test that fails at ${bad.short}.`;
    return { kind: 'no-repro', bad, agent, gaveUp: false, reason, attempts, ...stats() };
  };

  /** Asks the agent why the culprit broke it, then tries its fix at the bad commit. */
  const explainCulprit = async (
    explain: ExplainOptions,
    culprit: CommitInfo,
    parentSha: string,
    failureOutput: string,
  ): Promise<Explanation> => {
    const max = explain.attempts ?? 2;
    const agent = explain.agent.label;
    const attempts: FixAttempt[] = [];
    let why: string | undefined;
    let note: string | undefined;
    emit({ type: 'phase', phase: 'explain', agent });

    try {
      const diff = await git(['diff', '--no-color', '--no-ext-diff', parentSha, culprit.sha], repoRoot);
      const behind = Number(await git(['rev-list', '--count', `${culprit.sha}..${badSha}`], repoRoot));
      // Fixes must leave the test itself and every file whobrokeit drops in alone.
      const protectedPaths = sandbox.overlays.map((o) => o.path);

      for (let n = 1; n <= max; n++) {
        opts.signal?.throwIfAborted();
        emit({ type: 'agent', attempt: n, of: max });
        await sandbox.checkout(badSha);
        const answer = await explain.agent.ask(
          buildExplainPrompt({
            bug: explain.bug ?? opts.describe?.bug,
            test,
            testFile: repro && { path: repro.path, code: repro.code },
            failureOutput,
            culprit,
            diff,
            bad,
            behind,
            attempts,
            maxAttempts: max,
          }),
          sandbox.dir,
          { timeoutMs: explain.agentTimeoutMs ?? AGENT_TIMEOUT_MS, onActivity: (text) => emit({ type: 'activity', text }) },
        );
        opts.signal?.throwIfAborted();

        const reply = parseExplanation(answer);
        why = reply.why ?? why;
        if (reply.kind === 'nofix') return { agent, why, note: `${agent} did not suggest a fix: ${reply.reason}` };
        if (reply.kind === 'invalid') {
          emit({ type: 'rejected', attempt: n, problem: reply.problem });
          note = `${agent}'s reply could not be used: ${reply.problem}`;
          attempts.push({ edits: [], problem: `whobrokeit could not use it: ${reply.problem}` });
          continue;
        }

        const unusable = async (problem: string): Promise<void> => {
          await sandbox.clean();
          emit({ type: 'rejected', attempt: n, problem });
          note = `${agent}'s fix could not be applied: ${problem}`;
          attempts.push({ edits: reply.edits, problem: `whobrokeit could not apply it: ${problem}` });
        };
        const applied = await applyEdits(sandbox.dir, reply.edits, protectedPaths, (path) => sandbox.isTracked(path));
        if ('problem' in applied) {
          await unusable(applied.problem);
          continue;
        }
        // Prefixes spelled out: with diff.noprefix set, `git apply` could not use the patch.
        const changes = await git(['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'], sandbox.dir);
        if (!changes) {
          await unusable('the edits changed nothing.');
          continue;
        }

        const patch = `${changes}\n`;
        emit({ type: 'fix', attempt: n, files: applied.files });
        const evaluation = await check('explain', badSha, 'with fix', false);
        if (evaluation.verdict === 'good') {
          return { agent, why, fix: { patch, files: applied.files, verified: true, attempts: n } };
        }
        const problem =
          evaluation.verdict === 'bad'
            ? `the test still fails at ${bad.short} with this fix.`
            : `the test could not run at ${bad.short} with this fix (${evaluation.reason ?? `exit code ${evaluation.run?.code}`}).`;
        note = `${agent}'s fix did not work: ${problem}`;
        attempts.push({ edits: reply.edits, problem, output: evaluation.run?.output });
      }
    } catch (err) {
      // The culprit is proven by now: whatever goes wrong here costs only the explanation.
      if (opts.signal?.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { agent, why, note: err instanceof UserError ? message : `Explaining it failed: ${message}` };
    }
    return { agent, why, note };
  };

  try {
    if (opts.describe) {
      // 1. An agent writes a test, and we watch it fail here before trusting it.
      const early = await reproduceWithAgent(opts.describe);
      if (early) return early;
    } else {
      // 1. The test must fail where the user says the bug is.
      emit({ type: 'phase', phase: 'reproduce' });
      const atBad = await check('reproduce', badSha, badInput, false);
      badOutput = atBad.run?.output ?? '';
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
    }

    // 2. Find a commit where it still worked: walk back 1, 2, 4, 8... commits.
    emit({ type: 'phase', phase: 'find-good' });
    let lastBad = badSha;
    let good: string | undefined;

    if (givenGood) {
      const evaluation = await check('find-good', givenGood, opts.good);
      if (evaluation.verdict !== 'good') {
        return {
          kind: 'good-fails',
          good: await ref(givenGood),
          verdict: evaluation.verdict,
          ...(evaluation.reason && { reason: evaluation.reason }),
          output: evaluation.run?.output ?? '',
          ...stats(),
        };
      }
      good = givenGood;
    } else {
      const root = (await git(['rev-list', '--first-parent', '--max-parents=0', badSha], repoRoot)).split('\n')[0];
      if (root === badSha) {
        return { kind: 'no-good-commit', bad, oldest: bad, shallow, untestable: false, output: badOutput, ...stats() };
      }
      const rootDistance = Number(await git(['rev-list', '--count', '--first-parent', `${root}..${badSha}`], repoRoot));

      let untestable = false;
      // Shown if nothing works: a typo in the command, or a test file older commits don't have.
      let rootOutput = '';
      /** Tests the commit `distance` first-parent steps behind bad. */
      const probe = async (distance: number): Promise<{ verdict: Verdict; sha: string }> => {
        const sha = distance >= rootDistance ? root : await git(['rev-parse', `${badSha}~${distance}`], repoRoot);
        const { verdict, run } = await check('find-good', sha, `${badInput}~${Math.min(distance, rootDistance)}`);
        if (sha === root) rootOutput = run?.output ?? '';
        if (verdict === 'bad') lastBad = sha;
        if (verdict === 'skip') untestable = true;
        return { verdict, sha };
      };

      let lo = 0; // distance of the oldest commit known to be broken
      walk: for (let n = 1; ; n = Math.min(n * 2, rootDistance)) {
        const first = await probe(n);
        if (first.verdict === 'good') {
          good = first.sha;
          break;
        }
        if (first.verdict === 'bad') {
          lo = n;
        } else {
          // Older code often can't run the test at all (it needs something added later),
          // so look between the last broken commit and this one before going further back.
          let hi = n;
          while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            const next = await probe(mid);
            if (next.verdict === 'good') {
              good = next.sha;
              break walk;
            }
            if (next.verdict === 'bad') lo = mid;
            else hi = mid;
          }
        }
        if (n >= rootDistance) {
          return { kind: 'no-good-commit', bad, oldest: await ref(root), shallow, untestable, output: rootOutput, ...stats() };
        }
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
        const shas = [...text.matchAll(/^([0-9a-f]{40,64})$/gm)].map((m) => m[1]);
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
    const proven = atCulprit.verdict === 'bad' && atParent.verdict === 'good';
    const culprit = await commitInfo(repoRoot, culpritSha, parentSha);
    const failureOutput = atCulprit.run?.output ?? '';

    // 5. Why, and a fix that has been seen to make the test pass.
    const explanation =
      opts.explain && proven ? await explainCulprit(opts.explain, culprit, parentSha, failureOutput) : undefined;

    return {
      kind: 'found',
      culprit,
      parent: await ref(parentSha),
      good: await ref(good),
      bad,
      proven,
      proof: { culprit: atCulprit.verdict, parent: atParent.verdict },
      failureOutput,
      ...(explanation && { explanation }),
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

/** `missing` replaces the message when the user did not give this ref. */
async function resolveCommit(repoRoot: string, input: string, flag: string, missing?: string): Promise<string> {
  // No ref starts with a dash; git would read one as an option.
  const result = input.startsWith('-')
    ? undefined
    : await gitRaw(['rev-parse', '--verify', '--quiet', `${input}^{commit}`], repoRoot);
  if (result?.code !== 0) throw new UserError(missing ?? `${flag} ${input} is not a commit in this repository.`);
  return result.stdout.trim();
}

async function readOverlays(cwd: string, repoRoot: string, files: string[]): Promise<Overlay[]> {
  // Real paths on both sides: the folder may be reached through a symlink (/tmp on macOS) or a
  // short Windows name, while git reports the repository's real location.
  const root = await realpath(repoRoot).catch(() => resolve(repoRoot));
  const base = await realpath(cwd).catch(() => resolve(cwd));
  return Promise.all(
    files.map(async (file) => {
      const absolute = resolve(base, file);
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
    await git(['show', '-s', NO_SIGNATURE, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI', sha], repoRoot)
  ).split('\x1f');
  // By default git prints a non-ASCII file name as octal escapes inside quotes.
  const numstat = await git(['-c', 'core.quotePath=false', 'diff', '--numstat', parent, sha], repoRoot);
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
