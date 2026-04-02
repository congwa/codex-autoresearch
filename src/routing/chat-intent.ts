/**
 * 业务职责：聊天路由模块负责把“当前聊天里的自然语言意图”转换成继续旧任务、新建任务、
 * 运行仓库 skill 或提示确认这几类稳定动作，让 MCP、插件和未来其它聊天入口共享同一套判断规则。
 *
 * 为什么这一层要同时懂“聊天”和“任务”：
 * - 用户已经在 Codex 聊天窗里时，真正的输入不是一条干净命令，而是最近几轮聊天形成的意图。
 * - 如果不在这里集中处理 continue/new/skill 决策，插件、README 示例和 MCP handler 就会各自长出一套分叉逻辑。
 *
 * 这层刻意不依赖 transport：
 * - 无论触发来自 `/codex-autoresearch`、自然语言话术还是显式 skill 名，最终都走同一个路由函数。
 * - 这样就算未来聊天窗对 slash 的承载面变化，核心业务判断也不会跟着散掉。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChatIntentConflictResult,
  ChatIntentExecutionResult,
  ChatIntentRouteResult,
  ChatTriggerMode,
  RouteChatIntentCommand
} from "../application/types.js";
import { JobError } from "../engine/error.js";
import { resolveResumeTarget, resumeSession, runTask } from "../engine/job.js";
import { loadSkill, renderSkillPrompt, resolveSkillInputs, type SkillDefinition } from "../skills/skill.js";

/**
 * 业务职责：聊天路由策略版本号为未来调整 continue/new/skill/conflict 规则预留演进钩子，
 * 避免后续增强时只能靠隐式行为变化而没有明确兼容边界。
 */
export const CHAT_INTENT_ROUTING_POLICY_VERSION = 2;

/**
 * 业务职责：当前聊天窗口默认只向下游暴露最近 8 轮内容，避免历史过长时把已经过期的上下文也带进永动机任务。
 *
 * 为什么默认限制在 8 轮：
 * - 用户目标明确要求“当前聊天最近几轮”，不希望整段历史污染任务。
 * - 8 轮通常足够覆盖刚刚完成的计划、约束、未完事项和最后一次明确目标。
 */
export const DEFAULT_CHAT_WINDOW_TURNS = 8;

/**
 * 业务职责：聊天路由依赖集合把查找最近任务、resume、新建任务、运行 skill 和 prompt 读取抽成可替换能力，
 * 让单测和未来策略扩展都能在不触碰真实引擎的前提下验证路由决策。
 */
interface ChatIntentRoutingDependencies {
  resolveResumeTarget: typeof resolveResumeTarget;
  resumeSession: typeof resumeSession;
  runTask: typeof runTask;
  loadSkill: typeof loadSkill;
  resolveSkillInputs: typeof resolveSkillInputs;
  renderSkillPrompt: typeof renderSkillPrompt;
  readPromptFile: (promptFile: string) => Promise<string>;
}

/**
 * 业务职责：继续信号规则承载“当前聊天更像在接着做旧任务”的语言特征，
 * 让聊天入口在没有 thread id 的情况下仍能给出稳定默认路由。
 */
const CONTINUE_SIGNAL = /继续|接着|接着做|还没完成|继续当前任务|继续做|keep going|continue|resume|pick up where we left off/i;

/**
 * 业务职责：新任务信号规则承载“当前聊天更像在启动新需求”的语言特征，
 * 避免把明显的新 deliverable 静默附着到旧的任务链上。
 */
const NEW_TASK_SIGNAL = /新任务|新的任务|新需求|重开|重新开始|开一个新任务|from scratch|new task|start a new|fresh task/i;

/**
 * 业务职责：显式 skill 信号规则承载“当前聊天已经明确说出 skill 名称”的模式，
 * 让聊天窗内可以直接说“用 research skill ...”，而不需要退回 CLI 再敲 `skill run`。
 */
const EXPLICIT_SKILL_SIGNAL = /(?:用|use|run)\s+([a-z0-9-]+)\s+skill\b/i;

