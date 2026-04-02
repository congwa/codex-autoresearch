/**
 * 业务职责：MCP 服务层把本仓库暴露成可被外部 agent 调用的任务执行服务，
 * 让 run task、prompt file、run skill、resume 和状态查询都通过统一执行引擎完成。
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  getTaskStatus,
  getTaskTail,
  listAvailableSkills,
  resumeExistingTask,
  runDirectTask,
  runSkillTask,
  runTaskFromPromptFile
} from "../application/use-cases.js";
import { presentFailurePayload, presentMcpJson, type TextContentResponse } from "../presenters/json.js";

const RunTaskSchema = {
  task: z.string().min(1),
  workdir: z.string().optional(),
  stateDir: z.string().optional(),
  model: z.string().optional(),
  profile: z.string().optional(),
  maxAttempts: z.number().int().positive().optional()
};

const StartTaskFromPromptFileSchema = {
  promptFile: z.string().min(1),
  workdir: z.string().optional(),
  stateDir: z.string().optional(),
  maxAttempts: z.number().int().positive().optional()
};

const RunSkillSchema = {
  skillName: z.string().min(1),
  inputs: z.record(z.string(), z.string()).optional(),
  workdir: z.string().optional(),
  stateDir: z.string().optional(),
  model: z.string().optional(),
  interactive: z.boolean().optional(),
  maxAttempts: z.number().int().positive().optional()
};

const ResumeSchema = {
  sessionId: z.string().optional(),
  jobId: z.string().optional(),
  useLast: z.boolean().optional(),
  stateDir: z.string().optional(),
  maxAttempts: z.number().int().positive().optional()
};

const StatusSchema = {
  sessionId: z.string().optional(),
  jobId: z.string().optional(),
  useLast: z.boolean().optional(),
  stateDir: z.string().optional()
};

const TailSessionSchema = {
  sessionId: z.string().optional(),
  jobId: z.string().optional(),
  useLast: z.boolean().optional(),
  stateDir: z.string().optional(),
  tailLines: z.number().int().positive().max(200).optional()
};

export interface McpHandlers {
  runTaskTool: (input: { task: string; workdir?: string; stateDir?: string; model?: string; profile?: string; maxAttempts?: number }) => Promise<TextContentResponse>;
  startTaskFromPromptFileTool: (input: { promptFile: string; workdir?: string; stateDir?: string; maxAttempts?: number }) => Promise<TextContentResponse>;
  runSkillTool: (input: { skillName: string; inputs?: Record<string, string>; workdir?: string; stateDir?: string; model?: string; interactive?: boolean; maxAttempts?: number }) => Promise<TextContentResponse>;
  resumeSessionTool: (input: { sessionId?: string; jobId?: string; useLast?: boolean; stateDir?: string; maxAttempts?: number }) => Promise<TextContentResponse>;
  getSessionStatusTool: (input: { sessionId?: string; jobId?: string; useLast?: boolean; stateDir?: string }) => Promise<TextContentResponse>;
  tailSessionTool: (input: { sessionId?: string; jobId?: string; useLast?: boolean; stateDir?: string; tailLines?: number }) => Promise<TextContentResponse>;
  listSkillsTool: () => Promise<TextContentResponse>;
}

export function createMcpHandlers(): McpHandlers {
  return {
    async runTaskTool(input) {
      return handleTool(async () =>
        presentMcpJson(
          await runDirectTask({
            task: input.task,
            workdir: input.workdir,
            stateDir: input.stateDir,
            model: input.model,
            profile: input.profile,
            maxAttempts: input.maxAttempts,
            fireAndForget: true
          })
        )
      );
    },
    async startTaskFromPromptFileTool(input) {
      return handleTool(async () =>
        presentMcpJson(
          await runTaskFromPromptFile({
            promptFile: input.promptFile,
            workdir: input.workdir,
            stateDir: input.stateDir,
            maxAttempts: input.maxAttempts,
            fireAndForget: true
          })
        )
      );
    },
    async runSkillTool(input) {
      return handleTool(async () =>
        presentMcpJson(
          await runSkillTask({
            skillName: input.skillName,
            inputs: input.inputs,
            workdir: input.workdir,
            stateDir: input.stateDir,
            model: input.model,
            interactive: input.interactive,
            maxAttempts: input.maxAttempts,
            fireAndForget: true
          })
        )
      );
    },
    async resumeSessionTool(input) {
      return handleTool(async () =>
        presentMcpJson(
          await resumeExistingTask({
            sessionId: input.sessionId,
            jobId: input.jobId,
            useLast: input.useLast,
            stateDir: input.stateDir,
            maxAttempts: input.maxAttempts
          })
        )
      );
    },
    async getSessionStatusTool(input) {
      return handleTool(async () =>
        presentMcpJson(
          await getTaskStatus({
            sessionId: input.sessionId,
            jobId: input.jobId,
            useLast: input.useLast,
            stateDir: input.stateDir
          })
        )
      );
    },
    async tailSessionTool(input) {
      return handleTool(async () =>
        presentMcpJson(
          await getTaskTail({
            sessionId: input.sessionId,
            jobId: input.jobId,
            useLast: input.useLast,
            stateDir: input.stateDir,
            tailLines: input.tailLines
          })
        )
      );
    },
    async listSkillsTool() {
      return handleTool(async () => presentMcpJson(await listAvailableSkills()));
    }
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "codex-autoresearch",
    version: "0.1.0"
  });
  const handlers = createMcpHandlers();

  server.tool(
    "run_task",
    [
      "启动一个后台永动机任务并立即返回任务元信息（jobId、stateDir）。",
      "重要使用规则：",
      "1. 你（调用方）只是控制面，不要自己做研究或读文件后再调此工具。直接把完整任务描述交给 run_task，让后台 worker 自己去做。",
      "2. task 文本应该是一个完整的、可独立执行的任务描述，包含目标、约束、预期产出文件路径。",
      "3. 如果任务是修改文件，task 里必须明确写'直接修改/写入 <文件路径>'，否则 worker 只会输出建议而不落盘。",
      "4. 任务启动后用 tail_session 轮询进度，不要重复调用 run_task。",
      "5. 后台 worker 会自动持续推进（永动机），未完成时自动 resume，直到任务真正完成。",
      "6. 你必须持续轮询直到 tail_session 返回的 status 为 completed 或 failed 才能结束跟进。status 为 running 或 needs_resume 时必须继续轮询。",
      "7. 不要自己用 shell 命令（wc、cat、git diff 等）去检查目标文件来判断任务是否完成，唯一的完成信号是 status === 'completed'。",
      "8. 轮询间隔建议 15-30 秒，长任务可能需要几分钟甚至更长，请耐心等待。"
    ].join("\n"),
    RunTaskSchema,
    async (input) => handlers.runTaskTool(input)
  );

  server.tool(
    "start_task_from_prompt_file",
    [
      "从 prompt 文件启动后台永动机任务并立即返回任务元信息。",
      "推荐主路径：先把任务写成 prompt.md 文件，再调此工具。",
      "任务启动后用 tail_session 轮询进度。后台 worker 会自动持续推进直到完成。"
    ].join("\n"),
    StartTaskFromPromptFileSchema,
    async (input) => handlers.startTaskFromPromptFileTool(input)
  );

  server.tool("run_skill", "运行一个仓库内 skill 配方。后台执行，用 tail_session 轮询进度。", RunSkillSchema, async (input) => handlers.runSkillTool(input));

  server.tool("resume_session", "续跑已有 session 或最近一次任务。", ResumeSchema, async (input) => handlers.resumeSessionTool(input));

  server.tool("get_session_status", "读取已有任务状态，不推进执行。", StatusSchema, async (input) => handlers.getSessionStatusTool(input));

  server.tool(
    "tail_session",
    [
      "读取已有任务最近的执行步骤与日志尾部，不推进执行。",
      "用于在 run_task / start_task_from_prompt_file 启动任务后轮询进度。",
      "建议每次间隔 15-30 秒轮询一次。",
      "关键：只有当返回的 status 为 completed 或 failed 时才表示任务结束。",
      "status 为 running 或 needs_resume 时必须继续轮询，不要提前结束。",
      "不要自己用其他方式（读文件、git diff 等）判断任务完成，以 status 字段为准。"
    ].join("\n"),
    TailSessionSchema,
    async (input) => handlers.tailSessionTool(input)
  );

  server.tool("list_skills", "列出仓库内可用 skills。", {}, async () => handlers.listSkillsTool());

  return server;
}

export async function serveMcp(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function handleTool(run: () => Promise<TextContentResponse>) {
  try {
    return await run();
  } catch (error) {
    return presentMcpJson(presentFailurePayload(error));
  }
}
