/**
 * 业务职责：聊天路由单测验证 continue/new/conflict 等策略规则被独立模块稳定承接，
 * 避免这些业务判断重新回流到 MCP server 或插件层里。
 */
import { describe, expect, it, vi } from "vitest";
import { routeChatIntentWithPolicies } from "../../src/routing/chat-intent.js";

describe("chat intent routing", () => {
  /**
   * 业务职责：验证明显的“继续做”意图会优先接到当前目录最近任务，而不是误新建任务。
   */
  it("routes continue intent to resume when latest task matches", async () => {
    const result = await routeChatIntentWithPolicies(
      {
        chatIntent: "用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。",
        chatSummary: "继续完善 README 和 MCP 测试",
        stateDir: "/tmp/.codex-run"
      },
      {
        resolveResumeTarget: vi.fn().mockResolvedValue({
          stateDir: "/tmp/.codex-run/job-1",
          initialPromptFile: "/tmp/.codex-run/job-1/initial-prompt.txt"
        }),
        resumeSession: vi.fn().mockResolvedValue({
          jobId: "job-1",
          sessionId: "session-1",
          stateDir: "/tmp/.codex-run/job-1",
          status: "completed",
          lastMessage: "done",
          lastMessageFile: "/tmp/.codex-run/job-1/last-message.txt"
        }),
        runTask: vi.fn(),
        readPromptFile: vi.fn().mockResolvedValue("继续完善 README 和 MCP 测试")
      }
    );

    expect(result.action).toBe("resume_session");
    expect(result.reason).toContain("unfinished work");
  });

  /**
   * 业务职责：验证没有继续信号时会新建任务，保证聊天里说新需求时不会误附着旧状态链。
   */
  it("routes non-continue intent to a new task", async () => {
    const result = await routeChatIntentWithPolicies(
      {
        chatIntent: "用 codex-autoresearch 处理我们当前聊天里正在讨论的需求。",
        chatSummary: "实现 README 的安装说明收敛。",
        workdir: "/repo",
        stateDir: "/repo/.codex-run"
      },
      {
        resolveResumeTarget: vi.fn().mockResolvedValue(undefined),
        resumeSession: vi.fn(),
        runTask: vi.fn().mockResolvedValue({
          jobId: "job-2",
          sessionId: "session-2",
          stateDir: "/repo/.codex-run/job-2",
          status: "completed",
          lastMessage: "done",
          lastMessageFile: "/repo/.codex-run/job-2/last-message.txt"
        }),
        readPromptFile: vi.fn()
      }
    );

    expect(result.action).toBe("run_task");
    expect(result.chatSummary).toContain("README");
  });

  /**
   * 业务职责：验证当前聊天目标与最近任务冲突时会返回确认态，避免静默续跑错误链路。
   */
  it("returns conflict when continue intent diverges from latest task", async () => {
    const result = await routeChatIntentWithPolicies(
      {
        chatIntent: "用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。",
        chatSummary: "继续重写 README 的安装部分和插件说明。"
      },
      {
        resolveResumeTarget: vi.fn().mockResolvedValue({
          stateDir: "/tmp/.codex-run/job-3",
          initialPromptFile: "/tmp/.codex-run/job-3/initial-prompt.txt"
        }),
        resumeSession: vi.fn(),
        runTask: vi.fn(),
        readPromptFile: vi.fn().mockResolvedValue("修复支付回调重试逻辑并补集成测试")
      }
    );

    expect(result.action).toBe("conflict");
    expect(result.status).toBe("needs_confirmation");
  });

  /**
   * 业务职责：验证“继续做”但没有最近任务时，只要聊天目标足够具体，也会安全地转成新任务。
   */
  it("starts a new task when continue intent is specific but no latest task exists", async () => {
    const result = await routeChatIntentWithPolicies(
      {
        chatIntent: "继续做",
        chatSummary: "继续补 README 的 MCP 示例和技能安装说明。",
        workdir: "/repo"
      },
      {
        resolveResumeTarget: vi.fn().mockResolvedValue(undefined),
        resumeSession: vi.fn(),
        runTask: vi.fn().mockResolvedValue({
          jobId: "job-4",
          sessionId: "session-4",
          stateDir: "/repo/.codex-run/job-4",
          status: "completed",
          lastMessage: "done",
          lastMessageFile: "/repo/.codex-run/job-4/last-message.txt"
        }),
        readPromptFile: vi.fn()
      }
    );

    expect(result.action).toBe("run_task");
    expect(result.reason).toContain("No resumable current-directory codex-autoresearch task was found");
  });
});
