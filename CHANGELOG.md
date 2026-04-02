# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2025-04-02

### 核心亮点

首个正式版本。从 Bash 脚本演化为 TypeScript/Node 长任务执行框架，支持 CLI、MCP server、Skills 三种接入方式。

### Added

- **CLI 命令行入口**
  - `codex-autoresearch --prompt-file ./prompt.md` - 从 prompt 文件启动任务
  - `codex-autoresearch "任务"` - 直接执行任务
  - `codex-autoresearch session resume --last` - 恢复最近任务
  - `codex-autoresearch session status --last` - 查看最近任务状态
  - `codex-autoresearch skill run <name>` - 运行仓库 skill
  - `codex-autoresearch mcp serve` - 启动 MCP server

- **MCP Server**：暴露 7 个工具供外部 agent 调用
  - `start_task_from_prompt_file` - 从 prompt 文件启动新任务
  - `run_task` - 执行任务
  - `run_skill` - 运行 skill
  - `resume_session` - 恢复 session
  - `get_session_status` - 查询状态
  - `tail_session` - 读取执行步骤与日志尾部
  - `list_skills` - 列出 skills

- **仓库 Skills**：可复用任务配方
  - `research` - 通用 research 和交叉核对
  - `phased-validation` - 分阶段长任务执行与验收

- **兼容层**：保留旧 `codex-keep-running.sh` 入口，内部转调新 CLI

### Changed

- 执行引擎下沉为共享层，支持多入口复用
- 状态目录统一为 `.codex-run/<job-id>/`
