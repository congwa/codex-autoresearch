---
name: codex-autoresearch
description: Trigger codex-autoresearch directly from the current Codex chat window. Use this as the canonical chat-side entry when the user wants the recent chat window to become a long-running task.
argument-hint: ""
---

Use this skill as the chat-window-native entry for `codex-autoresearch`.

## Business Route

This skill exists for the exact user habit of:

1. entering a project with `codex` or `codex resume`
2. discussing the task in the current chat
3. then triggering the long-running autoresearch flow without going back to shell

Default business rules:

1. Treat the current chat window as the only intent source.
2. Only summarize the latest 8 turns from the current chat window.
3. Treat the current working directory as the execution boundary.
4. Do not ask for `workdir`, `state-dir`, or session id in normal chat-window use.
5. `/codex-autoresearch` should behave like “take the recent chat window and decide whether to continue or start”.

## Slash Route

When the user triggers `/codex-autoresearch` in the current chat window:

1. Read only the latest 8 turns from the current chat window.
2. Summarize the concrete goal, constraints, and unfinished work from those turns.
3. Call MCP tool `start_from_current_chat`.
4. Pass:
   - `chatIntent: "/codex-autoresearch"`
   - `chatWindowTurns`: the latest 8 turns
   - `chatSummary`: the one-paragraph summary you just produced
5. Let `start_from_current_chat` choose whether to:
   - resume the latest current-directory task
   - start a new direct task
   - ask for confirmation if the recent chat goal conflicts with the latest current-directory task

## Never Do

1. Do not read the whole conversation history when the latest 8 turns are enough.
2. Do not search for some other chat or global recent session.
3. Do not blindly run `resume --last` without checking what the latest 8 turns are asking for.
4. Do not fall back to shell commands unless MCP is unavailable.
