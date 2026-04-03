# codex-autoresearch

它的目标很直接：当你希望 Codex 在无人值守时持续推进同一项任务，这个脚本会先发起一次 `codex exec`，之后不断对同一会话执行 `codex exec resume`，直到收到严格的完成协议为止，而不是仅凭一句“我做完了”就停下。

一个围绕 Codex CLI 的长任务包装器：开一个 Codex 对话把任务给它，模型干一部分活停了，自动 resume 同一个对话说“继续”，循环直到全部做完。

## 工作流程

```
用户                              codex-autoresearch                          Codex CLI (Worker)
 |                                      |                                          |
 |  codex-autoresearch --prompt-file    |                                          |
 | -----------------------------------> |                                          |
 |                                      |                                          |
 |                                      |  ensureJobMetadata                       |
 |                                      |  创建 .codex-run/<job-id>/meta.json      |
 |                                      |                                          |
 |                                      |  ========== runLoop 开始 ==========      |
 |                                      |                                          |
 |                                      |  buildInitialPrompt:                     |
 |                                      |    任务文本 + 执行边界 + completion protocol |
 |                                      |                                          |
 |                                      |  codex exec -a never -s workspace-write <prompt> |
 |                                      | ---------------------------------------->|
 |                                      |                                          | 开始执行任务...
 |                                      |                                          | context 用完 / 惰性停止
 |                                      |  <-- exit ------------------------------>|
 |                                      |                                          |
 |                                      |  检查 last-message.txt                   |
 |                                      |  没有匹配 completion protocol            |
 |                                      |  等 3 秒                                 |
 |                                      |                                          |
 |                                      |  codex exec resume <session-id> "继续"    |
 |                                      | ---------------------------------------->|
 |                                      |                                          | 接着执行...
 |                                      |                                          | 又停了
 |                                      |  <-- exit ------------------------------>|
 |                                      |                                          |
 |                                      |  ... 重复 N 轮 ...                       |
 |                                      |                                          |
 |                                      |  匹配 completion protocol                |
 |                                      |  校验 completion_report / 冻结目标       |
 |                                      |  status -> completed                     |
 |                                      |                                          |
 |  <-- 返回 {status: completed, ...}   |                                          |
```

**关键设计**：
- 永动机核心循环：`codex exec` → 退出 → `codex exec resume "继续"` → 退出 → 循环
- 规划型任务支持“冻结目标 + 可变规划”：规划文件可以修正，但冻结目标不会变
- CLI 默认阻塞直到任务完成

## 安装

### 从 npm 全局安装（推荐）

```bash
npm install -g codex-autoresearch
codex-autoresearch --help
codex-autoresearch --version
```

### 从源码安装

```bash
git clone https://github.com/congwa/codex-autoresearch.git
cd codex-autoresearch
npm install
npm run build
npm link
codex-autoresearch --help
codex-autoresearch --version
```

## 快速开始

### 1. 查看版本

```bash
codex-autoresearch --version
```

### 2. 用规划文件驱动长任务

站在目标项目目录里，准备一个规划型 `prompt.md`：

```md
# 任务规划

## 目标
- 完成接口文档
- 完成 CLI 示例
- 更新 README

## 执行步骤
- 先读代码
- 再落盘修改
- 最后自检
```

然后执行：

```bash
codex-autoresearch --prompt-file ./prompt.md
```

### 3. 显式传冻结目标

如果你担心规划文件后续会继续修正，或者末尾目标会被误删，推荐显式传冻结目标文本：

```bash
codex-autoresearch \
  --prompt-file ./prompt.md \
  --frozen-goals-text "- 完成接口文档
- 完成 CLI 示例
- 更新 README"
```

这时：
- `prompt.md` 仍然可以继续修正
- 冻结目标以 `--frozen-goals-text` 为准
- 后续 resume 和完成判定都围绕这份冻结目标工作

## 使用方式

### `prompt.md` + CLI（推荐）

站在目标项目目录里，准备好一个 `prompt.md` 文件，然后：

