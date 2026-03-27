# codex-autoresearch

一个把 Codex 长任务执行统一收口到 TypeScript/Node 的工具仓库。现在它不再要求你先手写 `prompt.md`，而是同时提供：

1. CLI 直接执行任务
2. 仓库自有 Skills 作为一等任务配方
3. MCP server 作为对外执行服务
4. Codex 插件作为“当前聊天 / 当前目录”入口
5. `codex-keep-running.sh` 作为旧入口兼容层

底层仍然保留原有长任务核心能力：首轮 `codex exec`、后续 `codex exec resume`、严格 completion protocol、session 恢复、状态持久化和失败后续跑；只是这些能力已经下沉为共享执行引擎，不再只存在于单个 Bash 脚本里。

## 安装

你现在可以按 4 种方式接入本项目：

| 方式 | 适合场景 | 安装 / 接入方式 | 触发方式 |
| --- | --- | --- | --- |
| 本地命令 | 你就在项目目录里，想直接跑永动机 | `npm install && npm run build`，然后直接运行本地 bin 或全局 bin | `codex-autoresearch "任务"` |
| 全局命令 | 你希望任意项目目录里都能直接敲命令 | `npm install -g .` 或后续发布到 npm 后 `npm install -g codex-autoresearch` | `codex-autoresearch "任务"` |
| MCP server | 你要把本项目暴露给外部 agent / 插件 / MCP client | 构建后运行 `codex-autoresearch mcp serve`，或通过插件内 `.mcp.json` 连接 | `run_task` / `run_skill` / `resume_session` / `route_chat_intent` |
| 仓库自有 skill | 你希望把常用任务做成可复用配方 | 无需额外安装，构建后直接用 CLI 或 MCP 调用 `skills/<name>/skill.yaml + prompt.md` | `codex-autoresearch skill run ...` 或 MCP `run_skill` |
| Codex 插件 | 你已经在 Codex 聊天窗里，希望说人话触发 | 使用仓库内 `plugins/codex-autoresearch/` 和 `.agents/plugins/marketplace.json` 安装本地插件 | 固定话术或插件 starter prompts |

最小本地安装：

```bash
npm install
npm run build
```

构建后会生成 npm bin：

```bash
./dist/src/cli.js --help
```

如果通过 npm 安装到全局或作为依赖使用，则直接运行：

```bash
codex-autoresearch --help
```

如果你想把它装成全局命令：

```bash
npm install -g .
codex-autoresearch --help
```

## 快速开始

### 最常用速查表

如果你只想记最常用的几种方式，先看这里：

| 场景 | 直接用法 |
| --- | --- |
| 当前目录启动一个新永动机任务 | `codex-autoresearch "你的任务"` |
| 当前目录继续最近任务 | `codex-autoresearch session resume --last` |
| 运行仓库内置 skill | `codex-autoresearch skill run research --set topic=...` |
| 启动 MCP server | `codex-autoresearch mcp serve` |
| 打开交互入口 | `codex-autoresearch` |
| 在 Codex Desktop 打开当前目录 | `codex-autoresearch app` |

如果你已经在 `codex resume` 聊天窗里，主路径已经改成固定话术 + 插件走 MCP 自动触发，不再要求先想 shell 命令：

```text
用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。
用 codex-autoresearch 处理我们当前聊天里正在讨论的需求。
用 codex-autoresearch 在当前目录开一个新任务。
```

### 1. 直接执行任务

站在你要处理的项目目录里，直接运行：

```bash
codex-autoresearch "请检查当前仓库 TODO，补齐缺失测试并更新 README"
```

这等价于：

```bash
codex-autoresearch run "请检查当前仓库 TODO，补齐缺失测试并更新 README"
```

如果你已经在 Codex 聊天里，也可以安装本仓库自带的插件并直接用插件卡片里的 starter prompts 触发，不再额外思考路径和 session。

默认行为：

| 默认项 | 说明 |
| --- | --- |
| 工作目录 | 当前 shell 目录 |
| 状态目录 | 当前目录下的 `.codex-run/` |

只有在高级场景下，才需要显式传参数：

| 参数 | 作用 |
| --- | --- |
| `--workdir` | Codex 实际执行的仓库目录 |
| `--state-dir` | 状态根目录，任务会落到 `.codex-run/<job-id>/` |
| `--model` | 透传给 `codex exec -m` |
| `--profile` | 透传给 `codex exec --profile` |
| `--interactive` | 缺失参数时允许交互补齐 |
| `--skip-git-repo-check` | 跳过 git 仓库校验 |
| `--dangerously-bypass` | 启用危险绕过模式 |
| `--no-full-auto` | 关闭默认的 `--full-auto` |

