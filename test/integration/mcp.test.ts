/**
 * 业务职责：MCP 契约测试验证对外工具集合、输入错误和结果字段满足外部 agent 集成要求，
 * 确保项目可以被当作统一任务执行服务调用。
 */
import { rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandlers, createMcpServer } from "../../src/mcp/server.js";
import { createFakeCodexWorkspace } from "./helpers.js";

describe("mcp server contracts", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })));
  });

  /**
   * 业务职责：验证 MCP server 至少暴露固定的对外工具集合，保证公共接口后续只增不改。
   */
  it("creates fixed tool set", () => {
    const server = createMcpServer();
    expect(server).toBeTruthy();
  });

  /**
   * 业务职责：验证缺失 skill 时会报错，避免外部 agent 调不存在的模板时拿到模糊结果。
   */
  it("fails on missing skill", async () => {
    const handlers = createMcpHandlers();
    const response = await handlers.runSkillTool({ skillName: "missing-skill" });
    expect(JSON.parse(response.content[0].text).error.code).toBe("SKILL_NOT_FOUND");
  });

  /**
   * 业务职责：验证真实任务结果会返回 jobId、sessionId 和 stateDir 这些续跑关键字段。
   */
  it("returns resumable identifiers from engine", async () => {
    const workspace = await createFakeCodexWorkspace();
    cleanup.push(workspace.root);
    process.env.FAKE_CODEX_STATE_FILE = workspace.stateFile;
    process.env.FAKE_CODEX_BEHAVIOR = "complete_immediately";
    process.env.CODEX_BIN = workspace.fakeCodexPath;

    const { runTask } = await import("../../src/engine/job.js");
    const result = await runTask({
      task: "mcp task",
      workdir: workspace.workdir,
      stateDir: path.join(workspace.root, ".codex-run"),
      codexBin: workspace.fakeCodexPath
    });

    expect(result.jobId).toBeTruthy();
    expect(result.sessionId).toBeTruthy();
    expect(result.stateDir).toContain(".codex-run");
  });

  /**
   * 业务职责：验证状态查询在 session 缺失时会给出清晰错误，避免外部 agent 误以为任务仍可恢复。
   */
  it("fails on invalid session status lookup", async () => {
    const handlers = createMcpHandlers();
    const response = await handlers.getSessionStatusTool({ sessionId: "missing", stateDir: path.resolve(".codex-run") });
    expect(JSON.parse(response.content[0].text).error.code).toBe("SESSION_NOT_FOUND");
  });

  /**
   * 业务职责：验证 `tail_session` 会把最近任务的最后消息、事件流尾部和运行日志尾部返回给当前聊天轮询显示。
   */
  it("returns tail snapshot for the latest task", async () => {
    const workspace = await createFakeCodexWorkspace();
    cleanup.push(workspace.root);
    process.env.FAKE_CODEX_STATE_FILE = workspace.stateFile;
    process.env.FAKE_CODEX_BEHAVIOR = "complete_immediately";
    process.env.CODEX_BIN = workspace.fakeCodexPath;

    const handlers = createMcpHandlers();
    const stateDir = path.join(workspace.root, ".codex-run");
    const runResponse = await handlers.runTaskTool({
      task: "输出最近执行进度",
      workdir: workspace.workdir,
      stateDir
    });
    const runPayload = JSON.parse(runResponse.content[0].text);
    await writeFile(path.join(runPayload.stateDir, "runner.log"), "line-1\nline-2\nline-3\n", "utf8");

    const response = await handlers.tailSessionTool({
      useLast: true,
      stateDir,
      tailLines: 2
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.jobId).toBe(runPayload.jobId);
    expect(payload.sessionId).toBeTruthy();
    expect(payload.lastMessage).toContain("CONFIRMED: all tasks completed");
    expect(payload.attemptCount).toBeGreaterThan(0);
    expect(payload.runnerLogTail).toEqual(["line-2", "line-3"]);
    expect(payload.eventLogTail.at(-1)).toContain("\"session_id\"");
  });

  /**
   * 业务职责：验证缺失 skill 必填输入时会返回稳定错误结构，便于外部 agent 决定是否需要补参后重试。
   */
  it("fails on missing required skill input", async () => {
    const handlers = createMcpHandlers();
    const response = await handlers.runSkillTool({ skillName: "research" });
    expect(JSON.parse(response.content[0].text).error.code).toBe("SKILL_INPUT_MISSING");
  });

  /**
   * 业务职责：验证无效 workdir 会以下沉后的 failed 结果返回，而不是只抛出不稳定异常文本。
   */
  it("returns failed payload for invalid workdir", async () => {
    const handlers = createMcpHandlers();
    const response = await handlers.runTaskTool({
      task: "invalid workdir test",
      workdir: "/path/does/not/exist",
      stateDir: path.resolve(".codex-run")
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.status).toBe("failed");
    expect(payload.error.code).toBe("WORKDIR_NOT_FOUND");
  });

  /**
   * 业务职责：验证 `list_skills` 返回的公开字段完整，避免 MCP 使用方需要再猜测 manifest 结构。
   */
  it("lists skills with public fields", async () => {
    const handlers = createMcpHandlers();
    const response = await handlers.listSkillsTool();
    const payload = JSON.parse(response.content[0].text);

    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]).toMatchObject({
      name: expect.any(String),
      description: expect.any(String),
      inputs: expect.any(Object),
      outputContract: expect.any(String)
    });
  });

  /**
   * 业务职责：验证聊天内“继续做”话术会优先路由到当前目录最近任务，保证插件固定话术能自动接续长任务链。
   */
  it("routes continue_current_directory_task to resume_session", async () => {
    const workspace = await createFakeCodexWorkspace();
    cleanup.push(workspace.root);
    process.env.FAKE_CODEX_STATE_FILE = workspace.stateFile;
    process.env.FAKE_CODEX_BEHAVIOR = "complete_immediately";
    process.env.CODEX_BIN = workspace.fakeCodexPath;

    const handlers = createMcpHandlers();
    const stateDir = path.join(workspace.root, ".codex-run");

    await handlers.runTaskTool({
      task: "继续完善 README、插件文案和 MCP 测试",
      workdir: workspace.workdir,
      stateDir
    });

    const response = await handlers.continueCurrentDirectoryTaskTool({
      chatIntent: "用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。",
      chatSummary: "继续完善 README、插件文案和 MCP 测试",
      workdir: workspace.workdir,
      stateDir
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.action).toBe("resume_session");
    expect(payload.reason).toContain("unfinished work");
    expect(payload.stateDir).toContain(".codex-run");
    expect(payload.sessionId).toBeTruthy();
  });

  /**
   * 业务职责：验证聊天窗 slash 入口会把最近聊天窗口交给统一路由，并在匹配旧链路时自动续跑当前目录最近任务。
   */
  it("routes start_from_current_chat slash intent to resume_session", async () => {
    const workspace = await createFakeCodexWorkspace();
    cleanup.push(workspace.root);
    process.env.FAKE_CODEX_STATE_FILE = workspace.stateFile;
    process.env.FAKE_CODEX_BEHAVIOR = "complete_immediately";
    process.env.CODEX_BIN = workspace.fakeCodexPath;

    const handlers = createMcpHandlers();
    const stateDir = path.join(workspace.root, ".codex-run");

    await handlers.runTaskTool({
      task: "补 README 的聊天窗触发说明和 MCP 路由测试",
      workdir: workspace.workdir,
      stateDir
    });

    const response = await handlers.startFromCurrentChatTool({
      chatIntent: "/codex-autoresearch",
      chatWindowTurns: [
        "我们已经把 CLI 安装说明补完了。",
        "还差 README 的聊天窗触发说明和 MCP 路由测试。",
        "下一步继续补 README 的聊天窗触发说明和 MCP 路由测试。"
      ],
      workdir: workspace.workdir,
      stateDir
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.action).toBe("resume_session");
    expect(payload.triggerMode).toBe("slash");
    expect(payload.reason).toContain("slash trigger");
  });

  /**
   * 业务职责：验证聊天内“处理当前需求”会在没有续跑信号时直接新建任务，避免固定话术误附着旧链路。
   */
  it("routes start_from_current_chat to run_task", async () => {
    const workspace = await createFakeCodexWorkspace();
    cleanup.push(workspace.root);
    process.env.FAKE_CODEX_STATE_FILE = workspace.stateFile;
    process.env.FAKE_CODEX_BEHAVIOR = "complete_immediately";
    process.env.CODEX_BIN = workspace.fakeCodexPath;

    const handlers = createMcpHandlers();
    const response = await handlers.startFromCurrentChatTool({
      chatIntent: "用 codex-autoresearch 处理我们当前聊天里正在讨论的需求。",
      chatSummary: "为当前仓库补 README 里的 MCP 用法说明和测试示例。",
      workdir: workspace.workdir,
      stateDir: path.join(workspace.root, ".codex-run")
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.action).toBe("run_task");
    expect(payload.reason).toContain("started a fresh codex-autoresearch task");
    expect(payload.jobId).toBeTruthy();
  });

  /**
   * 业务职责：验证当前聊天里显式点名仓库 skill 时，MCP 路由会真正落到 `run_skill` 风格执行结果。
   */
  it("routes run_skill_from_current_chat to run_skill", async () => {
    const workspace = await createFakeCodexWorkspace();
    cleanup.push(workspace.root);
    process.env.FAKE_CODEX_STATE_FILE = workspace.stateFile;
    process.env.FAKE_CODEX_BEHAVIOR = "complete_immediately";
    process.env.CODEX_BIN = workspace.fakeCodexPath;

    const handlers = createMcpHandlers();
    const response = await handlers.runSkillFromCurrentChatTool({
      chatIntent: "用 research skill 处理我们当前聊天刚才讨论的需求。",
      skillName: "research",
      chatWindowTurns: [
        "我们要整理 codex-autoresearch 在聊天窗里怎么触发永动机。",
        "只关注 README、插件说明和 MCP 路由，不展开更多重构。"
      ],
      chatSummary: "整理 codex-autoresearch 在聊天窗里的触发方式。",
      workdir: workspace.workdir,
      stateDir: path.join(workspace.root, ".codex-run")
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.action).toBe("run_skill");
    expect(payload.skillName).toBe("research");
    expect(payload.resolvedSkillInputs.topic).toContain("聊天窗");
    expect(payload.jobId).toBeTruthy();
  });

  /**
   * 业务职责：验证聊天目标与当前目录最近任务冲突时会返回稳定确认态，避免插件静默续跑错误任务。
   */
  it("returns explicit conflict for mismatched continue_current_directory_task intent", async () => {
    const workspace = await createFakeCodexWorkspace();
    cleanup.push(workspace.root);
    process.env.FAKE_CODEX_STATE_FILE = workspace.stateFile;
    process.env.FAKE_CODEX_BEHAVIOR = "complete_immediately";
    process.env.CODEX_BIN = workspace.fakeCodexPath;

    const handlers = createMcpHandlers();
    const stateDir = path.join(workspace.root, ".codex-run");

    await handlers.runTaskTool({
      task: "修复支付回调重试逻辑并补集成测试",
      workdir: workspace.workdir,
      stateDir
    });

    const response = await handlers.continueCurrentDirectoryTaskTool({
      chatIntent: "用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。",
      chatSummary: "继续重写 README 的安装指南和插件市场说明。",
      workdir: workspace.workdir,
      stateDir
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.action).toBe("conflict");
    expect(payload.status).toBe("needs_confirmation");
    expect(payload.reason).toContain("different from the latest current-directory codex-autoresearch task");
  });
});