```bash
codex-autoresearch --prompt-file ./prompt.md
# 或
codex-autoresearch run --prompt-file ./prompt.md
```

带冻结目标：

```bash
codex-autoresearch run \
  --prompt-file ./prompt.md \
  --frozen-goals-text "- 目标1
- 目标2"
```

### 直接传任务文本

```bash
codex-autoresearch "请检查当前仓库 TODO，补齐缺失测试并更新 README"
```

### 常用命令

```bash
# 查看帮助
codex-autoresearch --help

# 查看版本
codex-autoresearch --version

# 恢复最近一次任务
codex-autoresearch session resume --last

# 查看最近任务状态
codex-autoresearch session status --last
```

### Shell 薄包装 codex-keep-running.sh

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
| `USE_FULL_AUTO` | 是否启用后台自动执行默认策略；开启时会落成 `-a never -s workspace-write` |
| `APPROVAL_POLICY` | 显式审批策略，等价于 `--ask-for-approval` |
| `SANDBOX_MODE` | 显式沙箱模式，等价于 `--sandbox` |
| `DANGEROUSLY_BYPASS` | 是否启用危险绕过模式 |
| `SKIP_GIT_REPO_CHECK` | 是否跳过 git 校验 |
| `START_WITH_RESUME_IF_POSSIBLE` | 是否优先从历史状态恢复 |
| `CONFIRM_TEXT` | 自定义完成确认文本 |

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
| `goal-contract.md` | 冻结目标契约，后续不再受规划文件改动影响 |
| `goal-manifest.json` | 结构化冻结目标清单，供完成对账使用 |
| `working-plan.latest.md` | 当前最新规划文件快照 |
| `plan-revisions.jsonl` | 每次检测到规划文件变化时追加一条修订记录 |

`meta.json` 中记录的 prompt 来源字段：

| 字段 | 说明 |
| --- | --- |
| `promptSource` | `"file"` / `"text"` |
| `sourcePromptFile` | 原始 prompt 文件绝对路径（仅 `promptSource: "file"` 时有值） |
| `goalExtractionMode` | 冻结目标来源：`cli_text` / `explicit_section` / `full_file_fallback` |
| `goalContractHash` | 冻结目标内容哈希 |
| `lastObservedPlanHash` | 最近一次观测到的规划文件哈希 |
| `lastCompletionCheck` | 最近一次完成校验结果 |
| `lastPlanDrift` | 当前规划是否偏离冻结目标的说明 |

## 规划型任务的推荐写法

推荐把规划文件拆成两层：

1. 不可变目标
2. 可变执行计划

推荐模板：

```md
# 任务规划

## 目标
- 目标 A
- 目标 B
- 目标 C

## 执行步骤
- 这部分允许继续修正
- 可以调整顺序
- 可以补充过程说明
```

如果你需要最稳的行为，优先使用 `--frozen-goals-text`，这样就不会再依赖自动提取。

## 恢复、查看状态

```bash
# 恢复最近一次任务
codex-autoresearch session resume --last

# 查看最近任务状态
codex-autoresearch session status --last

# 按 session id 继续
codex-autoresearch session resume <session-id>
```

## Completion Protocol

执行引擎要求 Codex 在真正完成时，把 completion protocol 放在**最终两行**：

1. 基于 nonce 反转后的 done token
2. `CONFIRMED: all tasks completed`

对于规划型任务，还要求在这两行之前输出：

```md
<completion_report>
- [x] 冻结目标 1
- [x] 冻结目标 2
</completion_report>
```

只有同时满足下面条件才会标记为 `completed`：

- 最终两行匹配 completion protocol
- 没有阻断型 MCP/tool 失败
- `completion_report` 覆盖全部冻结目标

如果 `completion_report` 缺项，任务会继续保持 `needs_resume`。

## 测试

```bash
npm test
```

## 本地开发

```bash
npm install
npm run build
npm link
codex-autoresearch --help
codex-autoresearch --version
```

## 社区支持

- [【Linux.do】](https://linux.do/t/topic/1810871)