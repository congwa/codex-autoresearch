/**
 * 业务职责：状态模块负责把每个长任务执行过程固定落盘到 `.codex-run/<job-id>`，
 * 让 CLI、兼容脚本和 MCP 客户端都能共享同一份会话、快照和恢复元信息。
 */
import { mkdir, readFile, readdir, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CompletionProtocol } from "./completion.js";
import type { JobErrorInfo } from "./error.js";

/**
 * 业务职责：任务状态枚举统一表达长任务在守护链路中的生命周期阶段，
 * 供状态文件、CLI、MCP 和测试围绕同一组状态值判断下一步动作。
 */
export type JobStatus = "pending" | "running" | "needs_resume" | "completed" | "failed";

/**
 * 业务职责：任务元信息是状态目录里的核心业务记录，
 * 保存任务身份、执行配置、完成协议、错误摘要和关键文件路径，供所有入口共享。
 */
export interface JobMetadata {
  jobId: string;
  stateDir: string;
  stateRoot: string;
  workdir: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  status: JobStatus;
  attemptCount: number;
  lastExitCode?: number;
  confirmText: string;
  nonce: string;
  doneToken: string;
  model?: string;
  profile?: string;
  fullAuto: boolean;
  dangerouslyBypass: boolean;
  skipGitRepoCheck: boolean;
  startWithResumeIfPossible: boolean;
  lastError?: JobErrorInfo;
  promptSource?: "file" | "text";
  sourcePromptFile?: string;
  lastMessageFile: string;
  eventLogFile: string;
  runnerLogFile: string;
  sessionIdFile: string;
  metaFile: string;
}

/**
 * 业务职责：状态布局选项描述状态根目录、精确目录和 job id 三种布局控制方式，
 * 让 direct task、resume 和兼容层都能在同一套目录规则下落盘。
 */
export interface StateLayoutOptions {
  stateRoot?: string;
  exactStateDir?: string;
  jobId?: string;
}

/**
 * 业务职责：统一计算任务目录结构，保证不同入口对状态文件的命名和落盘位置完全一致。
 */
export function createStateLayout(options: StateLayoutOptions = {}): Pick<JobMetadata, "jobId" | "stateDir" | "stateRoot" | "lastMessageFile" | "eventLogFile" | "runnerLogFile" | "sessionIdFile" | "metaFile"> {
  const stateRoot = path.resolve(options.stateRoot ?? ".codex-run");
  const jobId = options.jobId ?? randomUUID();
  const stateDir = options.exactStateDir ? path.resolve(options.exactStateDir) : path.join(stateRoot, jobId);

  return {
    jobId,
    stateDir,
    stateRoot,
    lastMessageFile: path.join(stateDir, "last-message.txt"),
    eventLogFile: path.join(stateDir, "events.jsonl"),
    runnerLogFile: path.join(stateDir, "runner.log"),
    sessionIdFile: path.join(stateDir, "session-id.txt"),
    metaFile: path.join(stateDir, "meta.json")
  };
}

/**
 * 业务职责：初始化或恢复任务元信息，让任务重启时依然能沿用原有协议、session 和配置。
 */
export async function ensureJobMetadata(
  options: StateLayoutOptions & {
    workdir: string;
    protocol: CompletionProtocol;
    model?: string;
    profile?: string;
    fullAuto: boolean;
    dangerouslyBypass: boolean;
    skipGitRepoCheck: boolean;
    startWithResumeIfPossible: boolean;
    promptSource?: "file" | "text";
    sourcePromptFile?: string;
  }
): Promise<JobMetadata> {
  const layout = createStateLayout(options);

  await mkdir(layout.stateRoot, { recursive: true });
  await mkdir(layout.stateDir, { recursive: true });

  const existing = await readJobMetadata(layout.stateDir);
  if (existing) {
    // 业务约束：已有任务目录时直接复用元信息，避免重启守护进程时重新生成协议或冲掉历史链路。
    return existing;
  }

  const now = new Date().toISOString();
  const metadata: JobMetadata = {
    ...layout,
    workdir: path.resolve(options.workdir),
    createdAt: now,
    updatedAt: now,
    status: "pending",
    attemptCount: 0,
    confirmText: options.protocol.confirmText,
    nonce: options.protocol.nonce,
    doneToken: options.protocol.doneToken,
    model: options.model,
    profile: options.profile,
    fullAuto: options.fullAuto,
    dangerouslyBypass: options.dangerouslyBypass,
    skipGitRepoCheck: options.skipGitRepoCheck,
    startWithResumeIfPossible: options.startWithResumeIfPossible,
    promptSource: options.promptSource,
    sourcePromptFile: options.sourcePromptFile
  };

  await writeJobMetadata(metadata);
  await updateLatestPointers(metadata);
  return metadata;
}

/**
 * 业务职责：读取任务元信息，用于 resume、状态查询和 MCP 对外返回稳定的任务身份标识。
 */
export async function readJobMetadata(stateDir: string): Promise<JobMetadata | undefined> {
  const metaFile = path.join(stateDir, "meta.json");

  try {
    const content = await readFile(metaFile, "utf8");
    const metadata = JSON.parse(content) as JobMetadata;
    // 业务约束：session id 允许从 session-id.txt 补回，避免 meta 与事件流不同步时导致恢复失败。
    metadata.sessionId = metadata.sessionId ?? (await readSessionIdFile(path.join(stateDir, "session-id.txt")));
    return metadata;
  } catch {
    return undefined;
  }
}

