/**
 * 业务职责：JSON presenter 统一负责把业务结果转换成 CLI 和 MCP 需要的稳定文本输出，
 * 避免每个 transport 再各自手写 JSON.stringify、失败判断和错误包装。
 *
 * 为什么要单独做 presenter：
 * - 业务层应该只返回“结果是什么”，不关心“CLI 是 stdout 还是 stderr、MCP 是 text content”。
 * - 这样以后新增 HTTP API 或 TUI，只要再加一个 presenter，而不是回头改业务用例。
 */
import { buildFailurePayload, toJobErrorInfo } from "../engine/error.js";

/**
 * 业务职责：文本内容响应类型描述 MCP 当前最常用的 JSON 文本输出形态，
 * 让 handler、presenter 和测试围绕同一份响应契约协作。
 *
 * 示例：
 * - MCP 工具返回 `{ content: [{ type: "text", text: "{...json...}" }] }`
 */
export type TextContentResponse = Record<string, unknown> & {
  content: [{ type: "text"; text: string }];
};

/**
 * 业务职责：把任意业务结果序列化成稳定 JSON 文本，供 CLI 打印和测试断言复用同一格式。
 *
 * 解决的问题：
 * - 如果每个入口各自 `JSON.stringify`，缩进、字段顺序和异常处理很容易漂移。
 */
export function serializeJsonPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * 业务职责：判断一个业务结果是否属于明确失败态，供 CLI 决定退出码和 stderr/stdout 落点。
 *
 * 为什么不直接靠异常：
 * - 很多失败会被下沉成稳定业务结果对象，例如无效 workdir、找不到 session。
 * - CLI 需要根据结果对象而不是调用方式判断是否返回非零退出码。
 */
export function isFailedPayload(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "status" in payload && (payload as { status?: string }).status === "failed");
}

/**
 * 业务职责：把业务结果包装成 MCP 约定的 text content 响应，保证所有工具输出结构一致。
 *
 * 示例：
 * - `run_task`、`run_skill`、`start_task_from_prompt_file` 最终都走这里，避免某个 tool 单独返回不同形状。
 */
export function presentMcpJson(payload: unknown): TextContentResponse {
  return {
    content: [
      {
        type: "text",
        text: serializeJsonPayload(payload)
      }
    ]
  };
}

/**
 * 业务职责：把异常统一转换为稳定失败 JSON，方便 CLI 与 MCP 在 transport 层共享相同错误表达。
 *
 * 解决的问题：
 * - 同一个异常如果分别在 CLI 和 MCP 各自处理，很容易出现一边有 `code`、一边只有 message。
 */
export function presentFailurePayload(error: unknown, fallbackCode = "UNKNOWN_ERROR") {
  return buildFailurePayload(toJobErrorInfo(error, fallbackCode));
}