无参数启动会进入交互式入口，可选择直接任务、运行 skill、继续最近任务或在 Codex Desktop 打开当前目录：

```bash
codex-autoresearch
```

### 2. 查看和执行 Skills

这里的 skill 指“本仓库自带的任务配方”，是项目自己的协议：

```text
skills/<name>/skill.yaml
skills/<name>/prompt.md
```

它和 Codex 插件是两回事。

也就是说：

1. 插件是聊天入口
2. skill 是任务配方
3. 插件可以触发 MCP，MCP 也可以运行 skill
4. 但插件本身不等于 skill，skill 本身也不等于插件

列出仓库内置 skills：

```bash
codex-autoresearch skill list
```

执行 skill：

```bash
codex-autoresearch skill run research \
  --set topic=GPT-5.4升级影响 \
  --set constraints=只关注当前仓库迁移方案
```

交互补齐缺失参数：

```bash
codex-autoresearch --interactive skill run phased-validation
```

当前仓库内置了两个示例 skill：

1. `research`：通用 research 和交叉核对
2. `phased-validation`：分阶段长任务执行与验收

`skill.yaml` v1 字段：

| 字段 | 说明 |
| --- | --- |
| `name` | Skill 名称 |
| `description` | Skill 用途说明 |
| `inputs` | 输入参数定义 |
| `defaultWorkdir` | 默认执行目录 |
| `defaultModel` | 默认模型 |
| `outputContract` | 预期输出约束 |

### 3. 恢复已有任务

恢复最近一次任务：

```bash
codex-autoresearch session resume --last
```

按 session id 查看或继续：

```bash
codex-autoresearch session status 11111111-1111-1111-1111-111111111111
codex-autoresearch session resume 11111111-1111-1111-1111-111111111111
```

### 4. 启动 MCP server

把本项目暴露成 MCP 执行服务：

```bash
codex-autoresearch mcp serve
```

MCP 客户端调用示例：

```json
{
  "tool": "run_task",
  "arguments": {
    "task": "请检查当前仓库 TODO 并输出修复建议"
  }
}
```

聊天内固定话术对应的 MCP 路由示例：

```json
{
  "tool": "route_chat_intent",
  "arguments": {
    "chatIntent": "用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。",
    "chatSummary": "继续完善 codex-autoresearch 的 README、插件文案和 MCP 路由测试",
    "workdir": "."
  }
}
```

如果你是外部 agent，推荐优先用：

1. `route_chat_intent`：聊天内自然语言路由，自动判断继续还是新建
2. `run_task`：你已经有明确任务文本
3. `run_skill`：你想复用仓库内 skill 配方
4. `resume_session`：你已经明确要接到某条现有任务链

### 5. 在 Codex Desktop 中打开当前目录

如果你已经站在对的目录里，只想一键用 Codex Desktop 打开它：

```bash
codex-autoresearch app
```

### 6. 在 Codex 聊天里使用插件

仓库现在内置了 repo-local Codex 插件，位置在：

```text
plugins/codex-autoresearch/
```

marketplace 清单在：

```text
.agents/plugins/marketplace.json
```

本地插件安装素材已经在仓库里：

1. 插件 manifest：[plugin.json](/Users/wang/code/my/codex-autoresearch/plugins/codex-autoresearch/.codex-plugin/plugin.json)
2. 插件 MCP 绑定：[.mcp.json](/Users/wang/code/my/codex-autoresearch/plugins/codex-autoresearch/.mcp.json)
3. marketplace 清单：[marketplace.json](/Users/wang/code/my/codex-autoresearch/.agents/plugins/marketplace.json)
4. 插件说明：[plugins README](/Users/wang/code/my/codex-autoresearch/plugins/codex-autoresearch/README.md)

插件入口的设计目标是：

1. 在当前聊天里复用当前目录
2. 默认继续当前目录最近任务
3. 不要求你先想 `workdir`、`state-dir` 或 session id

这里也需要特别区分：

1. Codex 插件是聊天里的入口层
2. 本仓库 `skills/` 目录是项目自己的任务配方层
3. 插件目录下如果出现 `SKILL.md`，那是插件侧辅助说明或插件侧可挂载能力，不等于仓库主 `skills/` 协议
4. 这两层可以协作，但概念上不混用

插件当前提供的 starter prompts 聚焦三类动作，并且主路径都会优先调用 MCP：

1. 用 codex-autoresearch 继续做我们当前聊天里还没完成的事情
2. 用 codex-autoresearch 在当前目录开一个新任务
3. 用 codex-autoresearch 处理当前聊天里的需求

