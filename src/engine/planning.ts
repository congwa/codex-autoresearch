/**
 * 业务职责：规划契约模块负责把“可修改的规划文件”拆成“冻结目标”和“可变施工计划”，
 * 让长任务在规划文件被修正后，仍然能围绕启动时确认的目标稳定推进。
 */
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import type { JobMetadata } from "./state.js";

/**
 * 业务职责：目标提取模式记录冻结目标来自显式目标区还是整文件兜底，
 * 方便状态查询和排障时解释当前任务为什么会采用某种契约口径。
 */
export type GoalExtractionMode = "cli_text" | "explicit_section" | "full_file_fallback";

/**
 * 业务职责：单个冻结目标条目为完成对账提供稳定文本锚点，
 * 让模型的完成报告能够按目标逐项交账而不是只给一段泛化总结。
 */
export interface GoalManifestEntry {
  id: string;
  text: string;
  normalizedText: string;
}

/**
 * 业务职责：最近一次完成校验结果统一表达“为什么没完成/为什么完成”，
 * 让 resume 提示词、状态查询和排障输出共享同一份判定上下文。
 */
export interface CompletionCheckResult {
  status: "passed" | "failed" | "skipped";
  gate: string;
  reason: string;
  missingGoals?: string[];
}

/**
 * 业务职责：规划漂移信息用来标记当前规划文件是否已经偏离冻结目标，
 * 以便在用户误删目标段时继续执行且给出可解释警告。
 */
export interface PlanDriftInfo {
  detected: boolean;
  reason: string;
  lastObservedAt: string;
}

/**
 * 业务职责：规划工件快照把当前续跑真正依赖的目标文本、目标清单与最新规划内容打包，
 * 让 prompt 构造和完成校验都围绕同一份最新规划视图工作。
 */
export interface PlanningArtifactsSnapshot {
  goalContract: string;
  workingPlan: string;
  goals: GoalManifestEntry[];
}

/**
 * 业务职责：完成报告结构描述模型收尾时逐项对账的结果，
 * 让执行引擎能把 completion protocol 变成“先交账再结束”的稳定流程。
 */
export interface CompletionReport {
  goals: string[];
}

/**
 * 业务职责：初始化规划工件，在首次启动 prompt-file 任务时冻结原始目标，
 * 避免后续对规划文件的修正把不可变目标一起覆盖掉。
 */
export async function ensurePlanningArtifacts(metadata: JobMetadata, sourcePromptContent?: string, frozenGoalsText?: string): Promise<void> {
  if (metadata.promptSource !== "file" || !metadata.sourcePromptFile) {
    return;
  }

  const initialContent = sourcePromptContent ?? await readSourcePrompt(metadata.sourcePromptFile);
  if (!initialContent) {
    return;
  }

  const existingGoalContract = await readOptionalFile(metadata.goalContractFile);
  if (!existingGoalContract) {
    const extracted = resolveGoalContract(initialContent, frozenGoalsText);
    const goals = extractGoalManifestEntries(extracted.content);
    const now = new Date().toISOString();

    metadata.goalExtractionMode = extracted.mode;
    metadata.goalContractHash = computeContentHash(extracted.content);
    metadata.lastObservedPlanHash = computeContentHash(initialContent);
    metadata.lastPlanDrift = {
      detected: false,
      reason: extracted.mode === "cli_text"
        ? "Working plan was initialized with an explicit frozen goals text provided by CLI."
        : "Working plan still matches the frozen goal contract at initialization.",
      lastObservedAt: now
    };

    await writeFile(metadata.goalContractFile, extracted.content, "utf8");
    await writeFile(metadata.goalManifestFile, `${JSON.stringify(goals, null, 2)}\n`, "utf8");
    await writeFile(metadata.workingPlanFile, initialContent, "utf8");
    await appendPlanRevision(metadata, {
      observedAt: now,
      hash: metadata.lastObservedPlanHash,
      event: "initialized"
    });
  }
}

/**
 * 业务职责：每轮续跑前同步最新规划文件并检测是否发生目标漂移，
 * 让引擎既能看到最新施工计划，又不会把误删目标当成真正目标变更。
 */
