# CodePilot 工具使用规范

本扩展提供以下 Copilot 工具，Copilot 在 Agent 模式下应**主动判断并调用**，无需用户手动指示。

## 工具列表与调用时机

### `codepilot_readProblems`
**何时调用：**
- 用户提及"报错""修复""编译失败""类型错误""lint 问题"时，**第一步**先调用此工具
- 开始任何修复或重构任务前，先用它获取当前问题全貌
- 修复完成后可再次调用，验证问题是否已清零

### `codepilot_runSupportedCommand`
**何时调用：**
- 需要了解当前打开的文件、语言或光标位置时 → `action=activeEditorSummary`
- 需要理解编辑器可视区域顶部某个符号、类型或注释信息时 → `action=hoverTopVisible`
- 需要查询指定行列的 hover/类型信息时 → `action=hoverAtPosition`（需传 `line`、`column`，1-based）
- 对**不熟悉的类型或 API**（不确定方法名、属性名时），在开始编写该段代码前，用 `action=completionAt` 集中查询相关位置的 LSP 补全，确认正确的成员名称（需传 `line`、`column`，1-based；可选传 `triggerCharacter`，如 Lua 用 `":"` 、JS/TS 用 `"."`）；不需要在每一个成员访问前都查询
- 上述场景**优先使用本工具**，不要使用 `codepilot_executeCommand`

### `codepilot_executeCommand`
**何时调用：**
- 需要执行任意 VS Code 命令，且上面两个工具都不覆盖该需求时
- 例如：跳转到定义、查找引用、触发快速修复、打开文件等
- 不确定命令 id 时可以先猜测常见命令，如 `vscode.executeDefinitionProvider`

## 通用原则
- 在 Agent 模式下，无需等待用户指示，主动调用合适工具以收集上下文
- 多个信息需求可以串行调用多个工具，逐步拼出完整上下文再回答
- 工具调用失败时，告知用户具体错误信息，不要静默忽略
