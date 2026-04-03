/**
 * 业务职责：规划契约测试覆盖“冻结目标不被后续修正规划冲掉”和“完成报告必须逐项目标对账”两类核心场景，
 * 防止长任务再次出现规划文件被修没目标后提前 completed 的回归。
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePlanningArtifacts,
  parseCompletionReport,
  refreshPlanningArtifacts,
  resolveGoalContract,
  validateCompletionReport
} from "../src/engine/planning.js";
import type { JobMetadata } from "../src/engine/state.js";

const tempDirs: string[] = [];

/**
 * 业务职责：统一创建测试任务目录，保证每个测试都在独立状态目录中验证规划工件行为。
 */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-autoresearch-planning-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 业务职责：构造最小可用的任务元信息，复用真实状态文件布局来测试规划冻结与完成校验逻辑。
 */
function createMetadata(baseDir: string, sourcePromptFile: string): JobMetadata {
  return {
    jobId: "job-test",
    stateDir: baseDir,
    stateRoot: path.dirname(baseDir),
    workdir: baseDir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    attemptCount: 1,
    confirmText: "CONFIRMED: all tasks completed",
    nonce: "aaaa-bbbb-cccc",
    doneToken: "cccc-bbbb-aaaa",
    fullAuto: true,
    dangerouslyBypass: false,
    skipGitRepoCheck: false,
    startWithResumeIfPossible: true,
    promptSource: "file",
    sourcePromptFile,
    lastMessageFile: path.join(baseDir, "last-message.txt"),
    eventLogFile: path.join(baseDir, "events.jsonl"),
    runnerLogFile: path.join(baseDir, "runner.log"),
    sessionIdFile: path.join(baseDir, "session-id.txt"),
    goalContractFile: path.join(baseDir, "goal-contract.md"),
    goalManifestFile: path.join(baseDir, "goal-manifest.json"),
    workingPlanFile: path.join(baseDir, "working-plan.latest.md"),
    planRevisionsFile: path.join(baseDir, "plan-revisions.jsonl"),
    metaFile: path.join(baseDir, "meta.json")
  };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
  }
});

describe("planning contract", () => {
  /**
   * 业务职责：验证首轮冻结后的目标契约不会因为后续修改源规划文件而丢失，
   * 这是解决“末尾目标被修没后任务异常完成”的关键保护。
   */
  it("freezes goals at task start and detects plan drift after prompt edits", async () => {
    const baseDir = await createTempDir();
    await mkdir(baseDir, { recursive: true });
    const promptFile = path.join(baseDir, "plan.md");
    await writeFile(
      promptFile,
      [
        "# 计划",
        "",
        "## 目标",
        "- 完成 API 文档",
        "- 完成 CLI 示例",
        "",
        "## 说明",
        "- 可以调整写作顺序"
      ].join("\n"),
      "utf8"
    );

    const metadata = createMetadata(baseDir, promptFile);
    await ensurePlanningArtifacts(metadata);

    await writeFile(
      promptFile,
      [
        "# 计划",
        "",
        "## 说明",
        "- 目标段被误删了",
        "- 这里只剩施工说明"
      ].join("\n"),
      "utf8"
    );

    const snapshot = await refreshPlanningArtifacts(metadata);
    const frozenGoalContract = await readFile(metadata.goalContractFile, "utf8");

    expect(snapshot?.goals.map((goal) => goal.text)).toEqual(["完成 API 文档", "完成 CLI 示例"]);
    expect(frozenGoalContract).toContain("完成 API 文档");
    expect(frozenGoalContract).toContain("完成 CLI 示例");
    expect(metadata.lastPlanDrift?.detected).toBe(true);
  });

  /**
   * 业务职责：验证完成报告必须逐项覆盖冻结目标，
   * 防止模型只输出 completion protocol 或漏报目标时被误判为 completed。
   */
  it("requires completion report to cover every frozen goal", async () => {
    const baseDir = await createTempDir();
    await mkdir(baseDir, { recursive: true });
    const promptFile = path.join(baseDir, "plan.md");
    await writeFile(
      promptFile,
      [
        "# 执行计划",
        "",
        "## Goals",
        "- Ship backend API",
        "- Publish docs"
      ].join("\n"),
      "utf8"
    );

    const metadata = createMetadata(baseDir, promptFile);
    await ensurePlanningArtifacts(metadata);

    const failed = await validateCompletionReport(
      metadata,
      [
        "<completion_report>",
        "- [x] Ship backend API",
        "</completion_report>",
        "cccc-bbbb-aaaa",
        "CONFIRMED: all tasks completed"
      ].join("\n")
    );
    const passed = await validateCompletionReport(
      metadata,
      [
        "<completion_report>",
        "- [x] Ship backend API",
        "- [x] Publish docs",
        "</completion_report>",
        "cccc-bbbb-aaaa",
        "CONFIRMED: all tasks completed"
      ].join("\n")
    );

    expect(failed.status).toBe("failed");
    expect(failed.missingGoals).toEqual(["Publish docs"]);
    expect(passed.status).toBe("passed");
  });

  /**
   * 业务职责：验证完成报告解析只接受约定的勾选行格式，
   * 确保引擎面对自然语言总结时不会误把泛化文本当成结构化对账结果。
   */
  it("parses only checked goal lines from completion report", () => {
    const report = parseCompletionReport(
      [
        "<completion_report>",
        "- [x] Goal One",
        "- [ ] Goal Two",
        "- 普通说明",
        "</completion_report>"
      ].join("\n")
    );

    expect(report?.goals).toEqual(["goal one"]);
  });

  /**
   * 业务职责：验证显式 CLI 冻结目标文本会覆盖自动提取，
   * 确保用户在规划文件不稳定时可以直接指定不可变目标来源。
   */
  it("prefers explicit CLI frozen goals text over automatic extraction", async () => {
    const baseDir = await createTempDir();
    await mkdir(baseDir, { recursive: true });
    const promptFile = path.join(baseDir, "plan.md");
    await writeFile(
      promptFile,
      [
        "# 计划",
        "",
        "## 目标",
        "- 自动提取目标 A",
        "- 自动提取目标 B"
      ].join("\n"),
      "utf8"
    );

    const metadata = createMetadata(baseDir, promptFile);
    await ensurePlanningArtifacts(metadata, undefined, "- 显式冻结目标 1\n- 显式冻结目标 2");
    const frozenGoalContract = await readFile(metadata.goalContractFile, "utf8");

    expect(metadata.goalExtractionMode).toBe("cli_text");
    expect(frozenGoalContract).toContain("显式冻结目标 1");
    expect(frozenGoalContract).not.toContain("自动提取目标 A");
  });

  /**
   * 业务职责：验证解析目标契约时显式 CLI 文本优先级最高，
   * 让 planning 模块的来源选择规则在纯函数层也有稳定保护。
   */
  it("resolves goal contract from CLI text before falling back to prompt extraction", () => {
    const resolved = resolveGoalContract("## 目标\n- 自动目标", "- 显式目标");

    expect(resolved.mode).toBe("cli_text");
    expect(resolved.content).toBe("- 显式目标");
  });
});