当前聊天语义说明：

1. 插件不会直接读取你此刻正在看的 chat id
2. 插件依赖当前聊天上下文和当前工作目录
3. 当前聊天提供目标、约束和未完事项；当前目录提供执行边界
4. 插件会先把固定话术和聊天摘要交给 MCP tool `route_chat_intent`
5. `route_chat_intent` 会自动判断应该走 `resume_session --last` 还是 `run_task`
6. 如果当前聊天目标和当前目录最近 codex-autoresearch 任务明显冲突，会返回需要确认，而不是静默执行

### 已经在 `codex resume` 聊天里时怎么用

如果你已经运行了 `codex resume` 进入某个聊天窗，推荐固定用下面两条路径：

1. 直接说固定话术
2. 点插件 starter prompt

推荐固定话术：

```text
用 codex-autoresearch 处理我们当前聊天里正在讨论的需求。
用 codex-autoresearch 继续做我们当前聊天里还没完成的事情。
用 codex-autoresearch 在当前目录开一个新任务。
```

推荐心智已经改成 MCP-first：

1. 当前聊天是意图来源，不是 thread id 来源
2. 当前目录是执行边界
3. 插件会把你的固定话术和当前聊天摘要交给 `route_chat_intent`
4. `route_chat_intent` 自动判断是继续旧任务还是新建任务
5. 如果判断到聊天目标和当前目录最近任务冲突，会先要求确认

为什么现在比之前更简单：

1. 你不需要先想 `workdir`
2. 你不需要先想 `state-dir`
3. 你不需要先找 session id
4. 你不需要在聊天里手写 `codex-autoresearch ...` 命令
5. 你只需要说固定话术，插件就会通过 MCP 触发本项目

什么时候会自动继续：

1. 当前聊天里有“继续”“接着做”“还没完成”等信号
2. 当前目录下存在最近一次 codex-autoresearch 任务
3. 当前聊天目标与最近任务没有明显冲突

什么时候会自动新建：

1. 当前聊天明显是在说一个新需求或新 deliverable
2. 当前目录没有可续跑任务
3. 当前聊天已经给出足够具体的一句话任务摘要

什么时候会要求确认冲突：

1. 当前聊天同时像“继续旧任务”又像“开新任务”
2. 当前聊天目标与当前目录最近 codex-autoresearch 任务明显不一致
3. 当前聊天只说“继续”，但目标仍然过于模糊

当前版本仍然不能自动读取你眼前这个聊天的内部 id，但已经能把“当前聊天的意图”和“当前目录里的 codex-autoresearch 状态链”稳定拼起来。

### Shell fallback

如果插件或 MCP 暂时不可用，才退回命令方式。

已经全局安装 `codex-autoresearch` 时，可以在聊天里这样说：

```text
请在当前目录执行：codex-autoresearch session resume --last
```

```text
请先把我们当前聊天的目标总结成一句任务，再在当前目录执行：codex-autoresearch "<总结后的任务>"
```

如果还没有全局安装，而你就在本仓库目录里，可以改成：

```text
请在当前目录执行：node ./dist/src/cli.js session resume --last
```

```text
请先把我们当前聊天的目标总结成一句任务，再在当前目录执行：node ./dist/src/cli.js "<总结后的任务>"
```

关于 slash-like 体验：

当前版本先落稳定的插件卡片和 starter prompts。由于没有确认可用的公开 slash surface，`/codex-autoresearch` 一类入口暂时只作为后续探索项，不影响现在的主流程。

固定暴露的工具：

1. `run_task`
2. `run_skill`
3. `resume_session`
4. `get_session_status`
5. `list_skills`
6. `route_chat_intent`

每个执行类 tool 都会返回：

1. `jobId`
2. `sessionId`
3. `stateDir`
4. `status`
5. `lastMessageFile`

`route_chat_intent` 额外会返回：

1. `action`，表示选择了 `resume_session`、`run_task` 或 `conflict`
2. `reason`，解释为什么这样路由
3. `chatIntent`
4. `chatSummary`

这样外部 agent 可以继续查询、续跑同一任务。

## 现在到底支持哪些用法

目前已经正式支持 5 条用户路径：

1. 本地命令直接跑任务：`codex-autoresearch "任务"`
2. 本地命令继续最近任务：`codex-autoresearch session resume --last`
3. 本地命令运行仓库 skill：`codex-autoresearch skill run <skill-name>`
4. 作为 MCP server 被外部调用：`codex-autoresearch mcp serve`
5. 在 Codex 聊天里通过插件和固定话术触发 MCP

如果你问“本地命令、MCP、skill 都支持了吗”，当前答案是支持。

