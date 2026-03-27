/**
 * 业务职责：聊天路由模块负责把“当前聊天里的自然语言意图”转换成继续旧任务、新建任务或提示确认，
 * 让 MCP、插件和未来其它聊天入口共享同一套意图判断与冲突检测策略。
 */
import { readFile } from "node:fs/promises";
import { resolveResumeTarget, resumeSession, runTask } from "../engine/job.js";
import type { ChatIntentConflictResult, ChatIntentRouteResult, RouteChatIntentCommand } from "../application/types.js";

/**
 * 业务职责：聊天路由策略版本号为未来调整 continue/new/conflict 规则预留演进钩子，
 * 避免后续增强时只能靠隐式行为变化而没有明确兼容边界。
 */
export const CHAT_INTENT_ROUTING_POLICY_VERSION = 1;

interface ChatIntentRoutingDependencies {
  resolveResumeTarget: typeof resolveResumeTarget;
  resumeSession: typeof resumeSession;
  runTask: typeof runTask;
  readPromptFile: (promptFile: string) => Promise<string>;
}

const CONTINUE_SIGNAL = /继续|接着|接着做|还没完成|继续当前任务|继续做|keep going|continue|resume|pick up where we left off/i;
const NEW_TASK_SIGNAL = /新任务|新的任务|新需求|重开|重新开始|开一个新任务|from scratch|new task|start a new|fresh task/i;

const DEFAULT_DEPENDENCIES: ChatIntentRoutingDependencies = {
  resolveResumeTarget,
  resumeSession,
  runTask,
  readPromptFile: readPromptSafely
};

/**
 * 业务职责：执行聊天意图路由主流程，根据当前聊天摘要和最近任务痕迹决定继续、新建或返回确认冲突。
 */
export async function routeChatIntentWithPolicies(
  command: RouteChatIntentCommand,
  dependencies: ChatIntentRoutingDependencies = DEFAULT_DEPENDENCIES
): Promise<ChatIntentRouteResult> {
  const chatSummary = (command.chatSummary ?? command.chatIntent).trim();
  const latestTask = await dependencies.resolveResumeTarget({
    stateDir: command.stateDir,
    useLast: true
  });
  const latestPrompt = latestTask ? await dependencies.readPromptFile(latestTask.initialPromptFile) : "";
  const hasContinueSignal = CONTINUE_SIGNAL.test(command.chatIntent);
  const hasNewTaskSignal = NEW_TASK_SIGNAL.test(command.chatIntent);
  const similarity = latestPrompt ? calculateSimilarity(chatSummary, latestPrompt) : 0;

  if (hasContinueSignal && hasNewTaskSignal) {
    return buildConflictRouteResult(
      command,
      "The current chat signals both continuing an old task and starting a new one. User confirmation is required.",
      latestTask?.stateDir
    );
  }

  if (hasContinueSignal && latestTask && isConflictingGoal(chatSummary, latestPrompt, similarity)) {
    return buildConflictRouteResult(
      command,
      "The current chat goal appears different from the latest current-directory codex-autoresearch task. Ask whether to continue the old task or start a new one.",
      latestTask.stateDir
    );
  }

  if (hasContinueSignal && latestTask) {
    const resumed = await dependencies.resumeSession({
      useLast: true,
      stateDir: command.stateDir,
      maxAttempts: command.maxAttempts
    });
    return {
      action: "resume_session",
      reason: "The current chat indicates unfinished work, so the route reused the latest codex-autoresearch task in the current directory.",
      chatIntent: command.chatIntent,
      chatSummary,
      latestTaskMatched: true,
      ...resumed
    };
  }

  if (hasContinueSignal && !latestTask && isSpecificSummary(chatSummary)) {
    const started = await dependencies.runTask({
      task: chatSummary,
      workdir: command.workdir,
      stateDir: command.stateDir,
      model: command.model,
      profile: command.profile,
      maxAttempts: command.maxAttempts
    });
    return {
      action: "run_task",
      reason: "No resumable current-directory codex-autoresearch task was found, so the route started a new task from the current chat summary.",
      chatIntent: command.chatIntent,
      chatSummary,
      latestTaskMatched: false,
      ...started
    };
  }

  if (hasContinueSignal) {
    return buildConflictRouteResult(
      command,
      "The current chat asks to continue, but the goal is still too vague to safely resume or start a task. Ask for a one-sentence goal.",
      latestTask?.stateDir
    );
  }

  const started = await dependencies.runTask({
    task: chatSummary,
    workdir: command.workdir,
    stateDir: command.stateDir,
    model: command.model,
    profile: command.profile,
    maxAttempts: command.maxAttempts
  });
  return {
    action: "run_task",
    reason: hasNewTaskSignal
      ? "The current chat explicitly asks for a new task, so the route started a fresh codex-autoresearch task."
      : "The current chat does not clearly ask to continue, so the route started a fresh codex-autoresearch task from the chat summary.",
    chatIntent: command.chatIntent,
    chatSummary,
    latestTaskMatched: latestTask ? similarity >= 0.2 : false,
    ...started
  };
}

/**
 * 业务职责：把聊天路由冲突统一表示成稳定结果，让插件和 MCP 客户端都能直接复用相同确认流程。
 */
export function buildConflictRouteResult(
  command: { chatIntent: string; chatSummary?: string },
  reason: string,
  stateDir?: string
): ChatIntentConflictResult {
  return {
    action: "conflict",
    reason,
    chatIntent: command.chatIntent,
    chatSummary: (command.chatSummary ?? command.chatIntent).trim(),
    stateDir,
    status: "needs_confirmation"
  };
}

/**
 * 业务职责：从最新任务的首轮 prompt 中提取文本，用于判断当前聊天是否仍属于同一条业务链路。
 */
export async function readPromptSafely(promptFile: string): Promise<string> {
  try {
    return await readFile(promptFile, "utf8");
  } catch {
    return "";
  }
}

/**
 * 业务职责：当当前聊天摘要与最近任务语义重合过低时，优先提示确认而不是静默继续旧任务。
 */
export function isConflictingGoal(chatSummary: string, latestPrompt: string, similarity: number): boolean {
  return isSpecificSummary(chatSummary) && latestPrompt.trim().length > 0 && similarity < 0.08;
}

/**
 * 业务职责：判断聊天摘要是否已经具体到可以安全启动任务，避免把空泛的“继续做”误当成新任务。
 */
export function isSpecificSummary(summary: string): boolean {
  const normalized = summary.trim();
  return normalized.length >= 12 && /\s|，|。|：|:/.test(normalized);
}

/**
 * 业务职责：用轻量词交集估算两个任务描述是否属于同一业务主题，支撑聊天路由里的冲突判断。
 */
export function calculateSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

/**
 * 业务职责：把自然语言任务描述切成稳定关键词，避免路由规则直接依赖完整原文匹配。
 */
export function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .replace(/[`"'“”‘’.,!?()[\]{}<>/\\|]/g, " ")
      .split(/[\s，。；：、\-_]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}
