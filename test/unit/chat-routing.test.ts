/**
 * 业务职责：聊天路由单测验证 slash / 自然语言 / 显式 skill 三类聊天窗入口都被统一策略稳定承接，
 * 避免这些业务判断重新回流到 MCP server、README 示例或插件层里。
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_WINDOW_TURNS, routeChatIntentWithPolicies, takeRecentChatTurns } from "../../src/routing/chat-intent.js";

function createRoutingDependencies() {
  return {
    resolveResumeTarget: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn(),
    runTask: vi.fn(),
    loadSkill: vi.fn(),
    resolveSkillInputs: vi.fn(),
    renderSkillPrompt: vi.fn(),
    readPromptFile: vi.fn().mockResolvedValue("")
  };
}

describe("chat intent routing", () => {
  /**
   * 业务职责：验证明显的“继续做”意图会优先接到当前目录最近任务，而不是误新建任务。
   */
  it("routes continue intent to resume when latest task matches", async () => {
    const dependencies = createRoutingDependencies();
    dependencies.resolveResumeTarget.mockResolvedValue({
      stateDir: "/tmp/.codex-run/job-1",
      initialPromptFile: "/tmp/.codex-run/job-1/initial-prompt.txt"
    });
    dependencies.resumeSession.mockResolvedValue({
      jobId: "job-1",
      sessionId: "session-1",
      stateDir: "/tmp/.codex-run/job-1",
      status: "completed",
      lastMessage: "done",
      lastMessageFile: "/tmp/.codex-run/job-1/last-message.txt"
    });
    dependencies.readPromptFile.mockResolvedValue("继续完善 README 和 MCP 测试");

    const result = await routeChatIntentWithPolicies(
      {
        chatIntent: "用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。",
        chatSummary: "继续完善 README 和 MCP 测试",
        stateDir: "/tmp/.codex-run"
      },
      dependencies
    );

    expect(result.action).toBe("resume_session");
    expect(result.reason).toContain("unfinished work");
  });

  /**
   * 业务职责：验证 slash 触发在当前聊天最近几轮仍匹配旧目标时，也会自动接到当前目录最近任务。
   */
  it("routes slash intent to resume when recent chat matches the latest task", async () => {
    const dependencies = createRoutingDependencies();
    dependencies.resolveResumeTarget.mockResolvedValue({
      stateDir: "/tmp/.codex-run/job-2",
      initialPromptFile: "/tmp/.codex-run/job-2/initial-prompt.txt"
    });
    dependencies.resumeSession.mockResolvedValue({
      jobId: "job-2",
      sessionId: "session-2",
      stateDir: "/tmp/.codex-run/job-2",
      status: "completed",
      lastMessage: "done",
      lastMessageFile: "/tmp/.codex-run/job-2/last-message.txt"
    });
    dependencies.readPromptFile.mockResolvedValue("补 README 的聊天窗触发说明和 MCP 路由测试");

    const result = await routeChatIntentWithPolicies(
      {
        chatIntent: "/codex-autoresearch",
        chatWindowTurns: [
          "我们已经把 README 的 CLI 安装说明改好了。",
          "还差聊天窗触发说明和 MCP 路由测试。",
          "下一步继续补 README 的聊天窗触发说明和 MCP 路由测试。"
        ],
        stateDir: "/tmp/.codex-run"
      },
      dependencies
    );

    expect(result.action).toBe("resume_session");
    expect(result.triggerMode).toBe("slash");
    expect(result.reason).toContain("slash trigger");
  });

  /**
   * 业务职责：验证没有继续信号时会新建任务，保证聊天里说新需求时不会误附着旧状态链。
   */
  it("routes non-continue intent to a new task", async () => {
    const dependencies = createRoutingDependencies();
    dependencies.runTask.mockResolvedValue({
      jobId: "job-3",
      sessionId: "session-3",
      stateDir: "/repo/.codex-run/job-3",
      status: "completed",
      lastMessage: "done",
      lastMessageFile: "/repo/.codex-run/job-3/last-message.txt"
    });

    const result = await routeChatIntentWithPolicies(
      {
        chatIntent: "用 codex-autoresearch 处理我们当前聊天里正在讨论的需求。",
        chatSummary: "实现 README 的安装说明收敛。",
        workdir: "/repo",
        stateDir: "/repo/.codex-run"
      },
      dependencies
    );

    expect(result.action).toBe("run_task");
    expect(result.chatSummary).toContain("README");
  });

  /**
   * 业务职责：验证显式点名仓库 skill 时，会把当前聊天最近几轮转成 skill 配方执行，而不是退回 generic task。
   */
  it("routes explicit skill intent to run_skill", async () => {
    const dependencies = createRoutingDependencies();
    dependencies.loadSkill.mockResolvedValue({
      manifest: {
        name: "research",
        description: "research",
        inputs: {
          topic: { description: "topic", required: true },
          constraints: { description: "constraints", required: false, default: "无额外约束" }
        },
        defaultWorkdir: "/repo",
        defaultModel: "gpt-test",
        outputContract: "deliver"
      },
      promptTemplate: "Topic: {{topic}}\nConstraints: {{constraints}}",
      directory: "/repo/skills/research"
    });
    dependencies.resolveSkillInputs.mockImplementation(async (_definition, provided) => provided);
    dependencies.renderSkillPrompt.mockReturnValue("Topic: README\nConstraints: 只关注聊天窗触发");
    dependencies.runTask.mockResolvedValue({
      jobId: "job-4",
      sessionId: "session-4",
      stateDir: "/repo/.codex-run/job-4",
      status: "completed",
      lastMessage: "done",
      lastMessageFile: "/repo/.codex-run/job-4/last-message.txt"
    });

    const result = await routeChatIntentWithPolicies(
      {
        chatIntent: "用 research skill 处理我们当前聊天刚才讨论的需求。",
        skillName: "research",
        chatWindowTurns: [
          "我们要把 codex-autoresearch 的聊天窗触发方案整理清楚。",
          "只关注 README、插件说明和 MCP 路由，不展开别的架构改动。"
        ],
        chatSummary: "把 codex-autoresearch 的聊天窗触发方案整理清楚。"
      },
      dependencies
    );

    expect(result.action).toBe("run_skill");
    if (result.action !== "run_skill") {
      throw new Error("Expected run_skill route result");
    }
    expect(result.skillName).toBe("research");
    expect(result.triggerMode).toBe("explicit_skill");
    expect(result.resolvedSkillInputs?.topic).toContain("聊天窗触发方案");
  });

  /**
   * 业务职责：验证当前聊天目标与最近任务冲突时会返回确认态，避免静默续跑错误链路。
   */
  it("returns conflict when continue intent diverges from latest task", async () => {
    const dependencies = createRoutingDependencies();
    dependencies.resolveResumeTarget.mockResolvedValue({
      stateDir: "/tmp/.codex-run/job-5",
      initialPromptFile: "/tmp/.codex-run/job-5/initial-prompt.txt"
    });
    dependencies.readPromptFile.mockResolvedValue("修复支付回调重试逻辑并补集成测试");

    const result = await routeChatIntentWithPolicies(
      {
        chatIntent: "用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。",
        chatSummary: "继续重写 README 的安装部分和插件说明。"
      },
      dependencies
    );

    expect(result.action).toBe("conflict");
    expect(result.status).toBe("needs_confirmation");
  });

  /**
   * 业务职责：验证“继续做”但没有最近任务时，只要聊天目标足够具体，也会安全地转成新任务。
   */
  it("starts a new task when continue intent is specific but no latest task exists", async () => {
    const dependencies = createRoutingDependencies();
    dependencies.runTask.mockResolvedValue({
      jobId: "job-6",
      sessionId: "session-6",
      stateDir: "/repo/.codex-run/job-6",
      status: "completed",
      lastMessage: "done",
      lastMessageFile: "/repo/.codex-run/job-6/last-message.txt"
    });

    const result = await routeChatIntentWithPolicies(
      {
        chatIntent: "继续做",
        chatSummary: "继续补 README 的 MCP 示例和技能安装说明。",
        workdir: "/repo"
      },
      dependencies
    );

    expect(result.action).toBe("run_task");
    expect(result.reason).toContain("No resumable current-directory codex-autoresearch task was found");
  });

  /**
   * 业务职责：验证聊天窗口裁剪会强制限制为最近 8 轮，避免更早历史上下文污染当前任务摘要。
   */
  it("keeps only the latest eight chat turns", () => {
    const turns = Array.from({ length: DEFAULT_CHAT_WINDOW_TURNS + 4 }, (_, index) => `turn-${index + 1}`);

    expect(takeRecentChatTurns(turns)).toEqual(turns.slice(-DEFAULT_CHAT_WINDOW_TURNS));
  });
});