更具体地说：

1. 本地命令入口已经稳定
2. MCP 工具集已经稳定，包含 `route_chat_intent`
3. 仓库内 skill 已可通过 CLI 和 MCP 复用
4. Codex 聊天内插件入口已经改成 MCP-first
5. 旧的 `codex-keep-running.sh` 仍然兼容，但不再是首选入口

## 状态目录

统一执行引擎会把状态写到：

```text
.codex-run/<job-id>/
```

典型文件：

| 文件 | 作用 |
| --- | --- |
| `meta.json` | 任务元信息、状态、配置、session 绑定结果 |
| `events.jsonl` | Codex JSON 事件流 |
| `runner.log` | 执行日志和错误输出 |
| `last-message.txt` | 最近一轮 assistant 最终输出 |
| `session-id.txt` | 从事件流提取的 session id |
| `initial-prompt.txt` | 首轮真正下发给 Codex 的任务 |
| `resume-prompt.txt` | 后续 resume 使用的续跑提示 |
| `attempt-0001.last.txt` | 每轮结束时的消息快照 |

状态根目录还会维护 `latest-job.txt`，用于 `session resume --last` 和兼容层恢复最近任务。

### 状态目录迁移说明

新版本的正式布局固定为 `.codex-run/<job-id>/`。如果你继续使用 `codex-keep-running.sh`，`STATE_DIR` 现在会被视为状态根目录，而不是单个任务目录；兼容层会通过 `latest-job.txt` 找到最近一次任务继续运行，不再承诺旧版平铺状态文件格式。

## Completion Protocol

执行引擎不会因为自然语言“我做完了”就停下，而是要求 Codex 在真正完成时严格输出两行：

1. 基于 nonce 反转后的 done token
2. `CONFIRMED: all tasks completed`

只有完全匹配两行且没有第三行，任务才会被标记为 `completed`。这套协议是从旧 Bash 版本迁移下来的核心约束，目的是降低长任务误判完成的风险。

## 兼容旧版 `codex-keep-running.sh`

老用法仍然保留：

```bash
./codex-keep-running.sh ./prompt.md
cat ./prompt.md | ./codex-keep-running.sh -
```

只是现在 shell 脚本已经退化成薄包装，内部会转调新的 Node CLI `legacy` 入口。

旧环境变量依然可用：

| 变量 | 作用 |
| --- | --- |
| `WORKDIR` | 实际执行目录 |
| `STATE_DIR` | 兼容层状态目录 |
| `INTERVAL` | 重试间隔 |
| `MODEL` | 模型 |
| `PROFILE` | profile |
| `USE_FULL_AUTO` | 是否开启 `--full-auto` |
| `DANGEROUSLY_BYPASS` | 是否启用危险绕过模式 |
| `SKIP_GIT_REPO_CHECK` | 是否跳过 git 校验 |
| `START_WITH_RESUME_IF_POSSIBLE` | 是否优先从历史状态恢复 |
| `CONFIRM_TEXT` | 自定义完成确认文本 |

## 测试

```bash
npm test
```

测试覆盖：

1. completion token 生成与识别
2. session 恢复优先级
3. skill manifest 解析与 prompt 渲染
4. CLI 参数校验与傻瓜式入口
5. 插件 manifest、marketplace 和插件 skills 路由约束
6. fake `codex` 下的首轮启动、resume、`--last` 和兼容 wrapper
7. MCP handler 的输入输出契约与错误分支

## 开发说明

仓库优先以 TypeScript/Node 作为主实现。Bash 只保留兼容职责，不再承载核心业务逻辑。

### 内部分层

这次重构后，源码默认按 3 层理解：

1. `engine`
说明 `completion protocol`、状态目录、Codex 进程调用和守护续跑

2. `application`
说明 direct task、skill、resume、status、chat intent route 这些业务用例怎么统一编排

3. `transport / presenter`
说明 CLI、MCP、legacy 如何解析输入、调用 application，并把结果格式化输出

同时还额外拆出了两类可扩展模块：

1. `routing`
承接聊天意图判断、continue/new/conflict 策略，避免业务规则继续堆进 MCP server

2. `skills`
拆成 manifest、catalog、inputs、prompt 等子职责，避免 skill 协议扩展时全部挤在一个文件里

后续如果新增入口，默认只新增 transport adapter，不应把业务规则直接塞回 CLI 或 MCP 文件。

如果你要新增技能，请遵循：

```text
skills/<name>/skill.yaml
skills/<name>/prompt.md
```

如果你要新增对外接口，请保持现有公共命令组和 MCP 工具名称不变，只做增量扩展。
