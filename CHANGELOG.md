# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2025-04-02

### 核心亮点

首个正式版本。围绕 Codex CLI 的永动机包装器：开一个 codex 对话把任务给它，模型干一部分活停了，自动 resume 同一个对话说"继续"，循环直到全部做完。

### Added

- **CLI 命令行入口**
  - `codex-autoresearch --prompt-file ./prompt.md` - 从 prompt 文件启动任务
  - `codex-autoresearch "任务"` - 直接执行任务
  - `codex-autoresearch session resume --last` - 恢复最近任务
  - `codex-autoresearch session status --last` - 查看最近任务状态
  - `codex-autoresearch skill run <name>` - 运行仓库 skill
  - `codex-autoresearch mcp serve` - 启动 MCP server

- **MCP Server**：阻塞模式，调用后聊天卡住，完成后才释放
  - `run_task` - 启动永动机任务，阻塞直到完成后返回最终结果

- **仓库 Skills**：可复用任务配方
  - `research` - 通用 research 和交叉核对
  - `phased-validation` - 分阶段长任务执行与验收

- **兼容层**：保留旧 `codex-keep-running.sh` 入口，内部转调新 CLI

### Changed

- MCP 简化为单一 `run_task` 工具，阻塞模式设计
- 执行引擎下沉为共享层，支持多入口复用
- 状态目录统一为 `.codex-run/<job-id>/`
