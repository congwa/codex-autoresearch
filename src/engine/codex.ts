/**
 * 业务职责：Codex 进程适配层负责把统一执行引擎翻译成实际的 `codex exec/resume` 调用，
 * 并把结构化事件与运行日志稳定追加到任务状态目录中。
 */
import { createWriteStream } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { JobMetadata } from "./state.js";
import { JobError } from "./error.js";

/**
 * 业务职责：Codex 运行选项描述单轮实际下发给 CLI 的 prompt 和模式，
 * 让统一执行引擎可以在“首轮执行”和“续跑执行”之间稳定切换。
 */
export interface CodexRunOptions {
  codexBin: string;
  prompt: string;
  mode: "initial" | "resume";
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * 业务职责：按照现有 Bash 语义拼装 Codex 参数，保证迁移后仍兼容原有 model、profile 和安全开关。
 */
export function buildCodexArgs(metadata: JobMetadata, options: CodexRunOptions): string[] {
  const args = options.mode === "initial" ? ["exec", "--json", "-o", metadata.lastMessageFile] : ["exec", "resume", "--json", "-o", metadata.lastMessageFile];

  if (metadata.dangerouslyBypass) {
    // 业务约束：显式危险绕过优先级高于 full-auto，避免两个安全模式同时生效造成语义混乱。
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (metadata.fullAuto) {
    args.push("--full-auto");
  }

  if (metadata.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }

  if (metadata.model) {
    args.push("-m", metadata.model);
  }

  if (metadata.profile) {
    args.push("--profile", metadata.profile);
  }

  if (options.mode === "initial") {
    args.push("-C", metadata.workdir, options.prompt);
    return args;
  }

  if (metadata.sessionId) {
    // 业务约束：已绑定会话时必须优先命中同一条 Codex 上下文，不能退回模糊的 `--last`。
    args.push(metadata.sessionId);
  } else {
    // 业务约束：只有在还没拿到稳定 session id 时才允许使用 `--last` 作为恢复兜底。
    args.push("--last");
  }

  args.push(options.prompt);
  return args;
}

/**
 * 业务职责：执行一次真实 Codex 调用，并把 stdout/stderr 分流到事件日志和 runner 日志中供恢复与排障使用。
 */
export async function runCodex(metadata: JobMetadata, options: CodexRunOptions): Promise<number> {
  const args = buildCodexArgs(metadata, options);
  const promptPreview = options.prompt.length > 200 ? `${options.prompt.slice(0, 200)}...` : options.prompt;
  const logLine = `[${new Date().toISOString()}] ${options.codexBin} ${args.slice(0, -1).join(" ")} <prompt: ${promptPreview}>\n`;
  await appendFile(metadata.runnerLogFile, logLine, "utf8");

  const stdoutStream = createWriteStream(metadata.eventLogFile, { flags: "a" });
  const stderrStream = createWriteStream(metadata.runnerLogFile, { flags: "a" });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(options.codexBin, args, {
      cwd: options.mode === "resume" ? metadata.workdir : undefined,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    if (options.onEvent) {
      let buf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            try { options.onEvent!(JSON.parse(line)); } catch { /* skip unparseable lines */ }
          }
        }
      });
    }

    child.on("error", (error) => {
      reject(new JobError("CODEX_SPAWN_FAILED", `Failed to start codex binary \`${options.codexBin}\`: ${error.message}`, false));
    });
    child.on("close", (code) => resolve(code ?? 1));
  }).finally(() => {
    stdoutStream.end();
    stderrStream.end();
  });

  await appendFile(metadata.runnerLogFile, `[${new Date().toISOString()}] exited with code ${exitCode}\n`, "utf8");
  return exitCode;
}

/**
 * 业务职责：从结构化事件流中提取会话标识，帮助后续 resume 精准命中已有上下文而不是模糊用 `--last`。
 */
export async function discoverSessionId(eventLogFile: string): Promise<string | undefined> {
  try {
    const content = await readFile(eventLogFile, "utf8");
    const matches = [...content.matchAll(/"(?:session_id|conversation_id|thread_id)"\s*:\s*"([0-9a-fA-F-]{36})"/g)];
    return matches.at(-1)?.[1];
  } catch {
    return undefined;
  }
}
