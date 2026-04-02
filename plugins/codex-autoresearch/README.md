# codex-autoresearch plugin

这个插件的业务职责，是把 `codex-autoresearch` 变成“已经在 Codex 聊天窗里时”的正式入口。

这里的“插件”与仓库根目录的 `skills/` 不是一回事：

1. 插件负责聊天入口和 MCP 连接。
2. 仓库根目录 `skills/` 负责项目自己的任务配方。
3. 两者可以协作，但概念上必须分开。

设计目标：

1. 用户已经运行 `codex` 或 `codex resume` 进入当前聊天窗后，就地触发永动机。
2. 默认使用当前工作目录。
3. 默认只看当前聊天最近 8 轮，而不是整段历史。
4. 默认优先走 MCP，不把 shell 命令当聊天内主路径。

当前插件提供三类稳定入口：

1. `/codex-autoresearch`
2. 当前聊天里的自然语言触发
3. 当前聊天里显式点名仓库任务 skill

当前已知限制：

1. `/codex-autoresearch` 依赖 Codex Desktop 插件系统。
2. 当前实际运行中，插件系统需要 ChatGPT 登录态才能稳定工作。
3. 如果 Codex 当前是 API key 鉴权或 custom provider 模式，插件同步可能失败，`/` 列表里不会出现 `/codex-autoresearch`。
4. 这不是 MCP server 本身失效，而是插件入口不可用；此时请改走自然语言、MCP 或 CLI。

当前插件不做的事情：

1. 不读取当前 chat id
2. 不自动跳去别的聊天或全局最近任务
3. 不在 MCP 可用时把 shell 命令当成主路径

聊天内正式心智：

1. 当前聊天最近 8 轮是意图来源
2. 当前目录是执行边界
3. MCP tool `start_from_current_chat`、`continue_current_directory_task`、`run_skill_from_current_chat` 是正式聊天入口
4. 这些入口会在内部复用同一套路由器，决定是继续旧任务、新建任务，还是运行显式 skill
5. 如果当前聊天目标和当前目录最近任务冲突，会先要求确认

推荐聊天内用法：

```text
/codex-autoresearch
用 codex-autoresearch 把我们刚才聊的需求跑成一个永动机任务。
用 research skill 处理我们当前聊天刚才讨论的需求。
```

当前插件目录里的 skills 说明：

1. `codex-autoresearch/`
   - 作为聊天窗主入口，服务 `/codex-autoresearch`
2. `current-chat-autoresearch/`
   - 作为自然语言聊天触发的说明与路由约定
3. `continue-current-directory/`
   - 作为“继续当前目录最近任务”的说明与路由约定

仓库根目录的 `skills/` 仍然是项目自己的任务配方，例如：

1. `research`
2. `phased-validation`

也就是说：

1. 插件 skill 负责“怎么从当前聊天里触发”
2. 仓库 skill 负责“触发后按什么任务配方执行”
3. 两者通过当前聊天 MCP 工具串起来
