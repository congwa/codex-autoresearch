# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test

```bash
npm install
npm run build          # tsc -> dist/
npm test               # vitest run
```

Entry point after build: `./dist/src/cli.js`

## Architecture

Three-layer design (engine → application → transport):

1. **Engine** (`src/engine/`) — Codex process invocation, completion protocol (nonce-based done token), state directory management (`<stateRoot>/<job-id>/`), job lifecycle, and daemon-style resume loop. The `runLoop` in `job.ts` is a `while(true)` loop that keeps calling `codex exec` / `codex exec resume` until the completion protocol is satisfied.

2. **Application** (`src/application/`) — Business use cases: direct task, prompt file task, resume session, status query. All entry points converge here via `use-cases.ts`. Types in `types.ts`, execution context in `context.ts`.

3. **Transports**:
   - **CLI** (`src/cli.ts`) — Commander-based CLI with subcommands: `run` (supports `--prompt-file`), `session` (resume/status), `app`, `legacy`.
   - **Presenter** (`src/presenters/json.ts`) — JSON output formatting.

## Key Conventions

- ESM-only (`"type": "module"` in package.json), TypeScript strict mode, target ES2022, NodeNext module resolution.
- Node >= 20 required.
- Task definition comes from prompt files or explicit text parameters only. No chat-driven task definition.
- `promptSource` ("file" | "text") and `sourcePromptFile` tracked in `meta.json` for traceability.
- Completion protocol: task is only `completed` when Codex outputs a nonce-reversed done token + `CONFIRMED: all tasks completed` on exactly two lines.
- State persisted to `.codex-run/<job-id>/` with `meta.json`, `events.jsonl`, `runner.log`, `last-message.txt`, `session-id.txt`.
- `codex-keep-running.sh` is a shell thin wrapper that delegates to the Node CLI `legacy` command.
- New entry points should only add transport adapters; business logic stays in `application/`.
