# whobrokeit

**Find the commit that broke it, and prove it.**

[![npm](https://img.shields.io/npm/v/whobrokeit)](https://www.npmjs.com/package/whobrokeit) [![CI](https://github.com/BerkanAtik/whobrokeit/actions/workflows/ci.yml/badge.svg)](https://github.com/BerkanAtik/whobrokeit/actions/workflows/ci.yml) [![GitHub Marketplace](https://img.shields.io/badge/Marketplace-whobrokeit%20bisect-blue?logo=github)](https://github.com/marketplace/actions/whobrokeit-bisect) [![License: MIT](https://img.shields.io/npm/l/whobrokeit)](https://github.com/BerkanAtik/whobrokeit/blob/main/LICENSE)

English · [Türkçe](README.tr.md)

Describe a bug in one sentence. An AI agent writes a test that shows it, whobrokeit walks your git history to the first commit where that test fails, and proves the result: the test fails at that commit and passes at its parent. Then it explains what went wrong and suggests a fix, which it shows only after the test passes with it.

<p align="center">
  <img src="assets/demo.gif" alt="whobrokeit finds the commit that broke subtotal(), in 37 seconds" width="860">
</p>

```sh
npx whobrokeit demo        # try it on a generated repo with a hidden bug (no AI needed)
npx whobrokeit demo --ai   # the same, with an AI agent writing the test
```

## Use it

Describe the bug, from anywhere inside your repo:

```sh
whobrokeit "Adding 3 mugs costs the same as 1 mug."
```

This needs [Claude Code](https://github.com/anthropics/claude-code) or [Codex](https://github.com/openai/codex) installed and logged in. whobrokeit uses whichever it finds.

Or bring your own failing test, and no AI is involved:

```sh
whobrokeit --test "npm test -- cart.test.js"
whobrokeit --test "pytest tests/test_cart.py -x"
whobrokeit --test "node repro.mjs" --with repro.mjs   # a test you haven't committed yet
```

Any command works. Exit code 0 means it works, 125 means this commit can't be tested (skip it), anything else means broken. Add `--explain` to get the explanation and a fix in this mode too.

## On GitHub issues

whobrokeit can also run as a GitHub Action. When you label an issue `whobrokeit`, or comment `/whobrokeit`, it looks for the commit that broke it and replies on the issue with the culprit, the proof and a fix it has tested.

Add an `ANTHROPIC_API_KEY` secret to the repo, then save this as `.github/workflows/whobrokeit.yml`:

```yaml
name: whobrokeit

on:
  issues:
    types: [labeled]
  issue_comment:
    types: [created]

permissions:
  contents: read
  issues: write

jobs:
  whobrokeit:
    # Only people who can label issues, or members and collaborators who comment /whobrokeit.
    if: >-
      (github.event_name == 'issues' && github.event.label.name == 'whobrokeit') ||
      (github.event_name == 'issue_comment' && !github.event.issue.pull_request &&
       startsWith(github.event.comment.body, '/whobrokeit') &&
       contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association))
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0               # whobrokeit needs the history
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 22             # at least 22, which Claude Code needs
          package-manager-cache: false # tests written from an issue must not reach the cache
      - uses: BerkanAtik/whobrokeit@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

By default it works from the issue's title and body. Text after `/whobrokeit` replaces them, so you can put the bug more precisely: `/whobrokeit Adding 3 mugs costs the same as 1 mug.`

| Input | |
|---|---|
| `anthropic-api-key` | Anthropic API key. Or `claude-code-oauth-token`, made with `claude setup-token`, to use a Claude subscription. |
| `bug` | What is broken. Default: the comment text after `/whobrokeit`, else the issue. |
| `test` | Your own failing test command. No AI writes the test then. |
| `explain` | `auto` (default), `true` or `false`. |
| `agent`, `model`, `good`, `bad`, `setup`, `timeout` | As on the command line. `setup: none` turns installs off. |
| `working-directory` | The repository to search, if it is not the workspace root. |
| `comment` | Set to `false` to skip the issue comment. The report is in the job summary either way. |

Outputs: `exit-code`, `commit` (short hash of the culprit) and `report` (path to the Markdown report). The job fails only on errors. A bug it could not reproduce is reported on the issue like any other result.

Read an issue before you start a run on it. The agent only reads code, but whobrokeit runs the test it writes, and issue text can try to steer the agent. The tests whobrokeit runs never get the AI key or the GitHub token in their environment, and the token can change issues but not your code. Code on the runner runs as the same user, though, so use an API key with a spending limit.

## What it does

1. **Reproduce.** The agent reads your code and writes a small script that prints a `WHOBROKEIT_BUG:` line when it sees the bug. whobrokeit runs it at `HEAD` and only goes on if it fails there for that reason. A crash without that line counts as "can't tell", so a test that calls a function older commits don't have never blames the wrong commit.
2. **Find a commit where it still worked.** It walks back 1, 2, 4, 8… commits until the test passes. Or pass `--good <ref>`.
3. **Bisect.** `git bisect` narrows it down to the first bad commit, skipping commits the test can't tell about.
4. **Prove it.** It runs the test again at the culprit (fails) and at its parent (passes).
5. **Explain and fix.** The agent says why the change broke things and proposes an edit. whobrokeit applies it, runs the test, and shows the fix only if the test passes. It saves it as a patch you can `git apply`.

## Tested on real bugs

I ran it on 12 closed regression issues from commander, semver, postcss, luxon, marked, express, markdown-it, fastify and yargs. It got only the issue text, exactly as the reporter wrote it. It proved the commit the maintainers had identified in **11 of 12** cases, in about 100 seconds each. The cases, the one miss and how to rerun everything are in [bench/](bench).

## Safe to run on your repo

- **Your working copy is never touched.** Every check runs in a temporary `git worktree`, which is removed at the end. Uncommitted changes, open files and your current branch stay as they are.
- **The agent can only read.** Claude Code runs with the Read, Grep and Glob tools only, and with your hooks, plugins and MCP servers turned off. Codex runs in its read-only sandbox. whobrokeit runs the test the agent writes, so check it if you don't trust the repo.
- **Nothing is taken on faith.** The test has to fail at `HEAD` for the reported reason, the culprit has to be proven against its parent, and a fix has to make the test pass.
- **Dependencies are installed per commit** when `package.json` or a lockfile changes (npm, pnpm, yarn, bun). Use `--setup "<cmd>"` for anything else, or `--no-setup`.

## Options

| Option | |
|---|---|
| `-t, --test <cmd>` | A command that fails while the bug is present. |
| `--agent <name>` | Who writes the test: `claude`, `codex`, or any command that reads a prompt on stdin and answers on stdout. Default: `claude`, else `codex`. |
| `--model <name>` | Model for the agent, e.g. `sonnet`. |
| `--explain` / `--no-explain` | Explain the culprit and test a fix. On by default when you describe a bug, off with `--test`. |
| `-w, --with <file>` | Copy this file from your working copy into every commit tested. Repeatable. |
| `-g, --good <ref>` | A commit where it still worked. Default: found automatically. |
| `-b, --bad <ref>` | A commit where it is broken. Default: `HEAD`. |
| `--setup <cmd>` / `--no-setup` | Install command, re-run when dependency files change. Default: auto. |
| `--timeout <sec>` | Time limit for each test run. Default: 600, or 300 for agent-written tests. |
| `--report <file>` | Also write a Markdown report, ready to paste into an issue or PR. |
| `--json` | Print the result as JSON. |

Exit codes: `0` found and proven · `1` error · `2` bug not reproduced · `3` no working commit found · `4` inconclusive.

## Good to know

- Requires Node.js 20+ and git. No other dependencies.
- The test can be in any language your project uses. Automatic dependency install covers JavaScript package managers; for other stacks, use `--setup`.
- With an agent, a run usually makes two requests: one to write the test, one to explain the culprit (each is retried once if its result doesn't hold up). On the demo repo the whole run takes 30 to 60 seconds.
- If the project commits no lockfile, old commits get today's versions of their dependencies. A bug that depends on a dependency's version can then be traced to the wrong commit.
- Dependencies are reinstalled when they change, but nothing is rebuilt between commits. If your test runs against built files (say `dist/`), put the build in the command: `--test "npm run build && npm test"`. The agent is told to do the same.
- After a run, the agent's test and the fix are in `.git/whobrokeit/`, outside your working tree.

## License

[MIT](LICENSE)
