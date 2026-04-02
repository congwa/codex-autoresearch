---
name: current-chat-autoresearch
description: Use codex-autoresearch from the current Codex chat and current working directory. Prefer this when the user wants the recent chat window to become a resumable long-running task without leaving the chat.
argument-hint: "[task-or-intent]"
---

Use `codex-autoresearch` as the execution layer for the current chat, without asking the user for `workdir`, `state-dir`, or session ids unless they explicitly want a different directory.

## Business Route

This skill exists for the “I am already in the right Codex chat and the right directory” scenario.

Default business rules:

1. Treat the current working directory as the execution directory.
2. Treat the current chat as the intent source, not as a readable thread id.
3. Only summarize the latest 8 turns from the current chat window.
4. Before running anything, summarize the concrete task, constraints, and unfinished work from those latest 8 turns.
5. Prefer the MCP route tool first, so the plugin can decide whether this chat should continue the latest current-directory task, start a new task, or run an explicit repository skill.
6. If the current chat is still too vague to summarize into one concrete task, ask the user to restate the goal in one sentence before running anything.

## MCP-First Rules

Preferred route:

1. Extract a concise `chatIntent` from the user’s latest message.
2. Extract `chatWindowTurns` from the latest 8 turns of the current chat window.
3. Extract a concrete `chatSummary` from those latest 8 turns.
4. If the user explicitly named a repository skill such as `research` or `phased-validation`, call `run_skill_from_current_chat` and pass `skillName`.
5. Otherwise call `start_from_current_chat`.
6. Let the selected MCP tool choose whether this should:
   - resume the latest current-directory task
   - start a fresh task from the recent chat window
   - run the named repository skill
7. If the tool returns `status: "needs_confirmation"`, explain the conflict and ask the user whether to continue the old task or start a new one.

## Recommended Natural-Language Examples

These are examples, not the only valid phrases:

```text
用 codex-autoresearch 把我们刚才聊的需求跑成一个永动机任务。
用 codex-autoresearch 继续做我们刚才这个任务。
把我们当前聊天最近几轮的内容交给 codex-autoresearch 去继续执行。
用 research skill 处理我们当前聊天刚才讨论的需求。
用 phased-validation skill 把我们刚才这个长任务接起来。
```

## Explicit Repository Skill Route

When the user explicitly says a repository skill name in the current chat:

1. Keep the current chat as the business context source.
2. Keep the current working directory as the execution scope.
3. Summarize the latest 8 turns.
4. Pass the named repository skill to `run_skill_from_current_chat` instead of running a generic direct task.
5. Let `run_skill_from_current_chat` infer the repository skill inputs from the recent chat window and start the long-running task from that recipe.

## Continue Route

If the user says anything equivalent to “用 codex-autoresearch 继续做”, “继续做”, “继续当前目录任务”, or “pick up where we left off”, do not create a new task immediately. First summarize the latest 8 turns from the current chat, then call `continue_current_directory_task`.

The current chat decides what should continue. The current directory decides which codex-autoresearch task chain should be attached.

If the latest task goal from the current chat is clearly different from the current directory’s latest codex-autoresearch task, do not silently resume. Explain the conflict and ask whether the user wants to continue the old task or start a new one.

## Shell Fallback

Shell commands are fallback only when MCP is unavailable.

Fallback order:

```bash
codex-autoresearch "<task summarized from the latest 8 turns of the current chat>"
```

If the binary is not on `PATH`, use:

```bash
node ./dist/src/cli.js "<task summarized from the latest 8 turns of the current chat>"
```

If the build does not exist yet but the current directory is this repo, build it first:

```bash
npm install
npm run build
node ./dist/src/cli.js "<task summarized from the latest 8 turns of the current chat>"
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
5. Do not read the whole chat history when the latest 8 turns are enough.
6. Do not mechanically run `resume --last` before checking what the current chat is actually asking to continue.
7. Do not make shell commands the primary path when MCP is available.
