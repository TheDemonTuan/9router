# Agent Guide

## Scope and source of truth

- This file applies to the repository. Read `open-sse/AGENTS.md` before editing the routing engine and `tests/translator/AGENTS.md` before editing translator tests; their area-specific rules apply within those directories.
- Use `package.json`, `tests/package.json`, executable configuration, and current source as the authority for commands and behavior. `CLAUDE.md` and `docs/ARCHITECTURE.md` provide context but contain outdated runtime, database, and test instructions. Do not copy historical pass/fail counts as current results.
- Keep changes focused on the request. Preserve existing behavior, public API compatibility, and the dashboard's established design. Prefer existing helpers, platform features, and installed dependencies over new abstractions or packages.

## Project map

9Router is a local AI gateway with a Next.js dashboard. It exposes compatible APIs, translates provider formats, manages credentials, and handles account/combo fallback and usage tracking.

- `src/app/`: Next.js App Router UI and API routes. `next.config.mjs` maps public `/v1/*` requests to API routes.
- `src/sse/handlers/chat.js`: application-side chat entry, account selection, and combo handling.
- `open-sse/`: provider-agnostic engine. Chat enters `handlers/chatCore.js`, dispatches through `executors/`, and converts formats through `translator/`.
- `open-sse/config/` and `open-sse/providers/`: model catalog, provider definitions, capabilities, pricing, and runtime constants.
- `src/lib/db/`: SQLite driver, repositories, and migrations. `src/lib/localDb.js` is a compatibility re-export; prefer `@/lib/db/index.js` for new database consumers.
- `custom-server.js`: production server and client-IP trust boundary.
- `cli/`: separately packaged and versioned launcher; do not couple its version to the app without a release requirement.
- `tests/`: independent Vitest package, regression fixtures, and additional scripts.

## Branches, worktrees, and parallel agents

A branch isolates history, not files, the index, build outputs, or running processes. Multiple writers must not share a worktree merely because they use different branches.

1. Before any write, run `pwd`, `git status --short --branch`, and `git worktree list`. Confirm the repository, assigned branch, base revision, and existing changes. Never assume the starting worktree belongs exclusively to this task.
2. For one sequential task in an exclusively owned, clean worktree, a dedicated branch is sufficient. Use descriptive names such as `fix/<topic>`, `feat/<topic>`, `refactor/<topic>`, or `docs/<topic>`. Continue an existing assigned task branch rather than creating unnecessary branches.
3. For independent tasks or agents writing concurrently, use one task branch AND one separate worktree per writer. Create sibling worktrees outside the repository to avoid recursive test discovery. Never switch branches underneath another agent or check out the same branch in multiple worktrees using force options.
4. Read-only research/review agents may share a worktree if they perform no writes, installs, formatting, or build/test commands that produce files. Their observations can become stale while the owner edits; review a recorded commit or stable diff when correctness depends on an exact revision.
5. Before delegation, record each writer's task, worktree path, branch, base commit, owned files/areas, and acceptance checks in the task handoff. Give every command an explicit working directory. The coordinator owns integration and assigns a single writer for overlapping changes; parallelize non-overlapping work or serialize dependent tasks.
6. Keep `master` for integration. Do not implement directly on it unless the user explicitly requests that. If requested while the current worktree has unrelated changes, use an available clean `master` worktree or create one; do not move those changes onto `master`. Do not use another agent's worktree without coordination.
7. Do not stash, reset, clean, discard, stage, or commit someone else's changes. Avoid `git add .` and `git add -A`; stage explicit owned paths only when committing is authorized. If an unexpected edit appears in your assigned files, stop and coordinate instead of overwriting it.
8. Commit, merge, cherry-pick, push, or open a pull request only when authorized by the user/task. Integration is serial: inspect each diff, resolve overlaps deliberately, then rerun affected checks on the combined result. Use Conventional Commits when a commit is requested. Never rewrite shared history without explicit approval.
9. Handoff must include branch/worktree, changed paths, commit IDs if any, exact checks and results, and remaining limitations. Do not remove worktrees or delete branches without authorization; verify clean status and preservation of all work first. Never force-remove an active or dirty worktree.

Example setup, after checking branch/path availability and the intended base:

```bash
# A single writer in an exclusively owned, clean worktree:
git switch -c fix/topic master

# An independent concurrent writer; run from an existing repository worktree:
git worktree add -b fix/other-topic ../Tuan9Router-fix-other-topic master
```

These are alternatives, not steps to run blindly. Use the agreed base commit or task branch for dependent work, not automatically the latest `master`. Worktrees share Git refs/configuration; do not change repository-wide settings or remote refs as incidental cleanup. Uncommitted files, including this guide, are not copied to new worktrees: ensure each agent receives the applicable instructions explicitly until they exist in its base commit.

