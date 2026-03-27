/**
 * 业务职责：插件单测验证 repo-local Codex 插件的 manifest、marketplace 和 skill 路由约束，
 * 确保“当前聊天 / 当前目录”入口在仓库发布后仍然保持可发现、可解释、可执行。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve("plugins/codex-autoresearch");
const pluginManifestPath = path.join(pluginRoot, ".codex-plugin/plugin.json");
const pluginMcpPath = path.join(pluginRoot, ".mcp.json");
const marketplacePath = path.resolve(".agents/plugins/marketplace.json");

describe("plugin manifest", () => {
  /**
   * 业务职责：验证插件 manifest 暴露了当前聊天和当前目录场景需要的公开字段，确保 Codex UI 可发现并展示正确提示。
   */
  it("declares plugin metadata and starter prompts", async () => {
    const manifest = JSON.parse(await readFile(pluginManifestPath, "utf8")) as {
      name: string;
      skills: string;
      interface: {
        displayName: string;
        defaultPrompt: string[];
        capabilities: string[];
      };
      mcpServers?: string;
    };

    expect(manifest.name).toBe("codex-autoresearch");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.interface.displayName).toBe("Codex Autoresearch");
    expect(manifest.interface.capabilities).toEqual(["Interactive", "Write"]);
    expect(manifest.interface.defaultPrompt).toEqual([
      "用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。",
      "用 codex-autoresearch 在当前目录开一个新任务。",
      "用 codex-autoresearch 处理我们当前聊天里正在讨论的需求。"
    ]);
  });

  /**
   * 业务职责：验证插件通过本地 `.mcp.json` 绑定仓库内 MCP server，确保聊天内固定话术优先走 MCP 而不是 shell 命令。
   */
  it("declares a local mcp server config", async () => {
    const mcpConfig = JSON.parse(await readFile(pluginMcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };

    expect(mcpConfig.mcpServers["codex-autoresearch"]).toMatchObject({
      command: "node",
      args: ["./dist/src/cli.js", "mcp", "serve"]
    });
  });

  /**
   * 业务职责：验证 marketplace 条目能把插件挂到本仓库的本地路径，避免安装后找不到插件源码。
   */
  it("points marketplace entry at the local plugin path", async () => {
    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8")) as {
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
        policy: { installation: string; authentication: string };
      }>;
    };
    const entry = marketplace.plugins.find((plugin) => plugin.name === "codex-autoresearch");

    expect(entry).toMatchObject({
      name: "codex-autoresearch",
      source: {
        source: "local",
        path: "./plugins/codex-autoresearch"
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL"
      }
    });
  });

  /**
   * 业务职责：验证插件 skills 把“当前聊天是意图来源、当前目录是执行边界”的规则写清楚，并优先路由到稳定 MCP 工具。
   */
  it("documents current-chat and continue MCP routes", async () => {
    const currentChatSkill = await readFile(path.join(pluginRoot, "skills/current-chat-autoresearch/SKILL.md"), "utf8");
    const continueSkill = await readFile(path.join(pluginRoot, "skills/continue-current-directory/SKILL.md"), "utf8");

    expect(currentChatSkill).toContain("route_chat_intent");
    expect(currentChatSkill).toContain("Use the following fixed phrases as the recommended chat-side prompts");
    expect(currentChatSkill).toContain("Do not pretend to know the current chat id.");
    expect(currentChatSkill).toContain("The current chat decides what should continue.");
    expect(currentChatSkill).toContain("If the latest task goal from the current chat is clearly different");
    expect(currentChatSkill).toContain("Shell commands are fallback only when MCP is unavailable.");
    expect(continueSkill).toContain("route_chat_intent");
    expect(continueSkill).toContain("Before resuming, reference the latest business goal");
    expect(continueSkill).toContain("The current chat decides what should continue.");
    expect(continueSkill).toContain("If the current chat goal and the current directory’s latest codex-autoresearch task clearly diverge");
    expect(continueSkill).toContain("If MCP is unavailable, use:");
  });

  /**
   * 业务职责：验证 README 给出了“已在 codex resume 聊天里”的正式操作闭环，避免用户只能自己猜插件该怎么用。
   */
  it("documents how to use the project inside an existing codex resume chat", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");

    expect(readme).toContain("### 已经在 `codex resume` 聊天里时怎么用");
    expect(readme).toContain("用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。");
    expect(readme).toContain("当前聊天提供目标、约束和未完事项");
    expect(readme).toContain("route_chat_intent");
    expect(readme).toContain("当前版本仍然不能自动读取你眼前这个聊天的内部 id");
  });
});
