/**
 * 业务职责：统一执行引擎负责承接 direct task、skill、兼容脚本和 MCP 请求，
 * 并确保它们都走同一套 session 续跑、完成协议和状态持久化流程。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildCompletionProtocolText, createCompletionProtocol, isCompletionMessage } from "./completion.js";
import { discoverSessionId, runCodex } from "./codex.js";
import { JobError, toJobErrorInfo, type JobErrorInfo } from "./error.js";
import {
  buildCompletionFailurePrompt,
  buildPlanningPromptAppendix,
  ensurePlanningArtifacts,
  refreshPlanningArtifacts,
  validateCompletionReport
} from "./planning.js";
import {
  clearJobError,
  ensureJobMetadata,
  findJobBySessionId,
  listJobs,
  readJobMetadata,
  readLastMessage,
  readTailLines,
  readLatestJobId,
  readSessionIdFile,
  recordJobFailure,
  recordSessionId,
  snapshotAttempt,
  type JobMetadata,
  type JobStatus,
  workdirExists,
  writeJobMetadata
} from "./state.js";

/**
 * 业务职责：直接任务运行选项统一描述所有入口最终会传给执行引擎的参数，
 * 让 CLI、MCP、legacy 和未来新入口都复用同一份任务启动配置。
 */
export interface RunTaskOptions {
  task: string;
  workdir?: string;
  stateDir?: string;
  exactStateDir?: string;
  jobId?: string;
  model?: string;
  profile?: string;
  codexBin?: string;
  confirmText?: string;
  resumeTextBase?: string;
  intervalSeconds?: number;
  fullAuto?: boolean;
  dangerouslyBypass?: boolean;
  skipGitRepoCheck?: boolean;
  startWithResumeIfPossible?: boolean;
  maxAttempts?: number;
  promptSource?: "file" | "text";
  sourcePromptFile?: string;
  sourcePromptContent?: string;
  frozenGoalsText?: string;
  /** 如果为 true，启动后台执行但立即返回 pending 状态，不阻塞等待完成。 */
  fireAndForget?: boolean;
  /** 每轮 codex 退出后调用的进度回调，用于 MCP 进度通知等场景。 */
  onProgress?: (status: { attempt: number; lastMessage: string }) => void;
  /** 实时流式输出回调，用于 CLI 终端展示每轮执行进度。 */
  onStream?: {
    onAttemptStart?: (attempt: number) => void;
    onAttemptEnd?: (attempt: number, exitCode: number, elapsed: number) => void;
    onEvent?: (event: Record<string, unknown>) => void;
  };
}

/**
 * 业务职责：恢复任务运行选项统一描述 session、job 和最近任务恢复所需参数，
 * 让 resume 入口始终沿用同一套查找和重试配置。
 */
export interface ResumeSessionOptions {
  sessionId?: string;
  jobId?: string;
  useLast?: boolean;
  stateDir?: string;
  codexBin?: string;
  intervalSeconds?: number;
  maxAttempts?: number;
}

/**
 * 业务职责：会话尾读选项统一描述“附着到哪条任务链并取多少最近进度”，
 * 让 MCP/CLI 可以安全地轮询当前长任务而不推进执行状态。
 */
export interface TailSessionOptions {
  sessionId?: string;
  jobId?: string;
  useLast?: boolean;
  stateDir?: string;
  tailLines?: number;
}

/**
 * 业务职责：任务运行结果是所有入口对外暴露的统一业务回执，
 * 既要能表达完成/失败，也要能给调用方留下继续追踪同一任务的关键标识。
 */
export interface JobRunResult {
  jobId: string;
  sessionId?: string;
  stateDir: string;
  status: JobStatus;
  lastMessage: string;
  lastMessageFile: string;
  error?: JobErrorInfo;
  lastCompletionCheck?: JobMetadata["lastCompletionCheck"];
  lastPlanDrift?: JobMetadata["lastPlanDrift"];
}

/**
 * 业务职责：会话尾读结果把任务身份、最近业务输出和日志尾部组合成一个轮询快照，
 * 供当前聊天持续展示“永动机任务刚执行到了哪里”。
 */
export interface SessionTailResult extends JobRunResult {
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  lastExitCode?: number;
  runnerLogTail: string[];
  eventLogTail: string[];
}

