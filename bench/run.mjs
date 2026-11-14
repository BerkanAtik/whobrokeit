// Runs whobrokeit on real, already-fixed regressions and checks the commit it blames.
// usage: node bench/run.mjs [case-id...] [--model sonnet] [--agent claude]
// Each case: check out the last commit before the fix, give whobrokeit the issue text as written,
// compare the commit it proves with the one the maintainers identified.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const work = join(here, '.work');
const results = join(here, 'results');
const cli = join(here, '..', 'dist', 'cli.js');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args.splice(args.indexOf(name), 2)[1] : undefined);
const model = flag('--model');
const agent = flag('--agent');
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')).filter((c) => !args.length || args.includes(c.id));

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

async function issueText(c) {
  const file = join(work, 'issues', `${c.id}.md`);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const headers = { 'User-Agent': 'whobrokeit-bench', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`https://api.github.com/repos/${c.repo}/issues/${c.issue}`, { headers });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${c.repo}#${c.issue}`);
  const { title, body } = await res.json();
  const text = `${title}\n\n${body ?? ''}`.replace(/\r/g, '').trim();
  writeFileSync(file, text);
  return text;
}

/** "PR:a..b" means any commit reachable from b but not from a. */
function matches(repo, sha, expected) {
  return expected.some((e) =>
    e.startsWith('PR:') ? git(repo, 'rev-list', e.slice(3)).split('\n').includes(sha) : sha.startsWith(e),
  );
}

mkdirSync(join(work, 'issues'), { recursive: true });
mkdirSync(results, { recursive: true });
for (const c of cases) await issueText(c);
const rows = [];
for (const c of cases) {
  const repo = join(work, c.repo.split('/')[1]);
  if (!existsSync(repo)) execFileSync('git', ['clone', '-q', `https://github.com/${c.repo}.git`, repo], { stdio: 'inherit' });
  git(repo, 'checkout', '-q', '--detach', '-f', c.bad);
  const bug = await issueText(c);
  console.error(`\n=== ${c.id}  (${c.repo}#${c.issue}, at ${git(repo, 'rev-parse', '--short', 'HEAD')})`);
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    [cli, bug, '--json', ...(model ? ['--model', model] : []), ...(agent ? ['--agent', agent] : [])],
    { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 45 * 60 * 1000 },
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  let outcome;
  try {
    outcome = JSON.parse(run.stdout);
  } catch {
    outcome = { kind: 'error', error: (run.stderr || String(run.error)).trim().split('\n').slice(-5).join('\n') };
  }
  if (outcome.culprit) delete outcome.culprit.email;
  const found = outcome.kind === 'found' && outcome.proven;
  const correct = found && matches(repo, outcome.culprit.sha, c.expected);
  const row = {
    id: c.id,
    result: correct ? 'correct' : found ? 'wrong' : outcome.kind,
    culprit: found ? `${outcome.culprit.short} ${outcome.culprit.subject}` : '',
    fix: outcome.explanation?.fix?.verified ? 'verified' : '',
    seconds,
  };
  rows.push(row);
  writeFileSync(join(results, `${c.id}.json`), JSON.stringify({ ...row, model: model ?? 'default', outcome }, null, 2) + '\n');
  console.error(`${row.result}${row.culprit ? `: ${row.culprit}` : ''}  (${seconds}s)`);
}
console.table(rows);
console.log(`${rows.filter((r) => r.result === 'correct').length} of ${rows.length} correct`);
