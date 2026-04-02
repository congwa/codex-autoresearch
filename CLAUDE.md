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

2. **Application** (`src/application/`) — Business use cases: direct task, prompt file task, skill run, resume session, status query. All entry points (CLI, MCP) converge here via `use-cases.ts`. Types in `types.ts`, execution context in `context.ts`.

3. **Transports**:
   - **CLI** (`src/cli.ts`) — Commander-based CLI with subcommands: `run` (supports `--prompt-file`), `skill`, `session`, `mcp serve`, `app`, `legacy`.
   - **MCP** (`src/mcp/server.ts`) — MCP server exposing 7 tools: `start_task_from_prompt_file`, `run_task`, `run_skill`, `resume_session`, `get_session_status`, `tail_session`, `list_skills`.
   - **Presenter** (`src/presenters/json.ts`) — JSON output formatting.

Cross-cutting module:
- **Skills** (`src/skills/`) — Skill manifest parsing (`skill.yaml`), catalog discovery, input resolution, prompt rendering.

## Key Conventions

- ESM-only (`"type": "module"` in package.json), TypeScript strict mode, target ES2022, NodeNext module resolution.
- Node >= 20 required.
- Task definition comes from prompt files or explicit text parameters only. No chat-driven task definition.
- `promptSource` ("file" | "text" | "skill") and `sourcePromptFile` tracked in `meta.json` for traceability.
- Completion protocol: task is only `completed` when Codex outputs a nonce-reversed done token + `CONFIRMED: all tasks completed` on exactly two lines.
- State persisted to `.codex-run/<job-id>/` with `meta.json`, `events.jsonl`, `runner.log`, `last-message.txt`, `session-id.txt`.
- Skills live in `skills/<name>/skill.yaml` + `prompt.md`.
- `codex-keep-running.sh` is a shell thin wrapper that delegates to the Node CLI `legacy` command.
- New entry points should only add transport adapters; business logic stays in `application/`.

## MCP fire-and-forget

MCP execution tools (`run_task`, `start_task_from_prompt_file`, `run_skill`) use `fireAndForget: true` by default — they start the background task and return immediately with `pending` status. Callers should poll progress via `tail_session` or `get_session_status`. This avoids MCP transport timeout (120s) on long-running tasks. CLI does NOT use fire-and-forget; it blocks until completion.