/**
 * 业务职责：默认确认文本为完成协议的最终确认语句，
 * 用来降低长任务把普通总结误判成“真的完成”的风险。
 */
const DEFAULT_CONFIRM_TEXT = "CONFIRMED: all tasks completed";
/**
 * 业务职责：默认续跑提示只说”继续”，模拟用户手动操作时的最小指令。
 */
const DEFAULT_RESUME_TEXT = "继续";

/**
 * 业务职责：后台执行边界文本区分当前任务是 worker plane 而不是前台控制层，
 * 防止长任务在执行过程中再次调用 codex-autoresearch 的 MCP 工具。
 */
const WORKER_EXECUTION_BOUNDARY_TEXT = [
  "你在后台独立执行，没有人会回复你的问题。不要停下来询问，直接做。",
  "不要调用 codex-autoresearch 的 MCP 工具（run_task 等）。"
].join("\n");

/**
 * 业务职责：关键 MCP/tool 失败模式用于阻断“最后两行正确但业务并未完成”的假完成，
 * 先覆盖当前已知最常见的宿主取消错误，后续可以继续扩展其它阻断型工具失败。
 */
const BLOCKING_MCP_TOOL_FAILURE_PATTERNS = [
  {
    pattern: /user cancelled MCP tool call/i,
    code: "MCP_TOOL_CALL_CANCELLED",
    retryable: true
  }
] as const;

/**
 * 业务职责：规范化后的运行选项代表执行引擎内部真正依赖的稳定配置，
 * 让默认值、路径解析和安全开关在进入主循环前一次性收口。
 */
interface NormalizedRunOptions {
  task: string;
  workdir: string;
  stateDir?: string;
  exactStateDir?: string;
  jobId?: string;
  model?: string;
  profile?: string;
  codexBin: string;
  confirmText: string;
  resumeTextBase: string;
  intervalSeconds: number;
  fullAuto: boolean;
  dangerouslyBypass: boolean;
  skipGitRepoCheck: boolean;
  startWithResumeIfPossible: boolean;
  maxAttempts?: number;
  promptSource?: "file" | "text";
  sourcePromptFile?: string;
  sourcePromptContent?: string;
  frozenGoalsText?: string;
  fireAndForget: boolean;
  onProgress?: (status: { attempt: number; lastMessage: string }) => void;
  onStream?: RunTaskOptions["onStream"];
}

/**
 * 业务职责：构建首轮真实任务文本，把用户目标和统一完成协议拼成执行引擎的标准输入。
 */
export function buildInitialPrompt(task: string, confirmText: string, rawNonce?: string): { prompt: string; protocol: ReturnType<typeof createCompletionProtocol> } {
  const protocol = createCompletionProtocol(confirmText, rawNonce);
  return {
    protocol,
    prompt: `${task}\n\n${WORKER_EXECUTION_BOUNDARY_TEXT}\n\n${buildCompletionProtocolText(protocol)}\n`
  };
}

/**
 * 业务职责：构建续跑提示，极简——只说"继续"加上可选的完成协议提前退出机制。
 */
export function buildResumePrompt(protocol: ReturnType<typeof createCompletionProtocol>, resumeTextBase = DEFAULT_RESUME_TEXT): string {
  return `${resumeTextBase}\n\n${buildCompletionProtocolText(protocol)}\n`;
}

/**
 * 业务职责：把用户级别的运行参数规范化成共享引擎配置，保证不同入口的默认行为一致。
 */
export function normalizeRunOptions(options: RunTaskOptions): NormalizedRunOptions {
  return {
    task: options.task,
    workdir: path.resolve(options.workdir ?? process.cwd()),
    codexBin: options.codexBin ?? process.env.CODEX_BIN ?? "codex",
    intervalSeconds: options.intervalSeconds ?? 3,
    fullAuto: options.fullAuto ?? true,
    dangerouslyBypass: options.dangerouslyBypass ?? false,
    skipGitRepoCheck: options.skipGitRepoCheck ?? false,
    startWithResumeIfPossible: options.startWithResumeIfPossible ?? true,
    jobId: options.jobId,
    stateDir: options.stateDir,
    exactStateDir: options.exactStateDir,
    model: options.model,
    profile: options.profile,
    confirmText: options.confirmText ?? DEFAULT_CONFIRM_TEXT,
    resumeTextBase: options.resumeTextBase ?? DEFAULT_RESUME_TEXT,
    maxAttempts: options.maxAttempts,
    promptSource: options.promptSource,
    sourcePromptFile: options.sourcePromptFile,
    sourcePromptContent: options.sourcePromptContent,
    frozenGoalsText: options.frozenGoalsText,
    fireAndForget: options.fireAndForget ?? false,
    onProgress: options.onProgress,
    onStream: options.onStream
  };
}

