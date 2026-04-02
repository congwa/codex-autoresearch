/**
 * 业务职责：应用层单测验证共享用例确实承担了 direct task、skill、列表和聊天路由的统一编排职责，
 * 避免本次重构后 transport 仍然偷偷保留一套平行逻辑。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runTaskMock = vi.fn();
const resumeSessionMock = vi.fn();
const getSessionStatusMock = vi.fn();
const tailSessionMock = vi.fn();
const loadSkillMock = vi.fn();
const resolveSkillInputsMock = vi.fn();
const renderSkillPromptMock = vi.fn();
const listSkillsMock = vi.fn();
const toPublicSkillDefinitionMock = vi.fn();
const routeChatIntentWithPoliciesMock = vi.fn();

vi.mock("../../src/engine/job.js", () => ({
  runTask: runTaskMock,
  resumeSession: resumeSessionMock,
  getSessionStatus: getSessionStatusMock,
  tailSession: tailSessionMock
}));

vi.mock("../../src/skills/skill.js", () => ({
  loadSkill: loadSkillMock,
  resolveSkillInputs: resolveSkillInputsMock,
  renderSkillPrompt: renderSkillPromptMock,
  listSkills: listSkillsMock,
  toPublicSkillDefinition: toPublicSkillDefinitionMock
}));

vi.mock("../../src/routing/chat-intent.js", () => ({
  routeChatIntentWithPolicies: routeChatIntentWithPoliciesMock
}));

describe("application use cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTaskMock.mockResolvedValue({
      jobId: "job-1",
      sessionId: "session-1",
      stateDir: "/tmp/.codex-run/job-1",
      status: "completed",
      lastMessage: "done",
      lastMessageFile: "/tmp/.codex-run/job-1/last-message.txt"
    });
    resumeSessionMock.mockResolvedValue({
      jobId: "job-2",
      sessionId: "session-2",
      stateDir: "/tmp/.codex-run/job-2",
      status: "needs_resume",
      lastMessage: "keep going",
      lastMessageFile: "/tmp/.codex-run/job-2/last-message.txt"
    });
    getSessionStatusMock.mockResolvedValue({
      jobId: "job-3",
      sessionId: "session-3",
      stateDir: "/tmp/.codex-run/job-3",
      status: "completed",
      lastMessage: "status",
      lastMessageFile: "/tmp/.codex-run/job-3/last-message.txt"
    });
    tailSessionMock.mockResolvedValue({
      jobId: "job-4",
      sessionId: "session-4",
      stateDir: "/tmp/.codex-run/job-4",
      status: "needs_resume",
      lastMessage: "still working",
      lastMessageFile: "/tmp/.codex-run/job-4/last-message.txt",
      attemptCount: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z",
      runnerLogTail: ["stderr line"],
      eventLogTail: ["{\"session_id\":\"session-4\"}"]
    });
  });

  /**
   * 业务职责：验证 direct task 用例只保留统一编排职责，并把最终任务交回底层执行引擎。
   */
  it("delegates direct task execution to the engine", async () => {
    const { runDirectTask } = await import("../../src/application/use-cases.js");

    await runDirectTask({
      task: "fix bug",
      workdir: "/repo",
      stateDir: "/repo/.codex-run",
      intervalSeconds: 5
    });

    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "fix bug",
        workdir: "/repo",
        stateDir: "/repo/.codex-run",
        intervalSeconds: 5
      })
    );
  });

  /**
   * 业务职责：验证 skill 用例会统一执行“加载定义 -> 补齐输入 -> 渲染 prompt -> 走 direct task”这一条链路。
   */
  it("runs skill tasks through the shared orchestration flow", async () => {
    loadSkillMock.mockResolvedValue({
      manifest: {
        name: "research",
        description: "research",
        inputs: { topic: { description: "topic", required: true } },
        defaultWorkdir: "/default-workdir",
        defaultModel: "gpt-test",
        outputContract: "deliver"
      },
      promptTemplate: "Topic: {{topic}}",
      directory: "/skills/research"
    });
    resolveSkillInputsMock.mockResolvedValue({ topic: "CLI" });
    renderSkillPromptMock.mockReturnValue("Topic: CLI");
    const { runSkillTask } = await import("../../src/application/use-cases.js");

    await runSkillTask({
      skillName: "research",
      inputs: {},
      interactive: false
    });

    expect(loadSkillMock).toHaveBeenCalled();
    expect(resolveSkillInputsMock).toHaveBeenCalled();
    expect(renderSkillPromptMock).toHaveBeenCalledWith("Topic: {{topic}}", { topic: "CLI" });
    expect(runTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Topic: CLI",
        workdir: "/default-workdir",
        model: "gpt-test"
      })
    );
  });

  /**
   * 业务职责：验证 skill 列表用例会把内部定义统一裁剪成对外公开字段，避免 transport 再自己拼列表结构。
   */
  it("maps internal skill definitions to public skill metadata", async () => {
    listSkillsMock.mockResolvedValue([{ manifest: { name: "research" } }, { manifest: { name: "phased-validation" } }]);
    toPublicSkillDefinitionMock
      .mockReturnValueOnce({ name: "research", description: "research", inputs: {}, outputContract: "deliver" })
      .mockReturnValueOnce({ name: "phased-validation", description: "validate", inputs: {}, outputContract: "deliver" });
    const { listAvailableSkills } = await import("../../src/application/use-cases.js");

    const result = await listAvailableSkills();

    expect(result).toHaveLength(2);
    expect(toPublicSkillDefinitionMock).toHaveBeenCalledTimes(2);
  });

  /**
   * 业务职责：验证任务尾读用例只负责把聊天轮询请求转发给引擎，不在应用层重复拼日志逻辑。
   */
  it("delegates task tail lookup to the engine", async () => {
    const { getTaskTail } = await import("../../src/application/use-cases.js");

    const result = await getTaskTail({
      useLast: true,
      stateDir: "/repo/.codex-run",
      tailLines: 20
    });

    expect(tailSessionMock).toHaveBeenCalledWith({
      useLast: true,
      stateDir: "/repo/.codex-run",
      tailLines: 20,
      sessionId: undefined,
      jobId: undefined
    });
    expect(result.attemptCount).toBe(2);
  });

  /**
   * 业务职责：验证聊天路由用例只是委托给独立 routing 模块，确保 transport 不再承担业务决策。
   */
  it("delegates chat intent routing to the dedicated routing module", async () => {
    routeChatIntentWithPoliciesMock.mockResolvedValue({
      action: "conflict",
      reason: "confirm",
      chatIntent: "继续做",
      chatSummary: "继续做",
      status: "needs_confirmation"
    });
    const { routeChatIntent } = await import("../../src/application/use-cases.js");

    const result = await routeChatIntent({
      chatIntent: "继续做",
      chatSummary: "继续做"
    });

    expect(routeChatIntentWithPoliciesMock).toHaveBeenCalledWith({
      chatIntent: "继续做",
      chatSummary: "继续做"
    });
    expect(result.action).toBe("conflict");
  });
});
