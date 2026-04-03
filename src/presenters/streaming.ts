/**
 * 业务职责：流式终端 presenter 在任务执行过程中实时输出彩色进度到 stderr，
 * 让用户像 `tail -f` 一样观察每轮 attempt 的 AI 回复和工具调用。
 *
 * 事件格式基于 codex exec --json 的实际输出：
 * - thread.started: { type, thread_id }
 * - turn.started / turn.completed: { type, usage? }
 * - item.started / item.completed: { type, item: { id, type, ... } }
 *   item.type 可为: agent_message, command_execution, mcp_tool_call, file_change
 */

export interface StreamCallbacks {
  onAttemptStart: (attempt: number) => void;
  onAttemptEnd: (attempt: number, exitCode: number, elapsed: number) => void;
  onEvent: (event: Record<string, unknown>) => void;
}

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K\r";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function createStreamingPresenter(stream: NodeJS.WritableStream): StreamCallbacks {
  const isTTY = (stream as { isTTY?: boolean }).isTTY === true;
  const c = (code: string, text: string) => (isTTY ? `${code}${text}${RESET}` : text);

  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let spinnerFrame = 0;
  let spinnerLabel = "";

  function startSpinner(label: string): void {
    if (!isTTY) return;
    stopSpinner();
    spinnerLabel = label;
    spinnerFrame = 0;
    stream.write(HIDE_CURSOR);
    spinnerTimer = setInterval(() => {
      const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
      stream.write(`${CLEAR_LINE}${c(DIM, `${frame} ${spinnerLabel}`)}`);
      spinnerFrame++;
    }, 80);
  }

  function stopSpinner(): void {
    if (spinnerTimer !== undefined) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
      stream.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
    }
  }

  function write(text: string): void {
    stopSpinner();
    stream.write(text);
  }

  function formatTime(): string {
    return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  }

  function formatElapsed(ms: number): string {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
  }

  return {
    onAttemptStart(attempt: number) {
      const line = `━━━━ 第 ${attempt} 轮 ${"━".repeat(30)}  ${formatTime()}`;
      write(`\n${c(CYAN, line)}\n`);
      startSpinner("等待响应...");
    },

    onAttemptEnd(attempt: number, exitCode: number, elapsed: number) {
      const line = `━━━━ 第 ${attempt} 轮结束 (exit ${exitCode}, 耗时 ${formatElapsed(elapsed)}) ${"━".repeat(10)}`;
      write(`${c(CYAN, line)}\n`);
    },

    onEvent(event: Record<string, unknown>) {
      const eventType = event.type as string | undefined;
      const item = event.item as Record<string, unknown> | undefined;
      const itemType = item?.type as string | undefined;

      // --- turn.completed: 显示 token 用量 ---
      if (eventType === "turn.completed") {
        const usage = event.usage as { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } | undefined;
        if (usage) {
          const parts: string[] = [];
          if (usage.input_tokens) parts.push(`in:${usage.input_tokens}`);
          if (usage.cached_input_tokens) parts.push(`cached:${usage.cached_input_tokens}`);
          if (usage.output_tokens) parts.push(`out:${usage.output_tokens}`);
          write(`${c(DIM, `   📊 tokens: ${parts.join(", ")}`)}\n`);
        }
        return;
      }

      if (!item || !itemType) return;

      // --- agent_message: AI 的文本回复 ---
      if (itemType === "agent_message") {
        const text = item.text as string | undefined;
        if (text && eventType === "item.completed") {
          write(`${c(GREEN, "🤖 " + text)}\n`);
          startSpinner("思考中...");
        }
        return;
      }

      // --- command_execution: shell 命令 ---
      if (itemType === "command_execution") {
        const command = item.command as string | undefined;
        const status = item.status as string | undefined;

        if (eventType === "item.started" && command) {
          // 从 /bin/zsh -lc "actual command" 中提取实际命令
          const actual = extractShellCommand(command);
          write(`${c(YELLOW, "🔧 " + truncate(actual, 120))}\n`);
          startSpinner(`执行命令...`);
          return;
        }

        if (eventType === "item.completed") {
          const exitCode = item.exit_code as number | undefined;
          const output = item.aggregated_output as string | undefined;
          const outputPreview = output ? truncate(output, 200) : "";
          if (outputPreview) {
            write(`${c(DIM, "   ↳ " + outputPreview)}\n`);
          }
          if (status === "completed" && exitCode !== undefined && exitCode !== 0) {
            write(`${c(RED, `   ✗ exit ${exitCode}`)}\n`);
          }
          startSpinner("思考中...");
          return;
        }
        return;
      }

      // --- mcp_tool_call: MCP 工具调用 ---
      if (itemType === "mcp_tool_call") {
        const server = item.server as string | undefined;
        const tool = item.tool as string | undefined;
        const args = item.arguments as Record<string, unknown> | undefined;
        const status = item.status as string | undefined;
        const error = item.error as { message?: string } | undefined;

        if (eventType === "item.started") {
          const argsSummary = args ? truncate(JSON.stringify(args), 100) : "";
          const label = [server, tool].filter(Boolean).join("/");
          write(`${c(YELLOW, `🔧 ${label}`)}${argsSummary ? `(${c(DIM, argsSummary)})` : ""}\n`);
          startSpinner(`执行 ${label}...`);
          return;
        }

        if (eventType === "item.completed") {
          if (status === "failed" && error?.message) {
            write(`${c(RED, `   ✗ ${error.message}`)}\n`);
          } else {
            const result = item.result;
            if (result) {
              write(`${c(DIM, "   ↳ " + truncate(typeof result === "string" ? result : JSON.stringify(result), 200))}\n`);
            }
          }
          startSpinner("思考中...");
          return;
        }
        return;
      }

      // --- file_change: 文件变更 ---
      if (itemType === "file_change" && eventType === "item.completed") {
        const changes = item.changes as Array<{ path?: string; kind?: string }> | undefined;
        if (changes && changes.length > 0) {
          for (const change of changes) {
            const kind = change.kind ?? "change";
            const filePath = change.path ?? "unknown";
            const icon = kind === "create" ? "+" : kind === "delete" ? "-" : "~";
            write(`${c(BLUE, `📝 [${icon}] ${filePath}`)}\n`);
          }
          startSpinner("思考中...");
        }
        return;
      }

      // 其他 item.started 事件不输出，避免重复
    }
  };
}

/**
 * 从 `/bin/zsh -lc "actual command"` 格式中提取实际命令。
 */
function extractShellCommand(raw: string): string {
  const match = raw.match(/^\/bin\/(?:ba)?sh\s+-\w+\s+"(.+)"$/s);
  return match ? match[1] : raw;
}

function truncate(s: string, maxLen: number): string {
  const oneLine = s.replace(/\n/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  const omitted = oneLine.length - maxLen;
  return `${oneLine.slice(0, maxLen)}...(+${omitted} chars)`;
}