/**
 * 业务职责：运行或续跑一个统一任务，持续使用同一状态目录直到收到严格完成协议或被外部中断。
 */
export async function runTask(options: RunTaskOptions): Promise<JobRunResult> {
  const normalized = normalizeRunOptions(options);
  const { protocol, prompt: initialPrompt } = buildInitialPrompt(normalized.task, normalized.confirmText);
  const workdirIsValid = await workdirExists(normalized.workdir);
  const metadata = await ensureJobMetadata({
    stateRoot: resolveStateRoot(normalized.stateDir, normalized.workdir, workdirIsValid),
    exactStateDir: normalized.exactStateDir,
    jobId: normalized.jobId,
    workdir: normalized.workdir,
    protocol,
    model: normalized.model,
    profile: normalized.profile,
    fullAuto: normalized.fullAuto,
    dangerouslyBypass: normalized.dangerouslyBypass,
    skipGitRepoCheck: normalized.skipGitRepoCheck,
    startWithResumeIfPossible: normalized.startWithResumeIfPossible,
    promptSource: normalized.promptSource,
    sourcePromptFile: normalized.sourcePromptFile
  });

  await ensurePlanningArtifacts(metadata, normalized.sourcePromptContent, normalized.frozenGoalsText);

  if (!workdirIsValid) {
    // 业务约束：工作目录无效时也必须先创建失败态记录，保证外部系统仍能追踪这次失败请求。
    return failJob(metadata, new JobError("WORKDIR_NOT_FOUND", `WORKDIR does not exist: ${path.resolve(normalized.workdir)}`, false));
  }

  const resumePrompt = buildResumePrompt(protocol, normalized.resumeTextBase);

  if (normalized.fireAndForget) {
    // 业务约束：fire-and-forget 模式下只初始化状态目录并在后台启动执行，不阻塞等待完成。
    void runLoop(metadata, initialPrompt, resumePrompt, normalized.codexBin, normalized.intervalSeconds, normalized.maxAttempts, normalized.onProgress, normalized.onStream);
    return buildResult(metadata, "");
  }

  return runLoop(metadata, initialPrompt, resumePrompt, normalized.codexBin, normalized.intervalSeconds, normalized.maxAttempts, normalized.onProgress, normalized.onStream);
}

/**
 * 业务职责：根据 session-id、job-id 或 `--last` 恢复已有任务，让守护进程中断后可以继续原链路推进。
 */
export async function resumeSession(options: ResumeSessionOptions): Promise<JobRunResult> {
  const metadata = await resolveResumeTarget(options);

  if (!metadata) {
    const failureMetadata = await createFailureMetadata(
      options.stateDir,
      process.cwd(),
      new JobError("SESSION_NOT_FOUND", "No resumable session was found.", false)
    );
    return buildResult(failureMetadata, "", failureMetadata.lastError);
  }

  const sessionId = await readSessionIdFile(metadata.sessionIdFile);
  if (sessionId && !metadata.sessionId) {
    metadata.sessionId = sessionId;
    await writeJobMetadata(metadata);
  }

  const protocol = createCompletionProtocol(metadata.confirmText, metadata.nonce.replace(/-/g, ""));
  const resumePrompt = buildResumePrompt(protocol);

  await ensurePlanningArtifacts(metadata);

  return runLoop(metadata, "", resumePrompt, options.codexBin ?? process.env.CODEX_BIN ?? "codex", options.intervalSeconds ?? 3, options.maxAttempts);
}

/**
 * 业务职责：对外暴露任务状态查询结果，方便 MCP 客户端和人工命令查看长任务当前推进到哪里。
 */
export async function getSessionStatus(input: { stateDir?: string; jobId?: string; sessionId?: string; useLast?: boolean }): Promise<JobRunResult> {
  const metadata = await resolveResumeTarget({
    stateDir: input.stateDir,
    jobId: input.jobId,
    sessionId: input.sessionId,
    useLast: input.useLast
  });

  if (!metadata) {
    throw new JobError("SESSION_NOT_FOUND", "No session status could be found.", false);
  }

  return buildResult(metadata);
}