/**
 * 业务职责：默认依赖集合绑定真实引擎能力，保证生产环境下聊天路由能直接驱动统一执行链。
 */
const DEFAULT_DEPENDENCIES: ChatIntentRoutingDependencies = {
  resolveResumeTarget,
  resumeSession,
  runTask,
  loadSkill,
  resolveSkillInputs,
  renderSkillPrompt,
  readPromptFile: readPromptSafely
};

/**
 * 业务职责：执行聊天意图路由主流程，根据当前聊天最近 8 轮、最近任务痕迹和显式 skill 指令，
 * 决定继续旧任务、新建任务、运行 skill 或返回确认冲突。
 */
export async function routeChatIntentWithPolicies(
  command: RouteChatIntentCommand,
  dependencies: ChatIntentRoutingDependencies = DEFAULT_DEPENDENCIES
): Promise<ChatIntentRouteResult> {
  const triggerMode = resolveTriggerMode(command);
  const recentTurns = takeRecentChatTurns(command.chatWindowTurns);
  const chatSummary = resolveChatSummary(command, recentTurns);
  const requestedSkillName = resolveRequestedSkillName(command);
  const latestTask = await dependencies.resolveResumeTarget({
    stateDir: command.stateDir,
    useLast: true
  });
  const latestPrompt = latestTask ? await dependencies.readPromptFile(latestTask.initialPromptFile) : "";
  const latestBusinessPrompt = extractBusinessPrompt(latestPrompt);
  const hasContinueSignal = CONTINUE_SIGNAL.test(command.chatIntent);
  const hasNewTaskSignal = NEW_TASK_SIGNAL.test(command.chatIntent);
  const similarity = latestBusinessPrompt ? calculateSimilarity(chatSummary, latestBusinessPrompt) : 0;
  const latestTaskMatched = latestTask ? similarity >= 0.2 : false;

  if (requestedSkillName) {
    return routeExplicitSkillIntent(command, {
      dependencies,
      triggerMode,
      requestedSkillName,
      recentTurns,
      chatSummary,
      latestTaskMatched
    });
  }

  if (hasContinueSignal && hasNewTaskSignal) {
    return buildConflictRouteResult(
      { chatIntent: command.chatIntent, chatSummary },
      "The current chat signals both continuing an old task and starting a new one. User confirmation is required.",
      latestTask?.stateDir,
      triggerMode,
      recentTurns.length
    );
  }

  if (shouldReturnConflictForLatestTask(chatSummary, latestBusinessPrompt, similarity, latestTask, hasContinueSignal, triggerMode)) {
    return buildConflictRouteResult(
      { chatIntent: command.chatIntent, chatSummary },
      "The current chat goal appears different from the latest current-directory codex-autoresearch task. Ask whether to continue the old task or start a new one.",
      latestTask?.stateDir,
      triggerMode,
      recentTurns.length
    );
  }

  if (shouldResumeLatestTask(triggerMode, hasContinueSignal, latestTaskMatched, latestTask, chatSummary)) {
    const resumed = await dependencies.resumeSession({
      useLast: true,
      stateDir: command.stateDir,
      maxAttempts: command.maxAttempts
    });

    return {
      action: "resume_session",
      reason:
        triggerMode === "slash"
          ? "The current chat slash trigger reused the latest current-directory codex-autoresearch task after matching the recent chat window."
          : "The current chat indicates unfinished work, so the route reused the latest codex-autoresearch task in the current directory.",
      chatIntent: command.chatIntent,
      chatSummary,
      latestTaskMatched: true,
      triggerMode,
      chatWindowTurnsUsed: recentTurns.length,
      ...resumed
    };
  }

  if ((hasContinueSignal || triggerMode === "slash") && !latestTask && isSpecificSummary(chatSummary)) {
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
      reason:
        triggerMode === "slash"
          ? "The current chat slash trigger did not find a resumable current-directory task, so it started a new codex-autoresearch task from the recent chat window."
          : "No resumable current-directory codex-autoresearch task was found, so the route started a new task from the current chat summary.",
      chatIntent: command.chatIntent,
      chatSummary,
      latestTaskMatched: false,
      triggerMode,
      chatWindowTurnsUsed: recentTurns.length,
      ...started
    };
  }

  if (hasContinueSignal || triggerMode === "slash") {
    return buildConflictRouteResult(
      { chatIntent: command.chatIntent, chatSummary },
      "The current chat does not yet provide a concrete enough goal to safely resume or start a task. Ask for a one-sentence goal before continuing.",
      latestTask?.stateDir,
      triggerMode,
      recentTurns.length
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
      : "The current chat does not clearly ask to continue, so the route started a fresh codex-autoresearch task from the recent chat window summary.",
    chatIntent: command.chatIntent,
    chatSummary,
    latestTaskMatched,
    triggerMode,
    chatWindowTurnsUsed: recentTurns.length,
    ...started
  };
}