export async function refreshPlanningArtifacts(metadata: JobMetadata): Promise<PlanningArtifactsSnapshot | undefined> {
  if (metadata.promptSource !== "file" || !metadata.sourcePromptFile) {
    return undefined;
  }

  await ensurePlanningArtifacts(metadata);

  const [goalContract, goals] = await Promise.all([
    readOptionalFile(metadata.goalContractFile),
    readGoalManifest(metadata.goalManifestFile)
  ]);
  if (!goalContract) {
    return undefined;
  }

  const sourceContent = await readSourcePrompt(metadata.sourcePromptFile);
  if (!sourceContent) {
    const workingPlan = await readOptionalFile(metadata.workingPlanFile) ?? goalContract;
    return { goalContract, workingPlan, goals };
  }

  const now = new Date().toISOString();
  const currentHash = computeContentHash(sourceContent);
  const previousHash = metadata.lastObservedPlanHash;
  if (previousHash !== currentHash) {
    metadata.lastObservedPlanHash = currentHash;
    await appendPlanRevision(metadata, {
      observedAt: now,
      hash: currentHash,
      previousHash,
      event: "updated"
    });
  }

  await writeFile(metadata.workingPlanFile, sourceContent, "utf8");

  const currentGoals = selectBestGoalLines(sourceContent);
  const frozenGoals = goals.map((goal) => goal.normalizedText);
  if (metadata.goalExtractionMode === "cli_text") {
    metadata.lastPlanDrift = {
      detected: false,
      reason: "Frozen goals come from explicit CLI text, so working plan edits do not affect the immutable goal contract.",
      lastObservedAt: now
    };
  } else {
    const missingFrozenGoals = frozenGoals.filter((goal) => !currentGoals.includes(goal));
    metadata.lastPlanDrift = missingFrozenGoals.length === 0
      ? {
          detected: false,
          reason: "Current working plan still retains all frozen goals.",
          lastObservedAt: now
        }
      : {
          detected: true,
          reason: `Current working plan no longer contains ${missingFrozenGoals.length} frozen goal(s); execution still follows the frozen goal contract.`,
          lastObservedAt: now
        };
  }

  return {
    goalContract,
    workingPlan: sourceContent,
    goals
  };
}

/**
 * 业务职责：构造规划型 prompt 的统一附加上下文，把冻结目标、最新规划和收尾规则一起喂给模型，
 * 让模型在文件被修正后依然知道应该围绕哪份目标契约交付。
 */
export function buildPlanningPromptAppendix(snapshot?: PlanningArtifactsSnapshot): string {
  if (!snapshot) {
    return "";
  }

  const goalChecklist = snapshot.goals.length > 0
    ? snapshot.goals.map((goal) => `- [ ] ${goal.text}`).join("\n")
    : "- [ ] 没有提取出结构化目标，请严格围绕冻结目标契约全文执行。";

  return [
    "Immutable Goal Contract（不可变目标契约，优先级最高）:",
    snapshot.goalContract,
    "",
    "Current Working Plan（当前可修正规划，仅代表施工方式，不代表目标变化）:",
    snapshot.workingPlan,
    "",
    "Execution rules:",
    "- 冻结目标契约优先于当前规划文件。",
    "- 即使当前规划文件删掉了某些目标，也不能把它们视为取消。",
    "- 真正完成前，必须先输出 `<completion_report>`，并逐项用完全相同的目标文本回填已完成项。",
    "- `<completion_report>` 的格式必须是 `- [x] 目标文本`，目标文本必须与下方清单完全一致。",
    "",
    "Frozen goal checklist:",
    goalChecklist
  ].join("\n");
}

/**
 * 业务职责：校验模型的完成报告是否覆盖全部冻结目标，
 * 让 completed 建立在逐项目标对账之上而不是只依赖 completion protocol。
 */
