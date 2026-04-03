# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5-beta.0] - 2025-04-03

### 核心亮点

Codex CLI 参数升级：从 `--full-auto` 改为 `-a never -s workspace-write`，更精细的控制。

### Added

- **审批策略环境变量**
  - `APPROVAL_POLICY` - 显式审批策略，等价于 `--ask-for-approval`
  - `SANDBOX_MODE` - 显式沙箱模式，等价于 `--sandbox`

### Changed

- `USE_FULL_AUTO` 开启时落成 `-a never -s workspace-write` 而非 `--full-auto`
- 默认执行命令从 `codex exec --full-auto` 改为 `codex exec -a never -s workspace-write`

---

## [0.1.4] - 2025-04-03

### 核心亮点

规划型任务支持"冻结目标 + 可变规划"：规划文件可以修正，但冻结目标不会变。

**重要**：prompt.md 必须包含规划章节，明确说明当前状态、从哪里开始、做什么任务，否则大模型会自己幻想。

### Added

- **冻结目标机制**
  - `--frozen-goals-text` 显式传冻结目标文本
  - 规划文件可修正，冻结目标不变
  - `completion_report` 校验覆盖全部冻结目标

- **状态文件**
  - `goal-contract.md` - 冻结目标契约
  - `goal-manifest.json` - 结构化冻结目标清单
  - `working-plan.latest.md` - 当前最新规划文件快照
  - `plan-revisions.jsonl` - 规划文件修订记录

- **CLI 增强**
  - `codex-autoresearch --version` 查看版本

### Changed

- 从"永动机包装器"定位为"长任务包装器"
- 完成判定增加 `completion_report` 校验

---

## [0.1.3] - 2025-04-03

### 核心亮点

首个正式版本。围绕 Codex CLI 的长任务包装器：开一个 Codex 对话把任务给它，模型干一部分活停了，自动 resume 同一个对话说"继续"，循环直到全部做完。

**重要**：prompt.md 必须包含规划章节，明确说明当前状态、从哪里开始、做什么任务，否则大模型会自己幻想。

### Added

- **CLI 命令行入口**
  - `codex-autoresearch --prompt-file ./prompt.md` - 从 prompt 文件启动任务
  - `codex-autoresearch "任务"` - 直接执行任务
  - `codex-autoresearch session resume --last` - 恢复最近任务
  - `codex-autoresearch session status --last` - 查看最近任务状态

- **npm 发布**：支持 `npm install -g codex-autoresearch` 全局安装

- **兼容层**：保留旧 `codex-keep-running.sh` 入口，内部转调新 CLI

### Changed

- 移除 MCP、Skills 相关代码，简化为纯 CLI 工具
- 执行引擎下沉为共享层，支持多入口复用
- 状态目录统一为 `.codex-run/<job-id>/`
