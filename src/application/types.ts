/**
 * 业务职责：应用层类型模块定义统一的命令输入、业务结果和对外可展示字段，
 * 让 CLI、MCP 入口都围绕同一套语义边界协作，而不是各自拼装零散参数。
 */
import type { JobRunResult, ResumeSessionOptions, RunTaskOptions, SessionTailResult, TailSessionOptions } from "../engine/job.js";

/**
 * 业务职责：统一描述所有应用层命令可继承的运行上下文。
 */
export interface CommandExecutionContext {
  workdir?: string;
  stateDir?: string;
  model?: string;
  profile?: string;
  codexBin?: string;
  intervalSeconds?: number;
  fullAuto?: boolean;
  dangerouslyBypass?: boolean;
  skipGitRepoCheck?: boolean;
  startWithResumeIfPossible?: boolean;
  maxAttempts?: number;
}

/**
 * 业务职责：直接任务命令描述"已经有明确任务文本"的执行请求。
 */
export interface RunDirectTaskCommand extends CommandExecutionContext {
  task: string;
  promptSource?: "file" | "text" | "skill";
  sourcePromptFile?: string;
  exactStateDir?: string;
  jobId?: string;
  confirmText?: string;
  resumeTextBase?: string;
  fireAndForget?: boolean;
}

/**
 * 业务职责：Prompt 文件任务命令描述"从 Markdown 文件读取任务"的执行请求。
 */
export interface RunPromptFileCommand extends CommandExecutionContext {
  promptFile: string;
  fireAndForget?: boolean;
}

/**
 * 业务职责：Skill 命令描述"按仓库任务配方执行"的请求。
 */
export interface RunSkillCommand extends CommandExecutionContext {
  skillName: string;
  inputs?: Record<string, string>;
  interactive?: boolean;
  skillsRoot?: string;
  fireAndForget?: boolean;
}

/**
 * 业务职责：恢复任务命令统一描述 session id、job id 和最近任务恢复等定位方式。
 */
export interface ResumeTaskCommand extends Pick<ResumeSessionOptions, "sessionId" | "jobId" | "useLast" | "stateDir" | "codexBin" | "intervalSeconds" | "maxAttempts"> {}

/**
 * 业务职责：状态查询命令描述"只查状态、不推进执行"的查询请求。
 */
export interface GetTaskStatusCommand {
  sessionId?: string;
  jobId?: string;
  useLast?: boolean;
  stateDir?: string;
}

/**
 * 业务职责：会话尾读命令描述"只看最近进度、不推进执行"的查询请求。
 */
export interface TailSessionCommand extends Pick<TailSessionOptions, "sessionId" | "jobId" | "useLast" | "stateDir" | "tailLines"> {}

/**
 * 业务职责：公开 skill 定义描述对外可见的技能元数据。
 */
export interface PublicSkillDefinition {
  name: string;
  description: string;
  inputs: Record<string, { description: string; required?: boolean; default?: string; prompt?: string }>;
  defaultWorkdir?: string;
  defaultModel?: string;
  outputContract: string;
}

/**
 * 业务职责：应用层总结果类型为 presenter 和测试提供统一输入范围。
 */
export type ApplicationResult = JobRunResult | SessionTailResult | PublicSkillDefinition[];

/**
 * 业务职责：把 direct task 命令映射到底层执行引擎需要的运行参数。
 */
export function toRunTaskOptions(command: RunDirectTaskCommand): RunTaskOptions {
  return {
    task: command.task,
    workdir: command.workdir,
    stateDir: command.stateDir,
    exactStateDir: command.exactStateDir,
    jobId: command.jobId,
    model: command.model,
    profile: command.profile,
    codexBin: command.codexBin,
    confirmText: command.confirmText,
    resumeTextBase: command.resumeTextBase,
    intervalSeconds: command.intervalSeconds,
    fullAuto: command.fullAuto,
    dangerouslyBypass: command.dangerouslyBypass,
    skipGitRepoCheck: command.skipGitRepoCheck,
    startWithResumeIfPossible: command.startWithResumeIfPossible,
    maxAttempts: command.maxAttempts,
    promptSource: command.promptSource,
    sourcePromptFile: command.sourcePromptFile,
    fireAndForget: command.fireAndForget
  };
}