/**
 * 业务职责：持续刷新元信息中的状态、尝试次数和 session 绑定结果，支撑守护执行和对外查询。
 */
export async function writeJobMetadata(metadata: JobMetadata): Promise<void> {
  metadata.updatedAt = new Date().toISOString();
  await writeFile(metadata.metaFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

/**
 * 业务职责：在任务进入新一轮执行前清理旧错误状态，避免历史失败信息误导当前运行结果。
 */
export async function clearJobError(metadata: JobMetadata): Promise<JobMetadata> {
  metadata.lastError = undefined;
  await writeJobMetadata(metadata);
  return metadata;
}

/**
 * 业务职责：记录每轮 assistant 最后输出，便于人工排障和自动化判断某轮是否已经完成。
 */
export async function snapshotAttempt(metadata: JobMetadata, attempt: number): Promise<void> {
  const snapshotFile = path.join(metadata.stateDir, `attempt-${String(attempt).padStart(4, "0")}.last.txt`);

  try {
    await copyFile(metadata.lastMessageFile, snapshotFile);
  } catch {
    // 没有最后消息时说明本轮 Codex 尚未落出输出，这里保持幂等即可。
  }
}

/**
 * 业务职责：把任务目录和兼容层最新指针同步到状态根目录，方便 `--last` 和老脚本继续工作。
 */
export async function updateLatestPointers(metadata: JobMetadata): Promise<void> {
  await mkdir(metadata.stateRoot, { recursive: true });
  await writeFile(path.join(metadata.stateRoot, "latest-job.txt"), `${metadata.jobId}\n`, "utf8");
}

/**
 * 业务职责：根据会话号反查任务目录，让外部 agent 或 CLI 能用稳定 session 继续同一条执行链路。
 */
export async function findJobBySessionId(stateRoot: string, sessionId: string): Promise<JobMetadata | undefined> {
  const jobs = await listJobs(stateRoot);
  return jobs.find((job) => job.sessionId === sessionId);
}

/**
 * 业务职责：读取最近一次任务标识，支撑 `session resume --last` 和兼容层的恢复入口。
 */
export async function readLatestJobId(stateRoot: string): Promise<string | undefined> {
  try {
    const content = await readFile(path.join(path.resolve(stateRoot), "latest-job.txt"), "utf8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 业务职责：列出状态根目录下所有任务，用于 session 查询和 `--last` 的回退搜索。
 */
export async function listJobs(stateRoot: string): Promise<JobMetadata[]> {
  const root = path.resolve(stateRoot);

  try {
    const entries = await readdir(root, { withFileTypes: true });
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => readJobMetadata(path.join(root, entry.name)))
    );

    return jobs.filter((job): job is JobMetadata => Boolean(job)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

/**
 * 业务职责：恢复任务时优先使用已绑定的 session-id 文件，保证 resume 命中同一条 Codex 会话。
 */
export async function readSessionIdFile(sessionIdFile: string): Promise<string | undefined> {
  try {
    const content = await readFile(sessionIdFile, "utf8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 业务职责：把执行期发现的 session id 持久化下来，后续 resume 就不必退回不稳定的 `--last`。
 */
export async function recordSessionId(metadata: JobMetadata, sessionId: string): Promise<JobMetadata> {
  metadata.sessionId = sessionId;
  await writeFile(metadata.sessionIdFile, `${sessionId}\n`, "utf8");
  await writeJobMetadata(metadata);
  return metadata;
}

/**
 * 业务职责：把不可继续推进的任务明确标记为 failed，并记录面向排障和重试决策的错误摘要。
 */
export async function recordJobFailure(metadata: JobMetadata, error: JobErrorInfo): Promise<JobMetadata> {
  metadata.status = "failed";
  metadata.lastError = error;
  await writeJobMetadata(metadata);
  return metadata;
}

/**
 * 业务职责：读取最后一条 assistant 消息，供完成判定、状态查询和外部调用方查看当前进展。
 */
export async function readLastMessage(metadata: JobMetadata): Promise<string> {
  try {
    return await readFile(metadata.lastMessageFile, "utf8");
  } catch {
    return "";
  }
}

/**
 * 业务职责：按行读取状态文件尾部内容，供 MCP/CLI 在当前聊天里轮询查看最近执行步骤，
 * 避免外部调用方必须自己进入状态目录翻整份日志。
 */
export async function readTailLines(file: string, maxLines: number): Promise<string[]> {
  try {
    const content = await readFile(file, "utf8");
    const normalizedLines = content
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    const safeMaxLines = Math.max(1, Math.trunc(maxLines));
    return normalizedLines.slice(-safeMaxLines);
  } catch {
    return [];
  }
}

/**
 * 业务职责：验证工作目录是否真实存在，避免 CLI、MCP 或兼容层把任务误投到无效目录。
 */
export async function assertWorkdirExists(workdir: string): Promise<void> {
  const resolved = path.resolve(workdir);
  const info = await stat(resolved).catch(() => undefined);

  if (!info?.isDirectory()) {
    throw new Error(`WORKDIR does not exist: ${resolved}`);
  }
}

/**
 * 业务职责：在不抛错的前提下判断工作目录是否存在，供引擎在失败时先落盘再返回错误结果。
 */
export async function workdirExists(workdir: string): Promise<boolean> {
  const resolved = path.resolve(workdir);
  const info = await stat(resolved).catch(() => undefined);
  return Boolean(info?.isDirectory());
}