/**
 * 业务职责：处理“当前聊天里显式点名 skill”的路径，让聊天窗可以直接把最近 8 轮内容转成仓库任务配方执行。
 *
 * 为什么这里不直接报“去 CLI 里运行 skill run”：
 * - 用户已经在当前聊天窗里，显式点名 skill 就代表希望继续留在这个上下文里完成触发。
 * - 这里统一把聊天上下文映射成 skill 输入，才能真正形成“聊天内就地开永动机”的闭环。
 */
async function routeExplicitSkillIntent(
  command: RouteChatIntentCommand,
  context: {
    dependencies: ChatIntentRoutingDependencies;
    triggerMode: ChatTriggerMode;
    requestedSkillName: string;
    recentTurns: string[];
    chatSummary: string;
    latestTaskMatched: boolean;
  }
): Promise<ChatIntentRouteResult> {
  const definition = await context.dependencies.loadSkill(
    context.requestedSkillName,
    path.resolve(command.skillsRoot ?? "skills")
  );
  const inferredInputs = inferSkillInputsFromRecentChat(definition, context.chatSummary, context.recentTurns);

  try {
    const resolvedInputs = await context.dependencies.resolveSkillInputs(definition, inferredInputs, false);
    const renderedTask = context.dependencies.renderSkillPrompt(definition.promptTemplate, resolvedInputs);
    const started = await context.dependencies.runTask({
      task: renderedTask,
      workdir: command.workdir ?? definition.manifest.defaultWorkdir,
      stateDir: command.stateDir,
      model: command.model ?? definition.manifest.defaultModel,
      profile: command.profile,
      maxAttempts: command.maxAttempts
    });

    return {
      action: "run_skill",
      reason: `The current chat explicitly selected the ${context.requestedSkillName} skill, so the route converted the recent chat window into skill inputs and started that recipe.`,
      chatIntent: command.chatIntent,
      chatSummary: context.chatSummary,
      latestTaskMatched: context.latestTaskMatched,
      triggerMode: context.triggerMode,
      skillName: context.requestedSkillName,
      resolvedSkillInputs: resolvedInputs,
      chatWindowTurnsUsed: context.recentTurns.length,
      ...started
    };
  } catch (error) {
    if (error instanceof JobError && error.code === "SKILL_INPUT_MISSING") {
      return buildConflictRouteResult(
        { chatIntent: command.chatIntent, chatSummary: context.chatSummary },
        `The current chat does not yet provide enough information to run skill ${context.requestedSkillName}. Clarify the missing required inputs before starting the long-running task.`,
        command.stateDir,
        context.triggerMode,
        context.recentTurns.length,
        context.requestedSkillName
      );
    }

    throw error;
  }
}

/**
 * 业务职责：把聊天路由冲突统一表示成稳定结果，让插件和 MCP 客户端都能直接复用相同确认流程。
 */
