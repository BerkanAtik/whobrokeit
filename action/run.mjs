// The GitHub Action: works out what to look for from the issue, runs the whobrokeit CLI and
// replies on the issue with its report. Settings arrive as WBI_* variables from action.yml.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const MAX_BUG = 8000;
const MAX_COMMENT = 60_000;
const HOME = 'https://github.com/BerkanAtik/whobrokeit';

const setting = (name) => (process.env[`WBI_${name}`] ?? '').trim();
const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
const issue = event.issue;
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** The bug in plain words: the `bug` input, else what follows `/whobrokeit`, else the issue itself. */
function bugText() {
  const given = setting('BUG');
  if (given) return given;
  const command = /^\/whobrokeit\b[ \t]*([\s\S]*)/.exec((event.comment?.body ?? '').trim());
  const text = command?.[1]?.trim() || (issue ? `${issue.title}\n\n${issue.body ?? ''}` : '');
  // Issue templates leave their instructions behind as HTML comments.
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_BUG);
}

async function github(method, path, body) {
  const token = setting('GITHUB_TOKEN');
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'whobrokeit-action',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${path}: ${response.status} ${await response.text()}`);
}

const shouldComment = Boolean(issue) && setting('COMMENT') !== 'false';
const issuePath = issue ? `/repos/${process.env.GITHUB_REPOSITORY}/issues/${issue.number}` : '';

async function reply(body) {
  if (!shouldComment) return;
  const text = body.length > MAX_COMMENT ? `${body.slice(0, MAX_COMMENT)}\n\n_…cut short, see the [run log](${runUrl})._` : body;
  try {
    await github('POST', `${issuePath}/comments`, { body: text });
  } catch (err) {
    console.log(`::warning::Could not comment on the issue: ${err.message}`);
  }
}

function footer() {
  return `\n---\n<sub>[whobrokeit](${HOME}) · [run log](${runUrl})</sub>\n`;
}

/** Run the CLI, showing its output live and keeping the end of it for an error comment. */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (stream) => (chunk) => {
      stream.write(chunk);
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', keep(process.stdout));
    child.stderr.on('data', keep(process.stderr));
    child.on('error', (err) => resolve({ code: 1, tail: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, tail }));
  });
}

async function main() {
  const test = setting('TEST');
  const bug = test ? '' : bugText();
  if (!test && !bug) {
    console.log('::error::Nothing to look for: give `bug` or `test`, or run on an issue.');
    return 1;
  }

  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' });
  if (shallow.stdout.trim() === 'true') {
    const message = 'The checkout has no history. Set `fetch-depth: 0` on `actions/checkout`.';
    console.log(`::error::${message}`);
    await reply(`**whobrokeit could not run.** ${message}\n${footer()}`);
    return 1;
  }

  const report = join(process.env.RUNNER_TEMP ?? '.', 'whobrokeit-report.md');
  const args = test ? ['--test', test] : [bug];
  const explain = setting('EXPLAIN');
  if (test && explain === 'true') args.push('--explain');
  if (!test && explain === 'false') args.push('--no-explain');
  if (setting('AGENT') && (!test || explain === 'true')) args.push('--agent', setting('AGENT'));
  if (setting('MODEL')) args.push('--model', setting('MODEL'));
  if (setting('GOOD')) args.push('--good', setting('GOOD'));
  if (setting('BAD')) args.push('--bad', setting('BAD'));
  if (setting('SETUP') === 'none') args.push('--no-setup');
  else if (setting('SETUP')) args.push('--setup', setting('SETUP'));
  if (setting('TIMEOUT')) args.push('--timeout', setting('TIMEOUT'));
  args.push('--report', report);

  // Only the agent gets credentials, under the names it expects. whobrokeit keeps them from
  // the tests it runs, and the GitHub token never leaves this script.
  const env = { ...process.env, FORCE_COLOR: '1' };
  for (const name of Object.keys(env)) if (name.startsWith('WBI_')) delete env[name];
  // A token copied from a terminal often picks up a line break in the middle; keys have no spaces.
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const value = setting(name).replace(/\s+/g, '');
    if (value) env[name] = value;
  }

  if (shouldComment) {
    await github('POST', `${issuePath}/reactions`, { content: 'eyes' }).catch(() => {});
  }

  const { code, tail } = await runCli(args, env);
  output('exit-code', code);
  output('report', report);

  if (existsSync(report)) {
    const markdown = readFileSync(report, 'utf8');
    const commit = /^\*\*Introduced by\*\* `([0-9a-f]+)`/m.exec(markdown)?.[1];
    if (commit) output('commit', commit);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    await reply(`${markdown.replace(/^# whobrokeit report\n/, '### whobrokeit\n')}${footer()}`);
  } else {
    const plain = tail.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-25).join('\n');
    await reply(`**whobrokeit stopped with an error.**\n\n\`\`\`text\n${plain.replace(/```/g, "'''")}\n\`\`\`\n${footer()}`);
  }
  // A bug that could not be pinned down is an answer, not a failed job; only errors fail it.
  return code === 1 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.log(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
