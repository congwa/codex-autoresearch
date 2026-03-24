# codex-autoresearch

一个用于守护 Codex 长任务的 Bash 脚本，避免codex执行一个长任务总是自动停止的问题。

它的目标很直接：当你希望 Codex 在无人值守时持续推进同一项任务，这个脚本会先发起一次 `codex exec`，之后不断对同一会话执行 `codex exec resume`，直到收到严格的完成协议为止，而不是仅凭一句“我做完了”就停下。

## 如何使用

### 1. 准备任务描述

先写一个任务文件，例如 `prompt.md`：

```md
请检查当前仓库中的 TODO，补齐缺失测试，并在完成后更新 README。
```

### 2. 运行脚本

在脚本所在目录执行：

```bash
./codex-keep-running.sh ./prompt.md
```

如果任务内容来自标准输入，也可以这样跑：

```bash
cat ./prompt.md | ./codex-keep-running.sh -
```

### 3. 指定要操作的仓库

默认工作目录是当前目录。若要让 Codex 在别的仓库里执行任务：

```bash
WORKDIR=/path/to/your/project ./codex-keep-running.sh ./prompt.md
```

### 4. 保留状态目录，支持守护脚本重启后续跑

```bash
STATE_DIR=.codex-run ./codex-keep-running.sh ./prompt.md
```

这样脚本会把事件日志、最后一条消息、会话 ID 和完成协议元信息写到 `.codex-run/`。如果守护脚本自己重启，只要还复用这个 `STATE_DIR`，它会优先尝试续跑上一次会话，而不是重新新建任务。

### 5. 常用自定义参数

```bash
WORKDIR=/path/to/repo \
STATE_DIR=.codex-run \
INTERVAL=10 \
MODEL=gpt-5 \
PROFILE=default \
./codex-keep-running.sh ./prompt.md
```

常用环境变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `WORKDIR` | 当前目录 | Codex 实际执行任务的仓库目录 |
| `STATE_DIR` | 自动生成临时目录 | 保存事件、会话、协议和快照 |
| `INTERVAL` | `3` | 每轮未完成后的重试间隔，单位秒 |
| `MODEL` | 空 | 透传给 `codex exec -m` |
| `PROFILE` | 空 | 透传给 `codex exec --profile` |
| `USE_FULL_AUTO` | `1` | 默认启用 `--full-auto` |
| `DANGEROUSLY_BYPASS` | `0` | 为 `1` 时使用危险绕过模式，不建议日常开启 |
| `SKIP_GIT_REPO_CHECK` | `0` | 为 `1` 时跳过 git 仓库检查 |
| `START_WITH_RESUME_IF_POSSIBLE` | `1` | 若存在历史状态则优先从上次会话恢复 |
| `CONFIRM_TEXT` | `CONFIRMED: all tasks completed` | 完成协议中的第二行确认文本 |

## 使用示例

### 示例 1：最基础的无人值守执行

```bash
cat > prompt.md <<'EOF'
请在当前仓库中完成以下工作：
1. 扫描未完成 TODO。
2. 优先修复会导致测试失败的问题。
3. 更新相关文档。
EOF

./codex-keep-running.sh ./prompt.md
```

适合“我先把任务交给 Codex，之后让它自己持续推进”的场景。

### 示例 2：让 Codex 在指定仓库里持续修复问题

```bash
cat > fix-bugs.md <<'EOF'
请检查测试失败原因，修复 bug，并补充必要测试。
EOF

WORKDIR=/Users/you/code/my-project \
STATE_DIR=/Users/you/code/my-project/.codex-run \
INTERVAL=5 \
./codex-keep-running.sh ./fix-bugs.md
```

适合把脚本放在工具仓库里，但真正执行任务的目录是另一个项目仓库。

### 示例 3：配合管道动态生成任务

```bash
printf '%s\n' \
  '请阅读当前仓库最近的改动。' \
  '为新增功能补一个 README 使用章节。' \
  '如果已有内容不准确，请顺手修正。' \
  | WORKDIR=/Users/you/code/my-project ./codex-keep-running.sh -
```