/**
 * 业务职责：读取当前任务最近一段执行痕迹，供 MCP 在聊天内轮询展示 runner log、事件流和最后消息。
 */
export async function tailSession(input: TailSessionOptions): Promise<SessionTailResult> {
  const metadata = await resolveResumeTarget({
    stateDir: input.stateDir,
    jobId: input.jobId,
    sessionId: input.sessionId,
    useLast: input.useLast
  });

  if (!metadata) {
    throw new JobError("SESSION_NOT_FOUND", "No session tail could be found.", false);
  }

  const result = await buildResult(metadata);
  const tailLines = input.tailLines ?? 50;

  return {
    ...result,
    attemptCount: metadata.attemptCount,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    lastExitCode: metadata.lastExitCode,
    runnerLogTail: await readTailLines(metadata.runnerLogFile, tailLines),
    eventLogTail: await readTailLines(metadata.eventLogFile, tailLines)
  };
}

/**
 * 业务职责：为 `session resume` 和 `get_session_status` 统一寻找目标任务，保证优先级和行为一致。
 */
export async function resolveResumeTarget(options: {
  stateDir?: string;
  jobId?: string;
  sessionId?: string;
  useLast?: boolean;
}): Promise<JobMetadata | undefined> {
  const rawStateDir = options.stateDir ?? path.resolve(process.cwd(), ".codex-run");
  let stateRoot = path.resolve(rawStateDir);

  // 业务约束：调用方可能传入 job 目录而非 state root（例如 MCP run_task 返回的 stateDir 就是 job 目录）。
  // 如果传入路径本身就是一个包含 meta.json 的 job 目录，直接尝试读取它。
  const directMeta = await readJobMetadata(stateRoot);
  if (directMeta) {
    // 如果传入的恰好是某个 job 目录，且没有指定 jobId 或指定的 jobId 就是这个 job，直接返回。
    if (!options.jobId || options.jobId === directMeta.jobId) {
      return directMeta;
    }
    // 传入的是 job 目录但 jobId 不匹配，回退到其父目录作为 state root。
    stateRoot = path.dirname(stateRoot);
  }

  if (options.jobId) {
    // 业务约束：显式 job id 的优先级最高，因为它代表调用方已经明确指定了要附着哪条任务链。
    return readJobMetadata(path.join(stateRoot, options.jobId));
  }

  if (options.sessionId) {
    const matched = await findJobBySessionId(stateRoot, options.sessionId);
    if (matched) {
      return matched;
    }
  }

  if (options.useLast) {
    // 业务约束：`--last` 先尊重 latest-job 指针，只有指针缺失时才退回目录扫描兜底。
    const latestJobId = await readLatestJobId(stateRoot);
    if (latestJobId) {
      const latestJob = await readJobMetadata(path.join(stateRoot, latestJobId));
      if (latestJob) {
        return latestJob;
      }
    }

    return (await listJobs(stateRoot))[0];
  }

  return undefined;
}

/**
 * 业务职责：执行主守护循环，持续推进同一任务直到收到严格完成协议或命中显式尝试上限。
 */
