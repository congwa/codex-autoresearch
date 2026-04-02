/**
 * 业务职责：应用层用例模块把 direct task、skill、resume、状态查询和当前聊天入口统一成稳定业务入口，
 * 让 CLI、MCP 和兼容层只负责解析与展示，而不再直接编排底层引擎细节。
 */
import path from "node:path";
import { getSessionStatus, resumeSession, runTask, tailSession } from "../engine/job.js";
import { routeChatIntentWithPolicies } from "../routing/chat-intent.js";
import { listSkills, loadSkill, renderSkillPrompt, resolveSkillInputs, toPublicSkillDefinition } from "../skills/skill.js";
import type {
  ChatIntentRouteResult,
  ContinueCurrentDirectoryTaskCommand,
  GetTaskStatusCommand,
  PublicSkillDefinition,
  ResumeTaskCommand,
  RouteChatIntentCommand,
  RunDirectTaskCommand,
  RunSkillFromCurrentChatCommand,
  RunSkillCommand,
  StartFromCurrentChatCommand,
  TailSessionCommand
} from "./types.js";
import { toRunTaskOptions } from "./types.js";

/**
 * 业务职责：统一承接“执行一条明确任务”的业务入口，让所有 transport 都共享同一套 direct task 行为。
 */
export async function runDirectTask(command: RunDirectTaskCommand): Promise<Awaited<ReturnType<typeof runTask>>> {
  return runTask(toRunTaskOptions(command));
}

/**
 * 业务职责：统一承接“按 skill 配方执行任务”的业务入口，确保 skill 加载、补参与模板渲染只维护一份流程。
 */
export async function runSkillTask(command: RunSkillCommand): Promise<Awaited<ReturnType<typeof runTask>>> {
  const definition = await loadSkill(command.skillName, path.resolve(command.skillsRoot ?? "skills"));
  const values = await resolveSkillInputs(definition, command.inputs ?? {}, command.interactive ?? false);
  return runDirectTask({
    ...command,
    task: renderSkillPrompt(definition.promptTemplate, values),
    workdir: command.workdir ?? definition.manifest.defaultWorkdir,
    model: command.model ?? definition.manifest.defaultModel
  });
}

/**
 * 业务职责：统一承接“继续已有任务”的业务入口，让 session 定位、最近任务恢复和 transport 输出完全解耦。
 */
export async function resumeExistingTask(command: ResumeTaskCommand): Promise<Awaited<ReturnType<typeof resumeSession>>> {
  return resumeSession({
    sessionId: command.sessionId,
    jobId: command.jobId,
    useLast: command.useLast,
    stateDir: command.stateDir,
    codexBin: command.codexBin,
    intervalSeconds: command.intervalSeconds,
    maxAttempts: command.maxAttempts
  });
}

/**
 * 业务职责：统一承接“读取任务状态”的业务入口，避免 CLI 和 MCP 分别维护 status 的查找规则。
 */
export async function getTaskStatus(command: GetTaskStatusCommand): Promise<Awaited<ReturnType<typeof getSessionStatus>>> {
  return getSessionStatus({
    sessionId: command.sessionId,
    jobId: command.jobId,
    useLast: command.useLast,
    stateDir: command.stateDir
  });
}

/**
 * 业务职责：统一承接“查看最近执行步骤”的业务入口，让 MCP 聊天轮询和未来 CLI tail 共享同一套查询逻辑。
 */
export async function getTaskTail(command: TailSessionCommand): Promise<Awaited<ReturnType<typeof tailSession>>> {
  return tailSession({
    sessionId: command.sessionId,
    jobId: command.jobId,
    useLast: command.useLast,
    stateDir: command.stateDir,
    tailLines: command.tailLines
  });
}

/**
 * 业务职责：统一对外暴露仓库内可用 skill 清单，供 CLI 列表页和 MCP `list_skills` 共享同一份公开元数据。
 */
export async function listAvailableSkills(skillsRoot = path.resolve("skills")): Promise<PublicSkillDefinition[]> {
  const definitions = await listSkills(path.resolve(skillsRoot));
  return definitions.map((definition) => toPublicSkillDefinition(definition));
}

/**
 * 业务职责：统一承接“把当前聊天最近几轮转成任务”的公开入口，
 * 让 slash 和普通当前聊天触发都走同一个内部路由器而不是暴露分类参数。
 */
export async function startTaskFromCurrentChat(command: StartFromCurrentChatCommand): Promise<ChatIntentRouteResult> {
  return routeChatIntent(normalizeCurrentChatRoute(command));
}

/**
 * 业务职责：统一承接“继续当前目录最近任务”的公开入口，
 * 让 MCP 调用方通过 tool 语义表达 continue，而不是直接操作内部 triggerMode。
 */
export async function continueCurrentDirectoryTask(command: ContinueCurrentDirectoryTaskCommand): Promise<ChatIntentRouteResult> {
  return routeChatIntent(normalizeCurrentChatRoute(command));
}

/**
 * 业务职责：统一承接“从当前聊天运行指定仓库 skill”的公开入口，
 * 让 MCP 调用方只给 skill 名和聊天上下文，内部再负责分类与补参。
 */
export async function runSkillFromCurrentChat(command: RunSkillFromCurrentChatCommand): Promise<ChatIntentRouteResult> {
  return routeChatIntent(normalizeCurrentChatRoute(command, { skillName: command.skillName }));
}

/**
 * 业务职责：统一承接内部聊天意图路由，让“继续旧任务还是创建新任务”的决策从 transport 层下沉到业务层。
 */
export async function routeChatIntent(command: RouteChatIntentCommand): Promise<ChatIntentRouteResult> {
  return routeChatIntentWithPolicies(command);
}

/**
 * 业务职责：把面向当前聊天的公开命令收敛成内部路由器需要的最小事实输入，
 * 避免 MCP transport 再把 slash / natural / explicit_skill 这些内部分类泄漏给外部调用方。
 */
function normalizeCurrentChatRoute(
  command: StartFromCurrentChatCommand | ContinueCurrentDirectoryTaskCommand | RunSkillFromCurrentChatCommand,
  overrides: Partial<Pick<RouteChatIntentCommand, "skillName">> = {}
): RouteChatIntentCommand {
  return {
    chatIntent: command.chatIntent,
    chatSummary: command.chatSummary,
    chatWindowTurns: command.chatWindowTurns,
    workdir: command.workdir,
    stateDir: command.stateDir,
    model: command.model,
    profile: command.profile,
    maxAttempts: command.maxAttempts,
    skillsRoot: command.skillsRoot,
    skillName: overrides.skillName
  };
}
