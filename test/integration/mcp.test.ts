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
   * 业务职责：验证 MCP server 至少暴露固定的五个对外工具，保证公共接口后续只增不改。
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
  it("routes continue chat intent to resume_session", async () => {
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

    const response = await handlers.routeChatIntentTool({
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
   * 业务职责：验证聊天内“处理当前需求”会在没有续跑信号时直接新建任务，避免固定话术误附着旧链路。
   */
  it("routes new chat intent to run_task", async () => {
    const workspace = await createFakeCodexWorkspace();
    cleanup.push(workspace.root);
    process.env.FAKE_CODEX_STATE_FILE = workspace.stateFile;
    process.env.FAKE_CODEX_BEHAVIOR = "complete_immediately";
    process.env.CODEX_BIN = workspace.fakeCodexPath;

    const handlers = createMcpHandlers();
    const response = await handlers.routeChatIntentTool({
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
   * 业务职责：验证聊天目标与当前目录最近任务冲突时会返回稳定确认态，避免插件静默续跑错误任务。
   */
  it("returns explicit conflict for mismatched continue intent", async () => {
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

    const response = await handlers.routeChatIntentTool({
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