async function runLoop(metadata: JobMetadata, initialPrompt: string, resumePrompt: string, codexBin: string, intervalSeconds: number, maxAttempts?: number, onProgress?: (status: { attempt: number; lastMessage: string }) => void, onStream?: RunTaskOptions["onStream"]): Promise<JobRunResult> {
  const hasSessionId = Boolean(metadata.sessionId || (await readSessionIdFile(metadata.sessionIdFile)));
  let nextMode: "initial" | "resume" =
    metadata.attemptCount === 0 && !hasSessionId && !(await hasResumeArtifacts(metadata)) ? "initial" : "resume";
  let lastHadBlockingFailure = false;

  while (true) {
    metadata.status = "running";
    metadata.attemptCount += 1;
    metadata.lastError = undefined;
    await writeJobMetadata(metadata);

    const planningSnapshot = await refreshPlanningArtifacts(metadata);
    const prompt = buildAttemptPrompt({
      mode: nextMode,
      initialPrompt,
      resumePrompt,
      planningAppendix: buildPlanningPromptAppendix(planningSnapshot),
      completionFailurePrompt: buildCompletionFailurePrompt(metadata.lastCompletionCheck),
      lastHadBlockingFailure
    });
    const previousEventLog = await readEventLog(metadata.eventLogFile);
    const attemptStartTime = Date.now();
    onStream?.onAttemptStart?.(metadata.attemptCount);
    let exitCode: number;
    try {
      exitCode = await runCodex(metadata, { codexBin, prompt, mode: nextMode, onEvent: onStream?.onEvent });
    } catch (error) {
      return failJob(metadata, error);
    }
    metadata.lastExitCode = exitCode;
    onStream?.onAttemptEnd?.(metadata.attemptCount, exitCode, Date.now() - attemptStartTime);

    const discoveredSessionId = await discoverSessionId(metadata.eventLogFile);
    if (discoveredSessionId) {
      await recordSessionId(metadata, discoveredSessionId);
    }

    await snapshotAttempt(metadata, metadata.attemptCount);
    const lastMessage = await readLastMessage(metadata);
    onProgress?.({ attempt: metadata.attemptCount, lastMessage });
    const blockingFailure = await detectBlockingFailureSince(metadata.eventLogFile, previousEventLog);
    if (blockingFailure) {
      metadata.lastError = blockingFailure;
      metadata.lastCompletionCheck = undefined;
    }
    const protocol = createCompletionProtocol(metadata.confirmText, metadata.nonce.replace(/-/g, ""));
    if (!blockingFailure && isCompletionMessage(lastMessage, protocol)) {
      metadata.lastCompletionCheck = await validateCompletionReport(metadata, lastMessage);
      if (metadata.lastCompletionCheck.status !== "failed") {
        metadata.status = "completed";
        await writeJobMetadata(metadata);
        return buildResult(metadata, lastMessage);
      }
    }

    if (maxAttempts && metadata.attemptCount >= maxAttempts) {
      // 业务约束：命中显式尝试上限时不判失败，而是停在 needs_resume 交给外部继续调度。
      metadata.status = "needs_resume";
      await writeJobMetadata(metadata);
      return buildResult(metadata, lastMessage, metadata.lastError);
    }

    // 业务约束：上一轮存在 blocking failure 时，下一轮 resume prompt 需要显式清除 AI 上下文中
    // "不能使用 completion protocol"的印象，否则 AI 会基于自己的历史回复无限拒绝完成。
    lastHadBlockingFailure = Boolean(blockingFailure);

    metadata.status = "needs_resume";
    await writeJobMetadata(metadata);
    await sleep(intervalSeconds * 1000);
    nextMode = "resume";
  }
}

/**
 * 业务职责：把续跑轮次需要的冻结目标、失败缺口和阻断提醒统一拼成 prompt，
 * 避免不同分支各自拼字符串导致规划型任务的约束上下文不一致。
 */