适合被别的脚本、CI、定时任务或调度器动态喂任务。

### 示例 4：守护脚本意外退出后继续接着跑

第一次启动：

```bash
STATE_DIR=.codex-run ./codex-keep-running.sh ./prompt.md
```

假设守护脚本因为终端关闭而退出，再次执行：

```bash
STATE_DIR=.codex-run ./codex-keep-running.sh ./prompt.md
```

脚本会优先读取 `.codex-run/session-id.txt` 和历史事件，能拿到会话 ID 就恢复指定会话，拿不到时再退回 `codex exec resume --last`。

## 原理说明

### 1. 首轮启动任务，后续只做续跑

脚本第一轮使用：

```bash
codex exec ...
```

后续轮次统一使用：

```bash
codex exec resume ...
```

这样做的目的是把所有进展都压在同一会话上下文里，避免每次失败后都重新开一个新会话，导致任务重复、上下文漂移或状态丢失。

### 2. 不相信“自然语言完成”，只相信完成协议

脚本不会因为 Codex 输出“任务完成了”“已经处理好了”就停止，而是会在每轮请求里追加一段完成协议：

1. 生成一组随机 `nonce`。
2. 反转后得到一次性 `DONE_TOKEN`。
3. 要求 Codex 只有在真的全部完成时，才能严格按两行输出完成口令。

只有当 `last-message.txt` 恰好满足以下条件时，脚本才退出：

1. 第一行等于本轮生成的 `DONE_TOKEN`
2. 第二行等于 `CONFIRM_TEXT`
3. 不允许出现第三行

这可以显著降低以下误判：

1. 模型用自然语言说“完成了”，但实际上还有遗漏
2. 旧日志里碰巧出现类似“done”的词
3. 中间过程输出被错当成最终完成信号

### 3. 每轮都记录状态，便于排障和恢复

状态目录中会保存这些文件：

| 文件 | 作用 |
| --- | --- |
| `events.jsonl` | Codex 的 JSON 事件流 |
| `runner.log` | 守护脚本自己的 stderr 日志 |
| `last-message.txt` | 最近一轮 assistant 最终输出 |
| `session-id.txt` | 从事件流中提取到的会话 ID |
| `meta.env` | 当前工作目录、nonce、done token 等元信息 |
| `initial-prompt.txt` | 首轮真正发给 Codex 的消息 |
| `resume-prompt.txt` | 后续每轮续跑时发送的消息 |
| `attempt-0001.last.txt` 等 | 每轮结束时的消息快照 |

这套设计既方便人工回看，也方便守护脚本重启后继续追踪同一任务。

### 4. 会话恢复策略

恢复顺序是：

1. 如果 `STATE_DIR` 里已有 `session-id.txt`，优先恢复这个具体会话
2. 如果还没拿到会话 ID，但已经有历史状态，尝试在 `WORKDIR` 下执行 `codex exec resume --last`
3. 如果没有任何历史状态，则启动一次新的 `codex exec`

因此它适合接到 `cron`、`tmux`、系统守护进程或其他 supervisor 中，作为“Codex 长任务保活层”。

## 适用场景

这个脚本尤其适合以下场景：

1. 任务很长，中途可能因为超时、网络波动或 CLI 退出而中断
2. 你希望 Codex 始终围绕同一任务继续推进，而不是每轮都重新开始
3. 你需要一套可回放、可恢复、可排障的长任务执行记录
4. 你希望把 Codex 接到自动化系统里长期运行

## 运行前提

使用前请确认：

1. 本机已安装 `codex` 命令，并且可直接在 shell 中调用
2. 目标 `WORKDIR` 存在
3. 传入的 prompt 文件非空，或标准输入中确实有任务内容

## 快速总结

如果只记一个命令，可以先用这个：

```bash
WORKDIR=/path/to/repo STATE_DIR=.codex-run ./codex-keep-running.sh ./prompt.md
```

这会让 Codex 在指定仓库里执行任务，并把所有续跑状态保存在 `.codex-run` 中，后续即使守护脚本中断，也更容易从同一会话继续跑下去。