export function buildConflictRouteResult(
  command: { chatIntent: string; chatSummary?: string },
  reason: string,
  stateDir?: string,
  triggerMode?: ChatTriggerMode,
  chatWindowTurnsUsed = 0,
  skillName?: string
): ChatIntentConflictResult {
  return {
    action: "conflict",
    reason,
    chatIntent: command.chatIntent,
    chatSummary: (command.chatSummary ?? command.chatIntent).trim(),
    stateDir,
    status: "needs_confirmation",
    triggerMode,
    skillName,
    chatWindowTurnsUsed
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
 * 业务职责：根据聊天事实推断这次请求更像 slash、自然语言还是显式 skill，
 * 让多个当前聊天 MCP 入口最终都落到同一个内部路由判断，而不是要求外部调用方传内部分类参数。
 */
export function resolveTriggerMode(command: RouteChatIntentCommand): ChatTriggerMode {
  if (command.triggerMode) {
    return command.triggerMode;
  }

  if (command.chatIntent.trim().startsWith("/codex-autoresearch")) {
    return "slash";
  }

  if (command.skillName || EXPLICIT_SKILL_SIGNAL.test(command.chatIntent)) {
    return "explicit_skill";
  }

  return "natural";
}

/**
 * 业务职责：只保留当前聊天最近 8 轮内容，避免更早历史把当前目标、约束和未完事项冲淡。
 */
export function takeRecentChatTurns(turns: string[] | undefined, limit = DEFAULT_CHAT_WINDOW_TURNS): string[] {
  return (turns ?? [])
    .map((turn) => turn.trim())
    .filter((turn) => turn.length > 0)
    .slice(-limit);
}

/**
 * 业务职责：把当前聊天最近 8 轮压缩成统一摘要，作为 run_task、resume 对比和 skill 补参的共同来源。
 *
 * 为什么优先使用 recent turns：
 * - 聊天入口真正可靠的上下文是“刚刚聊了什么”，不是整个会话历史。
 * - 调用方如果已经做过更强的摘要，也可以通过 `chatSummary` 直接覆盖默认拼接结果。
 */
export function resolveChatSummary(command: RouteChatIntentCommand, recentTurns: string[]): string {
  const explicitSummary = command.chatSummary?.trim();
  if (explicitSummary) {
    return explicitSummary;
  }

  if (recentTurns.length > 0) {
    return recentTurns.join("\n");
  }

  return command.chatIntent.trim();
}

/**
 * 业务职责：定位当前聊天是否已经显式指定仓库 skill，让路由器知道这次应优先走 skill 配方而不是 generic task。
 */
export function resolveRequestedSkillName(command: RouteChatIntentCommand): string | undefined {
  if (command.skillName?.trim()) {
    return command.skillName.trim();
  }

  const matched = command.chatIntent.match(EXPLICIT_SKILL_SIGNAL);
  return matched?.[1]?.trim();
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
    // 业务约束：只统计稳定关键词交集，用轻量方式近似判断两段描述是否仍属于同一业务任务。
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

/**
 * 业务职责：从状态目录里的首轮 prompt 中剥离 completion protocol，只保留真正的业务任务主体参与相似度判断。
 *
 * 解决的问题：
 * - `initial-prompt.txt` 结尾会追加 done token 和 confirm text，这些协议词会污染聊天目标与旧任务的语义比对。
 * - 聊天路由真正关心的是“之前让 Codex 做什么”，不是协议尾巴长什么样。
 */
export function extractBusinessPrompt(initialPrompt: string): string {
  return initialPrompt.split(/\n\s*\n/, 1)[0]?.trim() ?? "";
}

/**
 * 业务职责：判断什么时候必须先停下来确认，而不是在当前目录最新任务上静默续跑。
 */
function shouldReturnConflictForLatestTask(
  chatSummary: string,
  latestPrompt: string,
  similarity: number,
  latestTask: Awaited<ReturnType<typeof resolveResumeTarget>>,
  hasContinueSignal: boolean,
  triggerMode: ChatTriggerMode
): boolean {
  if (!latestTask) {
    return false;
  }

  if (hasContinueSignal && isConflictingGoal(chatSummary, latestPrompt, similarity)) {
    return true;
  }

  return triggerMode === "slash" && isSpecificSummary(chatSummary) && isConflictingGoal(chatSummary, latestPrompt, similarity);
}

/**
 * 业务职责：决定什么时候可以安全地自动续到当前目录最近任务，避免 slash/natural 两种入口各自维护一套分支。
 */
function shouldResumeLatestTask(
  triggerMode: ChatTriggerMode,
  hasContinueSignal: boolean,
  latestTaskMatched: boolean,
  latestTask: Awaited<ReturnType<typeof resolveResumeTarget>>,
  chatSummary: string
): boolean {
  if (!latestTask) {
    return false;
  }

  if (hasContinueSignal) {
    return true;
  }

  return triggerMode === "slash" && (latestTaskMatched || !isSpecificSummary(chatSummary));
}

/**
 * 业务职责：根据仓库 skill 的业务字段名，把当前聊天最近 8 轮整理成可执行的 skill 输入。
 *
 * 设计思路：
 * - `topic` / `goal` 一类字段直接承载当前聊天的核心目标；
 * - `constraints` 一类字段优先吸收聊天里显式提到的限制，没有则退回“以最近 8 轮为准”；
 * - `phasePlan` / `finalArtifact` 这类长任务字段尽量从最近聊天里提炼，不足时给出稳定兜底描述；
 * - 剩余字段使用整个 recent-chat 上下文作为保守默认值，让 skill 仍能围绕当前聊天推进。
 */
export function inferSkillInputsFromRecentChat(
  definition: SkillDefinition,
  chatSummary: string,
  recentTurns: string[]
): Record<string, string> {
  const recentChatContext = buildRecentChatContext(chatSummary, recentTurns);
  const explicitConstraints = extractConstraintHints(recentTurns);

  return Object.fromEntries(
    Object.keys(definition.manifest.inputs).map((name) => {
      const normalizedName = name.toLowerCase();

      if (/topic|goal|task|subject/.test(normalizedName)) {
        return [name, chatSummary];
      }

      if (/constraint|scope|limit/.test(normalizedName)) {
        return [name, explicitConstraints || `请以当前聊天最近 ${recentTurns.length || DEFAULT_CHAT_WINDOW_TURNS} 轮中已经明确提到的范围、限制和验收要求为准。`];
      }

      if (/phase.*plan|plan.*phase|phaseplan/.test(normalizedName)) {
        return [
          name,
          `请基于当前聊天最近 ${recentTurns.length || DEFAULT_CHAT_WINDOW_TURNS} 轮，把任务拆成“现状梳理 -> 关键实现 -> 验证验收 -> 最终汇总”几个阶段，并保持与聊天里已确认的里程碑一致。`
        ];
      }

      if (/artifact|deliverable|output|final/.test(normalizedName)) {
        return [
          name,
          `请输出与当前聊天目标一致的最终交付物，并在结尾包含阶段结果汇总、验收结论与仍待人工确认的风险。最近聊天摘要：${chatSummary}`
        ];
      }

      return [name, recentChatContext];
    })
  );
}

/**
 * 业务职责：把最近聊天窗口整理成统一上下文文本，方便 skill 默认把“当前正在聊什么”完整带入配方。
 */
function buildRecentChatContext(chatSummary: string, recentTurns: string[]): string {
  if (recentTurns.length === 0) {
    return chatSummary;
  }

  return `当前聊天最近 ${recentTurns.length} 轮摘要：\n${recentTurns.join("\n")}`;
}

/**
 * 业务职责：从最近聊天里提取显式出现的业务约束，尽量把“不要什么、必须什么、输出要求是什么”带进 research 等配方。
 */
function extractConstraintHints(recentTurns: string[]): string {
  const constraintLines = recentTurns.filter((turn) => /约束|限制|必须|不要|只要|仅限|输出|验收|risk|constraint|must|should/i.test(turn));
  return constraintLines.join("\n");
}
