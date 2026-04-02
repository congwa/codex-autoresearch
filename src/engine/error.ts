/**
 * 业务职责：统一错误模块负责把 CLI、执行引擎和 MCP 中出现的业务失败收敛成稳定结构，
 * 方便状态持久化、终端输出和外部 agent 判断错误是否可重试。
 *
 * 为什么这么做：
 * - 长任务失败往往会跨多轮、多入口传播，如果只保留原始 Error 文本，就很难在 CLI、MCP、状态文件里保持一致。
 * - 外部 agent 需要基于稳定错误码决定“直接失败”还是“补参后重试”，不能依赖模糊自然语言。
 *
 * 典型场景：
 * - `WORKDIR_NOT_FOUND`：用户目录写错了，应该直接报错并停止。
 * - `SKILL_INPUT_MISSING`：缺少业务输入，应该提示补参后重试。
 * - `MCP_TOOL_CALL_CANCELLED`：任务内部关键 MCP 调用被宿主环境取消，当前轮不得判完成，但可后续 resume。
 */
export interface JobErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * 业务职责：执行错误对象携带稳定错误码和可重试语义，避免上层只能依赖不稳定的异常文本做判断。
 *
 * 为什么不用普通 Error：
 * - 普通 Error 只有 message，没有稳定 code。
 * - 本项目需要把失败写进 `meta.json`、CLI、MCP 响应里，必须能跨边界保留统一语义。
 */
export class JobError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  /**
   * 业务职责：创建统一错误实例，让业务层在失败时可以同时保留错误码、文案和重试建议。
   *
   * 解决的问题：
   * - 同一个失败要同时服务于人类排障和自动化决策。
   * - `retryable` 能帮助调用方区分“等一下再试”与“先改输入再试”。
   */
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "JobError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * 业务职责：把任意异常标准化成对外稳定的错误结构，便于日志、状态文件和 API 响应复用。
 *
 * 为什么要兜底：
 * - 不是所有异常都会在最底层被包装成 `JobError`。
 * - 对外输出时仍然需要统一结构，避免 CLI/MCP 响应一会儿是字符串、一会儿是对象。
 */
export function toJobErrorInfo(error: unknown, fallbackCode = "UNKNOWN_ERROR"): JobErrorInfo {
  if (error instanceof JobError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    };
  }

  if (error instanceof Error) {
    return {
      code: fallbackCode,
      message: error.message,
      retryable: false
    };
  }

  return {
    code: fallbackCode,
    message: String(error),
    retryable: false
  };
}

/**
 * 业务职责：为 CLI 和 MCP 构造稳定失败响应，让不同入口对失败结果的表达保持一致。
 *
 * 示例：
 * - CLI 可以直接打印这个 payload 并返回非零退出码。
 * - MCP 可以把这个 payload 序列化到 `content[0].text`，供外部 agent 读取。
 */
export function buildFailurePayload(error: JobErrorInfo, stateDir?: string, jobId?: string) {
  return {
    status: "failed" as const,
    stateDir,
    jobId,
    error
  };
}
