/**
 * 业务职责：应用层用例模块把 direct task、prompt file、resume 和状态查询统一成稳定业务入口，
 * 让 CLI 只负责解析与展示，而不再直接编排底层引擎细节。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSessionStatus, resumeSession, runTask, tailSession } from "../engine/job.js";
import type {
  GetTaskStatusCommand,
  ResumeTaskCommand,
  RunDirectTaskCommand,
  RunPromptFileCommand,
  TailSessionCommand
} from "./types.js";
import { toRunTaskOptions } from "./types.js";

/**
 * 业务职责：统一承接"执行一条明确任务"的业务入口。
 */
export async function runDirectTask(command: RunDirectTaskCommand): Promise<Awaited<ReturnType<typeof runTask>>> {
  return runTask(toRunTaskOptions(command));
}

/**
 * 业务职责：统一承接"从 prompt 文件启动任务"的业务入口，读取文件内容作为唯一初始 prompt。
 */
export async function runTaskFromPromptFile(command: RunPromptFileCommand): Promise<Awaited<ReturnType<typeof runTask>>> {
  const resolvedPath = path.resolve(command.promptFile);
  const task = await readFile(resolvedPath, "utf8");
  return runDirectTask({
    ...command,
    task,
    promptSource: "file",
    sourcePromptFile: resolvedPath,
    fireAndForget: command.fireAndForget,
    onStream: command.onStream
  });
}

/**
 * 业务职责：统一承接"继续已有任务"的业务入口。
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
 * 业务职责：统一承接"读取任务状态"的业务入口。
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
 * 业务职责：统一承接"查看最近执行步骤"的业务入口。
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
