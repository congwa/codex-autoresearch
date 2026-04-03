/**
 * 业务职责：流式终端 presenter 在任务执行过程中实时输出彩色进度到 stderr，
 * 让用户像 `tail -f` 一样观察每轮 attempt 的 AI 回复和工具调用。
 */

export interface StreamCallbacks {
  onAttemptStart: (attempt: number) => void;
  onAttemptEnd: (attempt: number, exitCode: number, elapsed: number) => void;
  onEvent: (event: Record<string, unknown>) => void;
}

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function createStreamingPresenter(stream: NodeJS.WritableStream): StreamCallbacks {
  const isTTY = (stream as { isTTY?: boolean }).isTTY === true;
  const c = (code: string, text: string) => (isTTY ? `${code}${text}${RESET}` : text);

  function write(text: string): void {
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
    },

    onAttemptEnd(attempt: number, exitCode: number, elapsed: number) {
      const line = `━━━━ 第 ${attempt} 轮结束 (exit ${exitCode}, 耗时 ${formatElapsed(elapsed)}) ${"━".repeat(10)}`;
      write(`${c(CYAN, line)}\n`);
    },

    onEvent(event: Record<string, unknown>) {
      const type = event.type as string | undefined;

      // Codex JSON streaming events have an `item` wrapper
      const item = event.item as Record<string, unknown> | undefined;
      const itemType = item?.type as string | undefined;

      // Assistant message content
      if (itemType === "message" || type === "message") {
        const content = extractTextContent(item ?? event);
        if (content) {
          write(`${c(GREEN, "🤖 ")}${content}\n`);
          return;
        }
      }

      // Tool calls
      if (itemType === "function_call" || itemType === "tool_call" || itemType === "mcp_tool_call") {
        const name = (item?.name ?? item?.function_name ?? (item?.call as Record<string, unknown>)?.name ?? itemType) as string;
        const args = item?.arguments ?? item?.params;
        const argsSummary = args ? truncate(typeof args === "string" ? args : JSON.stringify(args), 100) : "";
        write(`${c(YELLOW, `🔧 ${name}`)}${argsSummary ? `(${c(DIM, argsSummary)})` : ""}\n`);
        return;
      }

      // Tool results - show briefly
      if (itemType === "function_call_output" || itemType === "tool_call_output" || itemType === "mcp_tool_call_output") {
        const output = truncate(String(item?.output ?? item?.content ?? ""), 200);
        if (output) {
          write(`${c(DIM, `   ↳ ${output}`)}\n`);
        }
        return;
      }

      // Response completed/content delta events with text
      if (type === "response.output_item.done" || type === "response.content_part.done") {
        const content = extractTextContent(item ?? event);
        if (content) {
          write(`${c(GREEN, "🤖 ")}${content}\n`);
          return;
        }
      }

      // Content text delta for streaming text
      if (type === "response.output_text.delta") {
        const delta = (event.delta as string) ?? "";
        if (delta) {
          write(c(GREEN, delta));
          return;
        }
      }

      // Skip noisy/unknown events silently
    }
  };
}

function extractTextContent(obj: Record<string, unknown>): string | undefined {
  // Direct text field
  if (typeof obj.text === "string" && obj.text.trim()) {
    return obj.text.trim();
  }

  // Content array with text parts
  const content = obj.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((part: unknown) => (part as Record<string, unknown>)?.type === "output_text" || (part as Record<string, unknown>)?.type === "text")
      .map((part: unknown) => ((part as Record<string, unknown>).text as string) ?? "")
      .filter(Boolean);
    if (texts.length > 0) {
      return texts.join("\n").trim();
    }
  }

  // Message field
  if (typeof obj.message === "string" && obj.message.trim()) {
    return obj.message.trim();
  }

  return undefined;
}

function truncate(s: string, maxLen: number): string {
  const oneLine = s.replace(/\n/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}...` : oneLine;
}
