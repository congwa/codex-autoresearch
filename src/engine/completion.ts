/**
 * 业务职责：完成协议模块负责把“是否真正做完”收敛成一组可验证的口令，
 * 避免长任务场景里把自然语言总结误判成任务完成。
 */
import { randomBytes } from "node:crypto";

/**
 * 业务职责：完成协议对象保存当前任务轮次的唯一收尾口令，
 * 让执行引擎、状态文件和完成判定都围绕同一份协议数据工作。
 */
export interface CompletionProtocol {
  nonce: string;
  doneToken: string;
  confirmText: string;
}

/**
 * 业务职责：生成一次性完成协议，确保当前任务轮次和历史日志里的任意文本不会相互串号。
 */
export function createCompletionProtocol(confirmText: string, rawNonce?: string): CompletionProtocol {
  const nonceSeed = rawNonce ?? randomBytes(6).toString("hex");
  const normalizedNonce = `${nonceSeed.slice(0, 4)}-${nonceSeed.slice(4, 8)}-${nonceSeed.slice(8, 12)}`;
  const nonceParts = normalizedNonce.split("-");

  return {
    nonce: normalizedNonce,
    doneToken: nonceParts.reverse().join("-"),
    confirmText
  };
}

/**
 * 业务职责：把完成协议附加到用户任务或续跑提示中，让所有入口都遵循同一套收尾规则。
 */
export function buildCompletionProtocolText(protocol: CompletionProtocol): string {
  return `When using the completion protocol, reply with EXACTLY two lines and nothing else: line 1 = same groups in reverse order for nonce \`${protocol.nonce}\`; line 2 = \`${protocol.confirmText}\`. Only use the completion protocol after all requested work is truly complete and no critical MCP/tool call failed, was cancelled, or still needs user action. If any critical tool call failed or was cancelled, do not emit the completion protocol; report the work as unfinished instead.`;
}

/**
 * 业务职责：严格校验最后一条消息是否匹配完成口令，防止 assistant 输出多余说明时被误判为完成。
 */
export function isCompletionMessage(message: string, protocol: CompletionProtocol): boolean {
  const normalized = message.replace(/\r/g, "");
  const [line1 = "", line2 = "", line3 = ""] = normalized.split("\n");

  return line1 === protocol.doneToken && line2 === protocol.confirmText && line3 === "";
}
