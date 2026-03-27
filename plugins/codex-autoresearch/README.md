# codex-autoresearch plugin

这个插件的业务职责是把 `codex-autoresearch` 变成 Codex 聊天里的“当前聊天 / 当前目录”快捷入口。

这里的“插件”与仓库根目录的 `skills/` 不是一回事：

1. 插件负责聊天入口和 MCP 连接
2. 仓库根目录 `skills/` 负责项目自己的任务配方
3. 两者可以协作，但概念上必须分开

设计目标：

1. 当前聊天里直接触发 codex-autoresearch
2. 默认使用当前工作目录
3. 默认继续当前目录最近任务，而不是让你手动找 session

当前插件提供两类稳定能力：

1. 插件卡片与 starter prompts
2. 通过 MCP 把当前聊天里的意图路由到 `codex-autoresearch`

当前不做的事情：

1. 不读取当前 chat id
2. 不依赖未确认稳定的 slash / command surface
3. 不自动切换到全局最近会话