function buildAttemptPrompt(input: {
  mode: "initial" | "resume";
  initialPrompt: string;
  resumePrompt: string;
  planningAppendix: string;
  completionFailurePrompt: string;
  lastHadBlockingFailure: boolean;
}): string {
  const sections: string[] = [];

  sections.push(input.mode === "initial" ? input.initialPrompt.trimEnd() : input.resumePrompt.trimEnd());

  if (input.planningAppendix) {
    sections.push(input.planningAppendix);
  }

  if (input.lastHadBlockingFailure) {
    sections.push("注意：之前轮次中出现的工具调用错误（如 MCP 调用被取消）已经不再影响本轮。如果你已完成所有任务，请正常使用 completion protocol 结束。不要因为之前的错误而拒绝完成。");
  }

  if (input.completionFailurePrompt) {
    sections.push(input.completionFailurePrompt);
  }

  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/**
 * 业务职责：判断当前任务目录里是否已有可续跑痕迹，避免重启后无脑新建会话导致上下文漂移。
 */
async function hasResumeArtifacts(metadata: JobMetadata): Promise<boolean> {
  return Boolean((await readSessionIdFile(metadata.sessionIdFile)) || metadata.sessionId || metadata.attemptCount > 0);
}

/**
 * 业务职责：把任务元信息和最后输出收敛成统一结果对象，供 CLI、测试和 MCP 工具直接返回。
 */
async function buildResult(metadata: JobMetadata, lastMessage?: string, error?: JobErrorInfo): Promise<JobRunResult> {
  return {
    jobId: metadata.jobId,
    sessionId: metadata.sessionId ?? (await readSessionIdFile(metadata.sessionIdFile)),
    stateDir: metadata.stateDir,
    status: metadata.status,
    lastMessage: lastMessage ?? (await readLastMessage(metadata)),
    lastMessageFile: metadata.lastMessageFile,
    error: error ?? metadata.lastError,
    lastCompletionCheck: metadata.lastCompletionCheck,
    lastPlanDrift: metadata.lastPlanDrift
  };
}

/**
 * 业务职责：在未完成时按配置间隔再次推进任务，维持与旧 Bash 守护脚本一致的续跑节奏。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 业务职责：为工作目录无效等前置失败场景选择安全的状态根目录，避免意外创建不存在的业务仓库目录。
 */
function resolveStateRoot(stateDir: string | undefined, workdir: string, workdirIsValid: boolean): string {
  if (stateDir) {
    // 业务约束：调用方显式指定状态根目录时必须完全尊重，不能再二次推断。
    return path.resolve(stateDir);
  }

  if (workdirIsValid) {
    // 业务约束：默认优先把状态跟随真实工作目录，方便用户“站在当前目录直接用”。
    return path.resolve(workdir, ".codex-run");
  }

  return path.resolve(process.cwd(), ".codex-run");
}

/**
 * 业务职责：把不可继续推进的任务统一写成失败态结果，让调用方既能看到错误也能拿到状态目录。
 */
async function failJob(metadata: JobMetadata, error: unknown): Promise<JobRunResult> {
  const normalizedError = toJobErrorInfo(error);
  await recordJobFailure(metadata, normalizedError);
  return buildResult(metadata, await readLastMessage(metadata), normalizedError);
}

/**
 * 业务职责：在 resume 目标缺失等没有现成任务目录的场景下创建一个失败记录，保证错误同样可追踪。
 */
async function createFailureMetadata(stateDir: string | undefined, workdir: string, error: JobError): Promise<JobMetadata> {
  const metadata = await ensureJobMetadata({
    stateRoot: stateDir ? path.resolve(stateDir) : path.resolve(process.cwd(), ".codex-run"),
    workdir,
    protocol: createCompletionProtocol(DEFAULT_CONFIRM_TEXT),
    fullAuto: true,
    dangerouslyBypass: false,
    skipGitRepoCheck: false,
    startWithResumeIfPossible: false
  });

  await clearJobError(metadata);
  await recordJobFailure(metadata, toJobErrorInfo(error));
  return metadata;
}

/**
 * 业务职责：读取事件日志当前内容，供单轮执行前后做增量对比，只分析本轮新增失败而不被历史噪音污染。
 */
async function readEventLog(eventLogFile: string): Promise<string> {
  try {
    return await readFile(eventLogFile, "utf8");
  } catch {
    return "";
  }
}

/**
 * 业务职责：分析本轮新增事件里是否存在阻断型工具失败，一旦命中就禁止本轮以完成协议收尾。
 */
async function detectBlockingFailureSince(eventLogFile: string, previousContent: string): Promise<JobErrorInfo | undefined> {
  const currentContent = await readEventLog(eventLogFile);
  const newContent = currentContent.startsWith(previousContent) ? currentContent.slice(previousContent.length) : currentContent;
  const eventLines = newContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of eventLines) {
    const event = parseEventLine(line);
    const item = event?.item as
      | {
          type?: string;
          status?: string;
          error?: { message?: string } | null;
        }
      | undefined;

    if (item?.type !== "mcp_tool_call" || item.status !== "failed") {
      continue;
    }

    const errorMessage = item.error?.message?.trim();
    if (!errorMessage) {
      continue;
    }

    for (const definition of BLOCKING_MCP_TOOL_FAILURE_PATTERNS) {
      if (definition.pattern.test(errorMessage)) {
        return {
          code: definition.code,
          message: errorMessage,
          retryable: definition.retryable
        };
      }
    }

    return {
      code: "MCP_TOOL_CALL_FAILED",
      message: errorMessage,
      retryable: true
    };
  }

  return undefined;
}

/**
 * 业务职责：把事件日志单行安全解析成对象，避免某一条脏日志导致整轮阻断分析失效。
 */
function parseEventLine(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