## Runtime and commands

The root package declares Bun in `packageManager` and uses Bun for Next.js scripts. The SQLite driver requires `bun:sqlite`; do not assume a Node.js database fallback exists. Use the declared package-manager version when available and report mismatches.

Run from the task worktree root:

```bash
bun install --frozen-lockfile
bun run dev
bun run build
bun run start
```

- `dev` and `start` explicitly default to port `20127`. `dev:webpack` and `build:webpack` are available; `postbuild` copies standalone assets. Confirm current scripts before changing how the app starts.
- There is no root `test` or `lint` script. With root dependencies installed, lint changed supported files with `bunx --no-install eslint <changed-files>`.
- Install test dependencies separately: `(cd tests && bun install --frozen-lockfile)`. Do not generate npm/yarn lockfiles alongside the committed Bun lockfiles. Change dependencies or lockfiles only when required by the task.
- Run a focused test from `tests/`, for example `(cd tests && bun run test --config vitest.config.js unit/capabilities.test.js)`. The explicit config preserves the `@/` and `open-sse` aliases. Substitute the test covering the change.
- `bun run test` invokes Vitest; it is not `bun test`. Tests that exercise the Bun-only database need Bun execution or an appropriate mock; do not add a production fallback just to satisfy a Node test runner.
- Inspect test setup before broad runs: some tests access providers, credentials, storage, or local services. `*.test.cjs`, `*.test.mjs`, and shell checks are not included by the current Vitest `**/*.test.js` pattern; run the relevant documented runner separately.
- For translator tests, import `tests/translator/registerAll.js` using the correct relative path so registration actually occurs. Treat old `cd app` examples as stale; this checkout's app is the repository root.

## Isolation and security

- Each running worktree needs its own port, dependencies/build output, temporary fixtures, and disposable database. Do not share `.next`, symlink another task's `node_modules`, kill processes by name, or restart an existing server to free a port. Track and stop only processes started by your task.
- Set a task-specific `DATA_DIR` before tests/server runs that write state. SQLite lives at `DATA_DIR/db/data.sqlite`; the default data directory is `~/.9router`. `DATA_DIR` alone is not full isolation: usage/logging and some tests may still use the home directory. Inspect these paths and use mocks or a disposable home/container where needed.
- Never test migrations, quota updates, credential refresh, or destructive operations against the user's real database. Preserve migration compatibility and data; do not delete state to make a test pass.
- Never commit or expose `.env` secrets, API keys, OAuth tokens/cookies, private keys, database files, or real request contents in logs, fixtures, screenshots, or reports. Use placeholders and mock credentials. Consult `.env.example`; do not overwrite an existing local environment file.
- Live provider tests, `RUN_REAL=1`, external uploads, deployment, package publishing, tunnel changes, and production operations require explicit authorization. Do not assume a test is offline because it is named `unit`.
- Preserve authentication, input validation, SSRF protection, and the socket-derived client-IP/forwarding-header sanitization in `custom-server.js`. Do not trust user-supplied proxy headers or weaken security checks for convenience.

## Implementation and verification

- Match nearby plain JavaScript/ESM, naming, formatting, and comment style. `@/*` resolves to `src/*`. Do not introduce TypeScript or a new framework for a localized change.
- Keep app-specific persistence/UI out of the provider-agnostic engine. Use existing config/schema constants and translator concerns; retain streaming and non-streaming compatibility, tool-call IDs, reasoning content, usage accounting, abort handling, and terminal events when touching the request pipeline.
- Follow the engine guide for provider/executor/translator additions. New translators need registration imports. Generated registry import lists must be regenerated, not hand-edited; inspect the generator's scope before running it. Do not run migration/generation scripts blindly.
- Add or update a focused regression test for behavior changes using the existing test infrastructure. For a fixed `it.fails` case, convert it to a normal assertion and verify it. Do not update snapshots or known-failure lists merely to hide a regression.
- Run the smallest relevant checks first, then affected suites and a build when the change warrants it. For catalog/alias changes, inspect the applicable scripts under `tests/__baseline__/` and run relevant checks; recorded baselines may themselves be stale.
- Report actual commands, pass/fail/skip results, and blockers. Distinguish demonstrated pre-existing failures from new regressions using the same checks on an isolated base revision when needed. Never claim a full pass from one focused test.
- Before handoff, inspect the final diff and `git status`, run `git diff --check`, and verify that only intended files changed. For documentation-only changes, validate referenced paths/commands and whitespace; an application build is unnecessary.
- Reply in the user's language. Summarize the outcome, exact file/worktree location, verification, and whether changes remain uncommitted; do not dump whole files.
