# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2025-04-03

### 核心亮点

首个正式版本。围绕 Codex CLI 的永动机包装器：开一个 codex 对话把任务给它，模型干一部分活停了，自动 resume 同一个对话说"继续"，循环直到全部做完。

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
