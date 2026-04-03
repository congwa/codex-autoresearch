/**
 * 业务职责：完成协议测试负责锁住“结构化完成报告 + 最后两行完成口令”的新收尾格式，
 * 防止引擎未来回退成只接受两行纯口令、再次与规划型任务的完成报告相冲突。
 */
import { describe, expect, it } from "vitest";
import { createCompletionProtocol, isCompletionMessage } from "../src/engine/completion.js";

describe("completion protocol", () => {
  /**
   * 业务职责：验证完成报告可以出现在口令之前，
   * 让规划型任务在逐项目标对账后仍然能被引擎识别为真正完成。
   */
  it("accepts completion protocol when it appears on the final two lines", () => {
    const protocol = createCompletionProtocol("CONFIRMED: all tasks completed", "aaaabbbbcccc");
    const message = [
      "<completion_report>",
      "- [x] Goal One",
      "</completion_report>",
      protocol.doneToken,
      protocol.confirmText
    ].join("\n");

    expect(isCompletionMessage(message, protocol)).toBe(true);
  });
});
