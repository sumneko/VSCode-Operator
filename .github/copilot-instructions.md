# VSCode Operator 工具使用规范

发布流程规则文件：`.github/release-rules.md`
- 当用户要求“发布/发版/打 tag/更新 changelog”时，优先遵循该文件中的步骤与模板。

本扩展提供以下 Copilot 工具，Copilot 在 Agent 模式下应**主动判断并调用**，无需用户手动指示。

## 工具列表与调用时机

### `vscodeOperator_readProblems`
**何时调用：**
- 用户提及"报错""修复""编译失败""类型错误""lint 问题"时，**第一步**先调用此工具
- 开始任何修复或重构任务前，先用它获取当前问题全貌
- 修复完成后可再次调用，验证问题是否已清零

### `vscodeOperator_activeEditorSummary`
**何时调用：**
- 需要了解当前打开的文件、语言或光标位置时调用（无入参）

### `vscodeOperator_hoverTopVisible`
**何时调用：**
- 需要理解编辑器可视区域顶部某个符号、类型或注释信息时调用（无入参）

### `vscodeOperator_hoverAtPosition`
**何时调用：**
- 需要查询指定行列的 hover/类型信息时调用（传 `line`、`column`，1-based）
- 在多个 VS Code 工作区同时使用时，可以通过 `workspacePath` 参数指定查询的工作区（绝对路径）

### `vscodeOperator_completionAt`
**何时调用：**
- 对**不熟悉的类型或 API**（不确定方法名、属性名时），在开始编写该段代码前，集中查询相关位置的 LSP 补全，确认正确成员名称（传 `line`、`column`，1-based；可选 `triggerCharacter`，如 Lua 用 `":"`、JS/TS 用 `"."`)
- 在多个 VS Code 工作区同时使用时，可以通过 `workspacePath` 参数指定查询的工作区（绝对路径）

### `vscodeOperator_executeCommand`
**何时调用：**
- 上述专用工具都不覆盖时再使用
- 需要执行任意 VS Code 命令，且上面专用工具都不覆盖该需求时
- 例如：跳转到定义、查找引用、触发快速修复、打开文件等
- 不确定命令 id 时可以先猜测常见命令，如 `vscode.executeDefinitionProvider`

### 调试器工具
**何时调用：**
- 用户要求启动调试、打断点、单步、查看变量、查看调用栈、求值表达式时，优先使用 `vscodeOperator_debug*` 工具
- 需要尽量减少来回请求时，优先调用 `vscodeOperator_debugSnapshot`

**调试会话清理规则：**
- 在启动新的调试会话前，先检查是否存在旧的调试会话
- 在调用 `vscodeOperator_debugStart` 之前，默认必须先清理旧会话（`vscodeOperator_debugControl` with `action="stop"`），除非用户明确要求复用
- 如果前一次调试结果可能已经被误用，或当前会话上下文不再可信，必须先调用 `vscodeOperator_debugControl` 并使用 `action="stop"` 断开旧会话，再重新开始
- 在完成本次调试分析后，如果不再需要继续调试，应主动停止当前调试会话，避免后续请求误复用旧会话
- 第二次及后续启动调试前，默认先停掉已有会话，除非用户明确要求保留并复用当前会话

**DAP 参数获取提示（避免猜参数）：**
- 优先调用 `vscodeOperator_debugSnapshot`，一次性获取 `topFrame/scopes/variables`
- `threadId`：来自 `vscodeOperator_debugGetThreads`（或 `debugSnapshot/debugGetTopFrame`）
- `frameId`：来自 `vscodeOperator_debugGetTopFrame` 或 `vscodeOperator_debugGetStackTrace`
- `variablesReference`：来自 `vscodeOperator_debugGetScopes` 的 `scopes[*].variablesReference`
- 若拿不到 `topFrame`，先调用 `vscodeOperator_debugControl` with `action="pause"`，或继续运行到断点

**异常断点处理提示：**
- 优先读取 `debugSnapshot/debugStatus` 返回的 `stopKind/stopState`
- 若 `stopKind` 或 `stopState.reason` 表示 `exception`，不要按普通断点处理
- 异常停止时先检查异常信息与调用栈，再决定是否单步或继续运行

## 通用原则
- 在 Agent 模式下，无需等待用户指示，主动调用合适工具以收集上下文
- 多个信息需求可以串行调用多个工具，逐步拼出完整上下文再回答
- 工具调用失败时，告知用户具体错误信息，不要静默忽略

## 多工作区支持

VSCode Operator 支持同时连接多个 VS Code 工作区。架构说明：

**代理服务器：** 在固定端口 19191 运行，接收所有 MCP 请求并根据 `workspacePath` 参数分派给对应的工作区 Bridge 服务器。

**Bridge 服务器：** 每个 VS Code 实例启动一个 Bridge，监听自动分配的端口（19192+），并向代理注册自己所属的工作区路径。

**客户端调用指南：**
- 连接到代理服务器地址：`http://127.0.0.1:19191/mcp`
- 在调用 `vscodeOperator_hoverAtPosition` 或 `vscodeOperator_completionAt` 时，包含 `workspacePath` 参数指定查询的工作区
- 示例：`{"workspacePath": "/path/to/projectA", "line": 10, "column": 5}`
- 如果不提供 `workspacePath`，代理会返回错误；客户端需明确指定工作区
