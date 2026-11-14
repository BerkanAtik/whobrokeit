# Benchmark: real regressions

Does whobrokeit blame the right commit on bugs it has never seen? This folder checks that on 12 regressions from 9 well-known JavaScript projects. All of them are closed issues, so the answer is known.

**Result: 11 of 12 correct**, about 100 seconds per case (Claude Code, `--model sonnet`).

| Case | Issue | Result | Commit it proved | Checks | Time |
|---|---|---|---|---|---|
| commander-843 | [tj/commander.js#843](https://github.com/tj/commander.js/issues/843) | ✓ | `28ff02a` Fix to emit the action even without command | 8 | 51s |
| semver-580 | [npm/node-semver#580](https://github.com/npm/node-semver/issues/580) | ✓ | `abdd93d` set max lengths in regex for numeric and build identifiers | 10 | 77s |
| postcss-1785 | [postcss/postcss#1785](https://github.com/postcss/postcss/issues/1785) | ✓ | `7278432` recalculate the insertion index after normalizing a node | 14 | 88s |
| postcss-1502 | [postcss/postcss#1502](https://github.com/postcss/postcss/issues/1502) | ✓ | `d65b0bf` Deduplicate Input objects in JSON | 15 | 135s |
| luxon-1482 | [moment/luxon#1482](https://github.com/moment/luxon/issues/1482) | ✓ | `2411f6e` Fix normalize() to handle partially negative inputs | 12 | 95s |
| luxon-1493 | [moment/luxon#1493](https://github.com/moment/luxon/issues/1493) | ✓ | `11e454c` Fix for negative units in conversions | 6 | 70s |
| marked-1505 | [markedjs/marked#1505](https://github.com/markedjs/marked/issues/1505) | ✓ | `be27472` Improve worst-case performance of inline.text regex | 16 | 86s |
| marked-1754 | [markedjs/marked#1754](https://github.com/markedjs/marked/issues/1754) | ✓ | `4e2ec90` Now passes several more tests (part of PR #1686) | 16 | 86s |
| express-2550 | [expressjs/express#2550](https://github.com/expressjs/express/issues/2550) | ✓ | `566720b` improve proxy trust with ip address list | 22 | 118s |
| markdown-it-1024 | [markdown-it/markdown-it#1024](https://github.com/markdown-it/markdown-it/issues/1024) | ✓ | `cd24778` Update to comply with spec 0.31.2 | 11 | 91s |
| fastify-5089 | [fastify/fastify#5089](https://github.com/fastify/fastify/issues/5089) | ✗ | `5bf0f4f`, a year too early (expected `797f27d`) | 22 | 199s |
| yargs-1570 | [yargs/yargs#1570](https://github.com/yargs/yargs/issues/1570) | ✓ | `b9409da` pull in yargs-parser@17.0.0 | 13 | 115s |

In all 12 cases the suggested fix made the test pass. Full output of every run, including the script the agent wrote and its explanation, is in [results/](results).

## How a case works

1. The repository is checked out at the last commit before the fix.
2. whobrokeit gets the issue's title and body exactly as the reporter wrote them, and nothing else: `whobrokeit "<issue text>" --json`. No `--good`, no test.
3. The commit it proves is compared with the commit the maintainers identified. [cases.json](cases.json) says where each expected commit comes from, usually the fix PR.

A case counts as correct only if whobrokeit proved the expected commit (test fails there, passes at its parent). "Not reproduced" or any other outcome counts as a miss.

## How the cases were picked

I searched closed issues with "regression" in the title in popular JavaScript projects whose source runs without a build step, and took at most two per project. Issues about TypeScript types, performance, browsers or databases were left out, because a short script can't check them. The list was fixed before the first run. Some reports name the commit the reporter suspects; they are still passed as written, since whobrokeit has to prove the commit either way.

## What went wrong, honestly

The first full run scored 8 of 12. Three of the four misses were bugs in whobrokeit, not in the idea:

- **postcss (2 cases):** the projects use pnpm and yarn, which were not installed on the test machine, so nothing could be tested. whobrokeit now falls back to `npm install`.
- **yargs:** the project ignores `package-lock.json`. The lockfile npm wrote at the first commit stayed in place, so older commits kept running with the newest dependencies. whobrokeit now only trusts committed lockfiles and writes none itself.

After these fixes all 12 cases were run again from scratch, which gives the table above. So the 11 of 12 is measured on the same cases that exposed the bugs; read it as "what the tool does now on these cases", not as a blind score.

- **fastify (still a miss):** the bug depends on the version of a dependency (`find-my-way`), and fastify commits no lockfile. Today's `npm install` gives old commits a newer `find-my-way` than they had at the time, so history looks broken much earlier than it really was. whobrokeit proved a commit that is the first failing one with today's dependencies, but it is not the commit that caused the report. Installing each commit with the packages published by its own date (`npm install --before`) doesn't fix it: the real culprit, `797f27d`, raised the minimum `find-my-way` to 7.7.0, which had come out two days earlier, so its parent gets 7.7.0 too and fails. The parent passes with an older 7.6.x. Only installing the lowest version each range allows would match what the maintainers saw, and npm has no option for that.

## Run it yourself

```sh
npm run build
node bench/run.mjs --model sonnet            # all cases
node bench/run.mjs semver-580 luxon-1493     # some cases
```

It clones the projects into `bench/.work/` (about 180 MB) and needs Claude Code or Codex logged in. A full run makes about 25 agent requests. Agent answers vary, so a rerun can differ by a case.
