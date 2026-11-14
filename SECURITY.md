# Security

whobrokeit runs tests against your code, and its GitHub Action works from issue text that anyone can write. If you find a way around the protections below, please report it privately: on the [Security tab](https://github.com/BerkanAtik/whobrokeit/security), choose **Report a vulnerability**. Please don't open a public issue for it.

## What should hold

- Your working copy is never changed. Every check runs in a temporary git worktree.
- The AI agent only reads the code. It cannot change files.
- Text from an issue or a comment is only ever a bug description. It never becomes a command-line option or a shell command.
- The tests whobrokeit runs get no AI key and no GitHub token in their environment, and the Action never passes the GitHub token to the command-line tool.

A way to break any of these is worth a report.

## Known limits

These are by design, and the README describes them:

- whobrokeit runs the test the agent writes, and issue text can try to steer the agent. That test runs as the same user as whobrokeit, so on Linux it could read the AI key from another process's environment. That is why the Action should start only from a maintainer's label or comment, with an API key that has a spending limit.
- Installing dependencies, and the project's own tests, run code from each commit tested.

## Supported versions

Fixes go into the latest release. For the Action, that is the `v0` tag.
