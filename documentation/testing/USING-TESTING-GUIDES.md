# Using Testing Guides

Read this file at the start of every implementation iteration, before deciding whether any test writing or test execution is allowed.

Agents must never write tests, modify tests, or run test commands unless the user explicitly asks for tests in the current thread. If the user has not explicitly asked for tests, use static review and non-test hygiene checks only.

After the user explicitly asks for tests, read the guide for the affected language or test layer before writing, modifying, or running tests. Service names and runner commands belong in the shared language guide and runner dispatcher, not repeated service guides.

New testing guides added below this directory are automatically part of this selection rule; no agent-skill catalog update is required.

## Mandatory Agent Verification Rules

These rules apply before an agent selects or runs any verification command, whether or not the task changes tests:

- Never run `npm`, `npx`, `pnpm`, or `pnpx` on the host. Any package-manager-backed verification must run inside the appropriate Docker container when verification is otherwise allowed.
- Never install project dependencies or tooling on the host. Dependency changes are handled through Docker images or containers, not local host setup.
- Never write, modify, or run tests unless the user explicitly asks for tests in the current thread.
- Never open the application in a browser or use browser automation, screenshots, or manual visual inspection to verify work.
- For TypeScript tests, follow `TypeScript/TESTING-GUIDE.md`. Every TypeScript service and shared package uses the same one-shot `lixpi-typescript-test-runner` command with its configured domain. Application containers do not ship a test runner.

If tests were not explicitly requested, do not report missing test execution as a verification failure. If tests were explicitly requested and the permitted tests do not cover a changed behavior, report the remaining verification gap rather than substituting a prohibited check.
