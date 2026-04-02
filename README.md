# codex-autoresearch

它的目标很直接：当你希望 Codex 在无人值守时持续推进同一项任务，这个脚本会先发起一次 `codex exec`，之后不断对同一会话执行 `codex exec resume`，直到收到严格的完成协议为止，而不是仅凭一句“我做完了”就停下。

核心架构：

1. **CLI** 直接执行任务或从 prompt 文件启动
2. **MCP server** 作为对外执行服务
3. **Skills** 作为可复用任务配方
4. **codex-keep-running.sh** 作为 shell 形式的文件驱动入口

任务定义只认 prompt 文件或显式文本参数。不支持根据当前聊天自动总结任务、不支持"最近 N 轮"触发、不支持 slash/chat 路由。对于 MCP 自动化，推荐先生成 prompt.md 再调用。

## 安装

```bash
npm install
npm run build
```

全局安装：

```bash
npm install -g .
codex-autoresearch --help
```

## 最推荐路径：prompt.md + CLI

站在目标项目目录里，准备好一个 prompt.md 文件，然后：

```bash
codex-autoresearch --prompt-file ./prompt.md
# 或
codex-autoresearch run --prompt-file ./prompt.md
```

也可以直接传任务文本：

```bash
codex-autoresearch "请检查当前仓库 TODO，补齐缺失测试并更新 README"
```

## MCP 路径

启动 MCP server：

```bash
codex-autoresearch mcp serve
```

### MCP 工具集

| 工具 | 说明 |
| --- | --- |
| `start_task_from_prompt_file` | 从 prompt 文件启动新任务，文件内容作为唯一初始 prompt |
| `run_task` | 运行一个直接任务 |
| `run_skill` | 运行仓库内 skill 配方 |
| `resume_session` | 续跑已有 session 或最近一次任务 |
| `get_session_status` | 读取已有任务状态 |
| `tail_session` | 读取已有任务最近的执行步骤与日志尾部 |
| `list_skills` | 列出仓库内可用 skills |

推荐主路径示例：

```json
{
  "tool": "start_task_from_prompt_file",
  "arguments": {
    "promptFile": "./prompt.md"
  }
}
```

每个执行类 tool 都会返回 `jobId`、`sessionId`、`stateDir`、`status`、`lastMessageFile`。

## .codex-run 状态模型

统一执行引擎会把状态写到：

```text
.codex-run/<job-id>/
```

典型文件：

| 文件 | 作用 |
| --- | --- |
| `meta.json` | 任务元信息、状态、配置、prompt 来源 |
| `events.jsonl` | Codex JSON 事件流 |
| `runner.log` | 执行日志和错误输出 |
| `last-message.txt` | 最近一轮 assistant 最终输出 |
| `session-id.txt` | 从事件流提取的 session id |
| `initial-prompt.txt` | 首轮真正下发给 Codex 的任务（prompt 文件快照） |
| `resume-prompt.txt` | 后续 resume 使用的续跑提示 |

`meta.json` 中记录的 prompt 来源字段：

| 字段 | 说明 |
| --- | --- |
| `promptSource` | `"file"` / `"text"` / `"skill"` |
| `sourcePromptFile` | 原始 prompt 文件绝对路径（仅 `promptSource: "file"` 时有值） |

任务启动时，源文件内容会快照到 `initial-prompt.txt`。后续 resume 只依赖 `.codex-run`，不回读原文件。

## 恢复、查看状态、tail

```bash
# 恢复最近一次任务
codex-autoresearch session resume --last

# 查看最近任务状态
codex-autoresearch session status --last

# 按 session id 继续
codex-autoresearch session resume <session-id>
```

MCP 侧使用 `resume_session`、`get_session_status`、`tail_session`。

## Skills

仓库自带的任务配方，遵循：

```text
skills/<name>/skill.yaml
skills/<name>/prompt.md
```

列出可用 skills：

```bash
codex-autoresearch skill list
```

运行 skill：

```bash
codex-autoresearch skill run research --set topic=...
```

## Shell 薄包装 codex-keep-running.sh

```bash
./codex-keep-running.sh ./prompt.md
cat ./prompt.md | ./codex-keep-running.sh -
```

环境变量：

| 变量 | 作用 |
| --- | --- |
| `WORKDIR` | 实际执行目录 |
| `STATE_DIR` | 状态根目录 |
| `INTERVAL` | 重试间隔 |
| `MODEL` | 模型 |
| `PROFILE` | profile |
| `USE_FULL_AUTO` | 是否开启 `--full-auto` |
| `DANGEROUSLY_BYPASS` | 是否启用危险绕过模式 |
| `SKIP_GIT_REPO_CHECK` | 是否跳过 git 校验 |
| `START_WITH_RESUME_IF_POSSIBLE` | 是否优先从历史状态恢复 |
| `CONFIRM_TEXT` | 自定义完成确认文本 |

## Completion Protocol

执行引擎要求 Codex 在真正完成时严格输出两行：

1. 基于 nonce 反转后的 done token
2. `CONFIRMED: all tasks completed`

只有完全匹配两行且没有第三行，任务才会被标记为 `completed`。

## 测试

```bash
npm test
```