export async function validateCompletionReport(metadata: JobMetadata, assistantMessage: string): Promise<CompletionCheckResult> {
  if (metadata.promptSource !== "file" || !metadata.sourcePromptFile) {
    return {
      status: "skipped",
      gate: "planning_contract",
      reason: "Current task is not driven by a prompt file, so planning completion validation was skipped."
    };
  }

  const goals = await readGoalManifest(metadata.goalManifestFile);
  if (goals.length === 0) {
    return {
      status: "skipped",
      gate: "planning_contract",
      reason: "No structured immutable goals were extracted from the frozen goal contract."
    };
  }

  const report = parseCompletionReport(assistantMessage);
  if (!report) {
    return {
      status: "failed",
      gate: "planning_contract",
      reason: "Missing `<completion_report>` block before completion protocol.",
      missingGoals: goals.map((goal) => goal.text)
    };
  }

  const reportedGoals = report.goals.map(normalizeGoalText);
  const missingGoals = goals
    .filter((goal) => !reportedGoals.includes(goal.normalizedText))
    .map((goal) => goal.text);

  if (missingGoals.length > 0) {
    return {
      status: "failed",
      gate: "planning_contract",
      reason: `Completion report does not cover all frozen goals; ${missingGoals.length} goal(s) are still missing.`,
      missingGoals
    };
  }

  return {
    status: "passed",
    gate: "planning_contract",
    reason: "Completion report covers all frozen goals."
  };
}

/**
 * 业务职责：把最近一次完成校验失败压缩成续跑提示，避免模型反复在目标未齐时提前收尾。
 */
export function buildCompletionFailurePrompt(result?: CompletionCheckResult): string {
  if (!result || result.status !== "failed") {
    return "";
  }

  const missingGoals = result.missingGoals?.length
    ? `\n仍缺的冻结目标：\n${result.missingGoals.map((goal) => `- ${goal}`).join("\n")}`
    : "";

  return [
    "注意：上一轮的 completion protocol 没有通过业务验收，本任务仍未完成。",
    `原因：${result.reason}`,
    `${missingGoals}`,
    "请先补齐缺失目标，再输出 `<completion_report>` 和 completion protocol。"
  ].join("\n").trim();
}

/**
 * 业务职责：从 assistant 最终输出中解析结构化完成报告，
 * 让执行引擎能够稳定区分“口令收尾”和“逐项目标对账”。
 */
export function parseCompletionReport(message: string): CompletionReport | undefined {
  const matched = message.match(/<completion_report>\s*([\s\S]*?)\s*<\/completion_report>/u);
  if (!matched) {
    return undefined;
  }

  const goals = matched[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s*\[x\]\s+/iu.test(line))
    .map((line) => normalizeGoalText(line.replace(/^-\s*\[x\]\s+/iu, "")));

  return goals.length > 0 ? { goals } : undefined;
}

/**
 * 业务职责：从原始规划文件中提取不可变目标契约，
 * 优先尊重显式目标区，找不到时再退回整文件冻结。
 */
export function extractGoalContract(content: string): { content: string; mode: GoalExtractionMode } {
  const explicitByMarker = extractBetweenMarkers(content);
  if (explicitByMarker) {
    return {
      content: explicitByMarker,
      mode: "explicit_section"
    };
  }

  const explicitByHeading = extractGoalSectionByHeading(content);
  if (explicitByHeading) {
    return {
      content: explicitByHeading,
      mode: "explicit_section"
    };
  }

  return {
    content,
    mode: "full_file_fallback"
  };
}

/**
 * 业务职责：按“显式 CLI 冻结目标优先，其次自动提取”的顺序解析最终目标契约，
 * 让用户在自动提取不稳定时可以直接传入不可变目标文本作为最高优先级来源。
 */
export function resolveGoalContract(content: string, frozenGoalsText?: string): { content: string; mode: GoalExtractionMode } {
  if (frozenGoalsText?.trim()) {
    return {
      content: frozenGoalsText.trim(),
      mode: "cli_text"
    };
  }

  return extractGoalContract(content);
}

/**
 * 业务职责：把冻结目标契约提取成结构化清单，供完成报告做逐项精确比对。
 */
export function extractGoalManifestEntries(goalContract: string): GoalManifestEntry[] {
  const goalLines = selectBestGoalLines(goalContract);
  return goalLines.map((goal, index) => ({
    id: `goal_${String(index + 1).padStart(3, "0")}`,
    text: goal,
    normalizedText: normalizeGoalText(goal)
  }));
}

/**
 * 业务职责：稳定规范化目标文本，降低空格、序号和大小写差异对完成对账的干扰。
 */
