---
name: continue-current-directory
description: Continue the most recent codex-autoresearch task for the current working directory. Use this when the user wants to keep going in the same project without re-explaining the task.
argument-hint: ""
---

Resume the current directory’s most recent codex-autoresearch task.

## Business Route

This skill exists for the “continue what we were already doing here” scenario.

Default business rules:

1. Always scope resume to the current working directory.
2. Before resuming, reference the latest business goal, constraints, and unfinished work visible in the current chat.
3. Prefer the current directory’s latest `.codex-run` state only after the current chat makes it clear what should continue.
4. Reuse the existing task chain when the current chat goal and the current directory’s latest codex-autoresearch task still match.
5. If the current chat goal and the current directory’s latest codex-autoresearch task clearly diverge, explain the mismatch and ask whether to continue the old task or start a new one.

## MCP-First Rules

Preferred route:

1. First summarize the latest business goal and unfinished work from the current chat.
2. Call MCP tool `route_chat_intent` with a continue-style `chatIntent`.
3. Let `route_chat_intent` decide whether the latest current-directory task can be safely resumed.
4. If the tool returns `action: "conflict"`, ask the user whether to continue the old task or start a new one.

This skill should treat the current chat as the meaning source and the current directory as the attachment scope.

## Chat-First Resume Rule

This skill exists for the “I am already inside a Codex chat and want codex-autoresearch to keep going” scenario.

Use a two-stage rule:

1. The current chat decides what should continue.
2. The current directory decides which codex-autoresearch state chain should be resumed.

If the current chat does not provide a sufficiently concrete goal yet, ask for a one-sentence restatement before resuming.

## Shell Fallback

If MCP is unavailable, use:

```bash
node ./dist/src/cli.js session resume --last
```

Preferred installed command:

```bash
codex-autoresearch session resume --last
```

If the local build is missing and the current directory is this repo:

```bash
npm install
npm run build
node ./dist/src/cli.js session resume --last
```

## Fallback Behavior

If no resumable session exists in the current directory, explain that no current-directory task was found and then start a fresh task only if the user explicitly asks for that next step.

## Never Do

1. Do not default to a global recent session outside the current project.
2. Do not ask for session ids unless the user explicitly wants a specific one.
3. Do not restart the task from scratch when `resume --last` is the right route.
4. Do not treat “continue” as a blind resume command when the current chat goal is ambiguous or conflicts with the latest local task.
5. Do not make shell commands the primary path when MCP routing is available.
