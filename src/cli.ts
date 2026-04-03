#!/usr/bin/env node
/**
 * 业务职责：CLI 主入口把 direct task、prompt file、session 恢复统一收口，
 * 让本仓库从单一 Bash 守护脚本升级为正式的 Node 命令行工具。
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { once } from "node:events";
import { normalizeCliExecutionContext } from "./application/context.js";
import { getTaskStatus, resumeExistingTask, runDirectTask, runTaskFromPromptFile } from "./application/use-cases.js";
import { ask } from "./engine/interactive.js";
import { isFailedPayload, presentFailurePayload, serializeJsonPayload } from "./presenters/json.js";
import { createStreamingPresenter, type StreamCallbacks } from "./presenters/streaming.js";

/**
 * 业务职责：创建 CLI 命令结构，固定对外公开的 `run`、`session` 两组接口。
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("codex-autoresearch")
    .description("Unified Codex long-task runner with CLI.")
    .argument("[task]", "直接执行的任务文本");
  program.option("--prompt-file <path>", "从 Markdown 文件读取任务");
  program.option("--state-dir <path>", "状态根目录，默认落到 workdir/.codex-run");
  program.option("--workdir <path>", "Codex 实际执行目录", process.cwd());
  program.option("--model <model>", "透传给 codex exec -m");
  program.option("--profile <profile>", "透传给 codex exec --profile");
  program.option("--interactive", "启用交互补参");
  program.option("--interval <seconds>", "未完成时的重试间隔秒数", parsePositiveInt, 3);
  program.option("--skip-git-repo-check", "跳过 git 仓库校验");
  program.option("--dangerously-bypass", "启用危险绕过模式");
  program.option("--no-full-auto", "关闭默认 --full-auto");
  program.option("--no-stream", "关闭实时流式输出（默认 stderr 为 TTY 时启用）");

  // 业务职责：`run` 子命令服务于"我已经有一句明确任务文本或一个 prompt 文件"的主路径。
  const run = program.command("run").description("直接执行一条任务文本或 prompt 文件");
  run.argument("[task]");
  run.option("--prompt-file <path>", "从 Markdown 文件读取任务");
  run.action(async (task, localOptions) => {
    const rootOptions = normalizeCliExecutionContext(program.opts());
    const promptFile = localOptions.promptFile ?? program.opts().promptFile;

    if (promptFile) {
      const result = await runTaskFromPromptFile({
        ...rootOptions,
        promptFile,
        onStream: maybeStreamCallbacks(program.opts())
      });
      printResult(result);
      return;
    }

    const resolvedTask = task ?? (rootOptions.interactive ? await ask("请输入任务") : "");

    if (!resolvedTask) {
      throw new InvalidArgumentError("run 命令需要任务文本或 --prompt-file，或使用交互模式输入。");
    }

    const result = await runDirectTask({
      ...rootOptions,
      task: resolvedTask,
      onStream: maybeStreamCallbacks(program.opts())
    });

    printResult(result);
  });

  // 业务职责：`session` 命令组服务于"继续旧任务或查看当前状态"的长任务恢复场景。
  const session = program.command("session").description("恢复或查看已有任务");
  session.command("resume").argument("[sessionId]").option("--last", "恢复最近一次任务").description("按 session id 或最近状态继续运行").action(async (sessionId, options, command) => {
    const rootOptions = normalizeCliExecutionContext(program.opts());
    if (!sessionId && !options.last) {
      throw new InvalidArgumentError("session resume 需要 <session-id> 或 --last。");
    }

    const result = await resumeExistingTask({
      sessionId,
      useLast: options.last,
      stateDir: rootOptions.stateDir,
      intervalSeconds: rootOptions.intervalSeconds
    });
    printResult(result);
  });

  session.command("status").argument("[sessionId]").option("--last", "读取最近一次任务状态").description("查看已有任务当前状态").action(async (sessionId, options, command) => {
    const rootOptions = normalizeCliExecutionContext(program.opts());
    const result = await getTaskStatus({
      sessionId,
      useLast: options.last || !sessionId,
      stateDir: rootOptions.stateDir
    });
    printResult(result);
  });

  // 业务职责：`app` 命令为"当前目录已经对了，只差打开 Desktop"提供快捷入口。
  program.command("app").description("在 Codex Desktop 中打开当前目录").action(async (_, command) => {
    const rootOptions = normalizeCliExecutionContext(program.opts());
    await openCurrentDirectoryInDesktop(rootOptions.workdir, process.env.CODEX_BIN);
  });

  // 业务职责：`legacy` 命令继续承接旧版 prompt.md + shell 的文件驱动入口，内部转调 prompt file 正式能力。
  program.command("legacy").argument("<promptFile>").description("shell 形式的文件驱动入口（codex-keep-running.sh 薄包装）").action(async (promptFile) => {
    const task = promptFile === "-" ? await readStdin() : await readFile(path.resolve(promptFile), "utf8");
    const stateDir = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : undefined;
    const shouldResume = process.env.START_WITH_RESUME_IF_POSSIBLE !== "0";
    const result = shouldResume && stateDir
      ? await resumeExistingTask({
          useLast: true,
          stateDir,
          codexBin: process.env.CODEX_BIN,
          intervalSeconds: parseEnvInt(process.env.INTERVAL, 3)
        }).then((resumeResult) =>
          resumeResult.status === "failed" && resumeResult.error?.code === "SESSION_NOT_FOUND" ? runLegacyTask(task, stateDir) : resumeResult
        )
      : await runLegacyTask(task, stateDir);
    printResult(result);
  });

  // 业务职责：顶层 action 承接"无子命令直接输入任务"与"无参数交互分流"的傻瓜式主入口。
  program.action(async (task) => {
    const rootOptions = normalizeCliExecutionContext(program.opts());
    const promptFile = program.opts().promptFile;

    if (promptFile) {
      const result = await runTaskFromPromptFile({
        ...rootOptions,
        promptFile,
        onStream: maybeStreamCallbacks(program.opts())
      });
      printResult(result);
      return;
    }

    if (task) {
      const result = await runDirectTask({
        ...rootOptions,
        task,
        onStream: maybeStreamCallbacks(program.opts())
      });
      printResult(result);
      return;
    }

    if (!process.stdin.isTTY) {
      const pipedTask = await readStdin();
      if (pipedTask.trim()) {
        const result = await runDirectTask({
          ...rootOptions,
          task: pipedTask,
          onStream: maybeStreamCallbacks(program.opts())
        });
        printResult(result);
        return;
      }

      console.error("No task provided. Pass a task text, --prompt-file, pipe stdin, or use --interactive.");
      program.help({ error: true });
      return;
    }

    const choice = await ask("请选择入口：run / resume / app", "run");
    if (choice === "resume") {
      await program.parseAsync(["session", "resume", "--last"], { from: "user" });
      return;
    }

    if (choice === "app") {
      await program.parseAsync(["app"], { from: "user" });
      return;
    }

    const promptedTask = await ask("请输入任务");
    await program.parseAsync(["run", promptedTask], { from: "user" });
  });

  return program;
}

export function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  return value ? parsePositiveInt(value) : fallback;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function openCurrentDirectoryInDesktop(workdir: string, codexBin?: string): Promise<void> {
  const targetDir = path.resolve(workdir);
  const child = spawn(codexBin ?? "codex", ["app", targetDir], {
    stdio: "inherit",
    env: process.env
  });

  const [exitCode] = (await once(child, "close")) as [number | null];
  if ((exitCode ?? 1) !== 0) {
    throw new Error(`Failed to open Codex Desktop for directory: ${targetDir}`);
  }
}

export async function main(argv = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    console.error(serializeJsonPayload(presentFailurePayload(error, "CLI_ERROR")));
    process.exitCode = 1;
  }
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  try {
    const invokedEntry = pathToFileURL(realpathSync(process.argv[1])).href;
    const moduleEntry = pathToFileURL(realpathSync(new URL(import.meta.url))).href;
    return invokedEntry === moduleEntry;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectExecution()) {
  void main();
}

async function runLegacyTask(task: string, stateDir?: string) {
  return runDirectTask({
    task,
    workdir: process.env.WORKDIR,
    stateDir,
    model: process.env.MODEL,
    profile: process.env.PROFILE,
    intervalSeconds: parseEnvInt(process.env.INTERVAL, 3),
    fullAuto: process.env.USE_FULL_AUTO !== "0",
    dangerouslyBypass: process.env.DANGEROUSLY_BYPASS === "1",
    skipGitRepoCheck: process.env.SKIP_GIT_REPO_CHECK === "1",
    startWithResumeIfPossible: process.env.START_WITH_RESUME_IF_POSSIBLE !== "0",
    confirmText: process.env.CONFIRM_TEXT,
    onStream: maybeStreamCallbacks({ stream: true })
  });
}

function printResult(result: unknown): void {
  const serialized = serializeJsonPayload(result);
  if (isFailedPayload(result)) {
    console.error(serialized);
    process.exitCode = 1;
    return;
  }

  console.log(serialized);
}

function maybeStreamCallbacks(opts: { stream?: boolean }): StreamCallbacks | undefined {
  const enabled = opts.stream !== false && process.stderr.isTTY;
  return enabled ? createStreamingPresenter(process.stderr) : undefined;
}