export function normalizeGoalText(text: string): string {
  return text
    .replace(/^[-*]\s+/u, "")
    .replace(/^\d+\.\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * 业务职责：优先从显式目标区抽取目标行，没有时再退回 checklist / 普通列表，
 * 让同一套规划引擎能兼容从规范化文档到普通 Markdown 草稿的多种写法。
 */
function selectBestGoalLines(content: string): string[] {
  const explicit = extractGoalSectionByHeading(content) ?? extractBetweenMarkers(content) ?? content;
  const checklistLines = extractListLines(explicit, /^-\s*\[[ xX]\]\s+/u);
  if (checklistLines.length > 0) {
    return dedupeNormalizedLines(checklistLines);
  }

  const bulletLines = extractListLines(explicit, /^[-*]\s+/u);
  if (bulletLines.length > 0) {
    return dedupeNormalizedLines(bulletLines);
  }

  const orderedLines = extractListLines(explicit, /^\d+\.\s+/u);
  if (orderedLines.length > 0) {
    return dedupeNormalizedLines(orderedLines);
  }

  return [];
}

/**
 * 业务职责：从标记区提取显式目标文本，方便用户在任意规划文档里稳定声明不可变目标。
 */
function extractBetweenMarkers(content: string): string | undefined {
  const matched = content.match(/<!--\s*codex-autoresearch:goals:start\s*-->\s*([\s\S]*?)\s*<!--\s*codex-autoresearch:goals:end\s*-->/u);
  return matched?.[1]?.trim() || undefined;
}

/**
 * 业务职责：从常见“目标/Goals/验收标准”标题下提取目标区，
 * 让用户不必额外引入特殊标记也能稳定声明不可变目标。
 */
function extractGoalSectionByHeading(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const headingPattern = /^##+\s*(goals?|目标|不可变目标|最终目标|完成标准|验收标准|deliverables?)\s*$/iu;
  let startIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (headingPattern.test(lines[index]?.trim() ?? "")) {
      startIndex = index + 1;
      break;
    }
  }

  if (startIndex === -1) {
    return undefined;
  }

  const sectionLines: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^##+\s+/u.test(line.trim())) {
      break;
    }
    sectionLines.push(line);
  }

  const section = sectionLines.join("\n").trim();
  return section || undefined;
}

/**
 * 业务职责：按指定列表模式抽取 Markdown 目标行，
 * 让冻结目标和完成报告都能基于简单稳定的文本列表做校验。
 */
function extractListLines(content: string, linePattern: RegExp): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => linePattern.test(line))
    .map((line) => line.replace(linePattern, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * 业务职责：对提取出的目标行做去重，避免同一条目标在清单和规划正文里重复出现导致对账噪音。
 */
function dedupeNormalizedLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const normalized = normalizeGoalText(line);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(line);
  }

  return result;
}

/**
 * 业务职责：从磁盘读取原始规划文件，保证初始化冻结目标和后续最新规划快照都围绕真实源文件工作。
 */
async function readSourcePrompt(sourcePromptFile: string): Promise<string | undefined> {
  try {
    return await readFile(sourcePromptFile, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * 业务职责：安全读取可选文本文件，避免旧任务或半初始化状态下缺文件导致整轮续跑直接失败。
 */
async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * 业务职责：读取冻结目标清单，为完成校验和 prompt 构造提供稳定的结构化目标视图。
 */
async function readGoalManifest(goalManifestFile: string): Promise<GoalManifestEntry[]> {
  try {
    const raw = await readFile(goalManifestFile, "utf8");
    const parsed = JSON.parse(raw) as GoalManifestEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 业务职责：为规划文件每次观测到的版本变化追加一条修订记录，
 * 方便定位“是规划被修正了，还是目标曾经被误删过”。
 */
async function appendPlanRevision(
  metadata: JobMetadata,
  revision: { observedAt: string; hash: string; previousHash?: string; event: "initialized" | "updated" }
): Promise<void> {
  await appendFile(metadata.planRevisionsFile, `${JSON.stringify(revision)}\n`, "utf8");
}

/**
 * 业务职责：把文本内容稳定映射成哈希值，支持工作计划版本对比和漂移检测。
 */
function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
