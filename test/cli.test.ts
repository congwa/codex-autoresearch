/**
 * 业务职责：CLI 参数测试负责锁住 `--frozen-goals-text` 的入口语义，
 * 防止后续改动让显式冻结目标参数在没有 prompt-file 的场景下被误接受，
 * 以及保证版本号命令始终对齐 package.json。
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createProgram, getCliVersion } from "../src/cli.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

describe("cli frozen goals option", () => {
  /**
   * 业务职责：验证显式冻结目标参数必须和 prompt-file 同时使用，
   * 避免用户把它误当成普通 direct task 的参数导致语义混乱。
   */
  it("rejects frozen goals text without prompt-file", async () => {
    const program = createProgram();

    await expect(program.parseAsync(["node", "codex-autoresearch", "--frozen-goals-text", "immutable"], { from: "node" })).rejects.toThrow(
      "--frozen-goals-text 只能和 --prompt-file 一起使用。"
    );
  });

  /**
   * 业务职责：验证 CLI 对外暴露的版本号和 package 元数据一致，
   * 避免发布后 `--version` 与实际安装版本出现漂移。
   */
  it("uses package.json version as the CLI version", () => {
    expect(getCliVersion()).toBe(packageJson.version);
  });
});
