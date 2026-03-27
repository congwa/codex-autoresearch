---
name: current-chat-autoresearch
description: Use codex-autoresearch from the current Codex chat and current working directory. Prefer this when the user wants codex-autoresearch to act on what they are already discussing in the current chat.
argument-hint: "[task-or-intent]"
---

Use `codex-autoresearch` as the execution layer for the current chat, without asking the user for `workdir`, `state-dir`, or session ids unless they explicitly want a different directory.

## Business Route

This skill exists for the “I am already in the right Codex chat and the right directory” scenario.

Default business rules:

1. Treat the current working directory as the execution directory.
2. Treat the current chat as the intent source, not as a readable thread id.
3. Before running anything, summarize the latest concrete task, constraints, and unfinished business from the current chat.
4. Prefer the MCP route tool first, so the plugin can decide whether this chat should continue the latest current-directory task or open a new one.
5. If the current chat is still too vague to summarize into one concrete task, ask the user to restate the goal in one sentence before running anything.

## MCP-First Rules

Preferred route:

1. Extract a concise `chatIntent` from the user’s latest message.
2. Extract a concrete `chatSummary` from the current chat context.
3. Call the MCP tool `route_chat_intent`.
4. Let `route_chat_intent` choose whether to resume the latest current-directory task or start a new task.
5. If the tool returns `status: "needs_confirmation"`, explain the conflict and ask the user whether to continue the old task or start a new one.

Use the following fixed phrases as the recommended chat-side prompts:

```text
用 codex-autoresearch 处理我们当前聊天里正在讨论的需求。
用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。
用 codex-autoresearch 在当前目录开一个新任务。
```

## MCP Tool Contract

`route_chat_intent` is the primary route for this skill.

It must receive:

1. `chatIntent`: the user’s current natural-language request
2. `chatSummary`: the summarized business goal from the current chat
3. Optional `workdir`, `stateDir`, `model`, `profile`, `maxAttempts` only when the user explicitly overrides defaults

It may return:

1. `action: "resume_session"` when the current chat clearly means “continue”
2. `action: "run_task"` when the current chat clearly means “start or restate a task”
3. `action: "conflict"` with `status: "needs_confirmation"` when the current chat goal conflicts with the latest current-directory task

## Continue Route

If the user says anything equivalent to “用 codex-autoresearch 继续做”, “继续做”, “继续当前目录任务”, or “pick up where we left off”, do not create a new task immediately. First summarize the latest task goal and unfinished business from the current chat, then call `route_chat_intent`.

The current chat decides what should continue. The current directory decides which codex-autoresearch task chain to attach to.

If the latest task goal from the current chat is clearly different from the current directory’s latest codex-autoresearch task, do not silently resume. Explain the conflict and ask whether the user wants to continue the old task or start a new one.

## Shell Fallback

Shell commands are fallback only when MCP is unavailable.

Fallback order:

```bash
codex-autoresearch "<task summarized from the current chat>"
```

If the binary is not on `PATH`, use:

```bash
node ./dist/src/cli.js "<task summarized from the current chat>"
```

If the build does not exist yet but the current directory is this repo, build it first:

```bash
npm install
npm run build
node ./dist/src/cli.js "<task summarized from the current chat>"
```

For explicit continue fallback, use:

```bash
codex-autoresearch session resume --last
```

## Never Do

1. Do not ask for `workdir` if the current directory is already the intended project.
2. Do not ask for `state-dir` in normal current-chat use.
3. Do not attach to the global most recent session from another project.
4. Do not pretend to know the current chat id.
5. Do not mechanically run `resume --last` before checking what the current chat is actually asking to continue.
6. Do not make shell commands the primary path when MCP is available.
