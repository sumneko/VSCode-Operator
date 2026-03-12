# CodePilot — 架构说明

> 本文档面向接手本项目的 AI 助手，帮助快速理解项目结构、设计决策与常见陷阱。

---

## 项目定位

**CodePilot** 是一个纯 VS Code 扩展，通过 `vscode.lm.registerTool` 向 Copilot Agent 暴露三个 Language Model Tool，使 Copilot 能够主动操作 VS Code 本身。

在此基础上，项目现在额外内置了一个**本地 MCP bridge**：它同样运行在扩展宿主进程（Extension Host）中，通过本地 HTTP 端口把 `vscode.lm.tools` 暴露给外部 MCP 客户端，并把 `tools/call` 转发到 `vscode.lm.invokeTool`。

**不要**将其理解为独立桌面进程或外部 sidecar。当前 MCP bridge 仍然依赖 VS Code Extension Host 才能访问编辑器上下文。

---

## 目录结构

```
src/
  extension.ts              # 激活入口，注册三个工具
  features/
    index.ts                # 桶导出
    problemsTool.ts         # 工具1：读取问题面板
    commandTool.ts          # 工具2+3：运行支持的命令 / 执行任意命令
   mcp/
      bridgeServer.ts         # 本地 MCP bridge：把 vscode.lm.tools 暴露成 MCP tools/list + tools/call
.github/
  copilot-instructions.md   # Copilot 工作区级系统提示，规定何时调用哪个工具
.vscode/
  launch.json               # F5 启动扩展开发宿主（preLaunchTask: npm: compile）
  tasks.json                # npm: compile 任务
package.json                # 扩展清单 + languageModelTools + MCP bridge 命令/配置
tsconfig.json               # target ES2022, module Node16, rootDir src, outDir dist
```

---

## 三个 VS Code 工具

### 1. `codepilot_readProblems`

**文件**：`src/features/problemsTool.ts`

**功能**：读取 VS Code 问题面板（Problems Panel）中的所有诊断信息。

**入参**：
- `maxItems?: number`（默认 200，最大 500）

**输出**：JSON 对象，字段 `{ total, returned, items[] }`，每项包含：
- `file`（fsPath）、`severity`（"error"|"warning"|"information"|"hint"）
- `message`、`source`、`code`
- `startLine`/`startColumn`/`endLine`/`endColumn`（**1-based**）

**实现要点**：
- 使用 `vscode.languages.getDiagnostics()` 遍历所有 URI
- `diagnostic.code` 可能是 `string | number | { value } | undefined`，统一转 `string`

---

### 2. `codepilot_runSupportedCommand`

**文件**：`src/features/commandTool.ts` → `class RunSupportedCommandTool`

**功能**：提供经过封装、返回人类可读文本的常用编辑器操作。

**入参**：
- `action: "activeEditorSummary" | "hoverTopVisible" | "hoverAtPosition" | "completionAt"`
- `line?: number`（1-based，供 `hoverAtPosition` / `completionAt` 使用）
- `column?: number`（1-based，同上）
- `triggerCharacter?: string`（供 `completionAt` 使用，如 Lua 的 `":"`, JS/TS 的 `"."`）

**各 action 说明**：

| action | 描述 | 备注 |
|---|---|---|
| `activeEditorSummary` | 返回当前文件路径、语言、光标位置 | 无需额外参数 |
| `hoverTopVisible` | 编辑器可视区顶部第一行的 hover 信息 | 无需额外参数 |
| `hoverAtPosition` | 指定行列的 hover 信息 | 使用 active editor 的 URI，绕过 URI 序列化问题 |
| `completionAt` | 指定行列的 LSP 补全列表 | 用于确认类型成员名称，最多返回 200 项 |

**为什么不用 `codepilot_executeCommand` 做 hover？**  
`vscode.executeHoverProvider` 要求传入 `vscode.Uri` 实例，但经过 JSON 序列化/反序列化后 Uri 变成普通对象，导致 `Invalid argument 'uri'` 错误。`RunSupportedCommandTool` 直接从 `activeTextEditor.document.uri` 取 Uri，完全绕开此问题。

---

### 3. `codepilot_executeCommand`

**文件**：`src/features/commandTool.ts` → `class ExecuteCommandTool`

**功能**：执行任意 VS Code 命令，返回命令结果文本。

**入参**：
- `command: string`（VS Code 命令 ID，如 `"vscode.executeDefinitionProvider"`）
- `args?: unknown[]`（命令参数数组）
- `argsJson?: string`（JSON 字符串，必须解码为数组；与 `args` 二选一）

**URI 反序列化**：`parseArgs()` 对每个参数调用 `tryDeserializeUri()`，自动将以下格式转为原生对象：
- URI 字符串（`"file:///..."` 或绝对路径）→ `vscode.Uri`
- `{scheme, path, ...}` 对象 → `vscode.Uri.from()`
- `{line, character}` 对象 → `vscode.Position`

**Hover 内容序列化**：`summarizeResult()` 检测结果是否为 `vscode.Hover[]`（通过检查 `result[0].contents` 是否为数组），若是则用 `hoverContentsToText()` 提取文本，避免 `MarkdownString.value`（getter）被 `JSON.stringify` 忽略返回 `{}` 的问题。

---

## MCP Bridge

**文件**：`src/mcp/bridgeServer.ts`

**功能**：在扩展宿主进程内启动一个本地 HTTP MCP 服务，把当前 VS Code 会话中已注册的 `vscode.lm.tools` 暴露给外部 AI / MCP 客户端。

**默认地址**：
- MCP endpoint: `http://127.0.0.1:19191/mcp`
- Health endpoint: `http://127.0.0.1:19191/health`

**当前实现方式**：
- 使用 `@modelcontextprotocol/sdk@1.27.1`
- 使用 v1 transport：`StreamableHTTPServerTransport`（`@modelcontextprotocol/sdk/server/streamableHttp.js`）
- 使用低层 `Server`（`@modelcontextprotocol/sdk/server/index.js`）
- 每个 HTTP 请求临时创建一个 stateless MCP transport，并在请求结束后关闭

**为什么是本地 HTTP，而不是 stdio？**
- 扩展宿主本身不是为外部 MCP 客户端按需 `spawn` 的进程，直接复用 Extension Host 的 stdio 不现实
- HTTP bridge 运行在扩展宿主内部，可以直接访问 `vscode.lm.tools` / `vscode.lm.invokeTool`
- 对外部客户端更友好：给一个 localhost URL 即可连接

**桥接行为**：

1. `tools/list`
返回当前 `vscode.lm.tools` 的快照，按名称排序，并把 VS Code tool 的 `description` / `inputSchema` 转成 MCP Tool 定义。

2. `tools/call`
按名称查找 `vscode.lm.tools` 中对应工具，验证 `arguments` 为 JSON object，然后调用：

```ts
vscode.lm.invokeTool(toolName, {
  toolInvocationToken: undefined,
  input: args
})
```

3. 结果转换
`LanguageModelToolResult.content` 中的内容被转换为 MCP `content[]`：
- `LanguageModelTextPart` → MCP `text`
- `LanguageModelPromptTsxPart` → `JSON.stringify(...)` 后作为 MCP `text`
- `LanguageModelDataPart` → 尝试按 `mimeType` 解码成 text / JSON；非文本二进制降级为说明性文本

**配置项**：
- `codepilot.mcpBridge.enabled`
- `codepilot.mcpBridge.host`
- `codepilot.mcpBridge.port`
- `codepilot.mcpBridge.path`

**管理命令**：
- `codepilot.mcpBridge.showStatus`
- `codepilot.mcpBridge.restart`

---

## 关键设计决策

1. **MCP bridge 运行在扩展内，而不是外部 sidecar**  
   只有 Extension Host 才能直接访问 `vscode.lm.tools` / `vscode.lm.invokeTool`。因此当前方案不是“单独的 MCP 进程 + 回连 VS Code”，而是“扩展内启动 localhost MCP 服务”。

2. **SDK 采用已发布的 `@modelcontextprotocol/sdk@1.27.1`**  
   npm 当前可安装的是旧的单包 SDK，而不是 monorepo 中展示的拆包版 `@modelcontextprotocol/server` / `@modelcontextprotocol/node`。因此实现必须使用 v1 import path：
   - `@modelcontextprotocol/sdk/server/index.js`
   - `@modelcontextprotocol/sdk/server/streamableHttp.js`
   - `@modelcontextprotocol/sdk/types.js`

3. **`contributes.languageModelTools` 是 Copilot 侧工具发现的关键**  
   `package.json` 中的 `languageModelTools` 贡献点让 Copilot 在 Agent 模式下自动发现工具。`modelDescription` 字段直接影响模型何时以及如何调用工具，是实际的"隐性系统提示"。

4. **`args` 数组 JSON Schema 必须有 `"items"` 字段**  
   VS Code 校验 `"type": "array"` 时要求 `"items"` 存在，否则报 `tool parameters array type must have items`。现已在 `codepilot_executeCommand` 的 schema 中加入 `"items": {}`。

5. **`completionAt` 的正确用法**  
   应在任务开始前针对**不熟悉的类型**集中查询一次，而非在每个方法调用前都查询。后者会把代码生成变成极慢的逐步流程。正确流程：查询不熟悉的类型 → 一次性生成代码 → `readProblems` 检查错误 → 修复。

---

## 开发工作流

```bash
npm install      # 安装 devDependencies + @modelcontextprotocol/sdk
npm run compile  # tsc -p ./ → dist/
npm run watch    # tsc -watch，开发时使用
```

- **F5**：启动 Extension Development Host（自动先执行 `npm: compile`）
- 编译输出到 `dist/`，`package.json` 的 `"main"` 指向 `"./dist/extension.js"`
- `activationEvents: ["onStartupFinished"]`：VS Code 启动完成后自动激活，无需用户手动触发

---

## 已知陷阱与历史问题

| 问题 | 原因 | 解决方案 |
|---|---|---|
| `Invalid argument 'uri'` | `vscode.Uri` 序列化后变成普通对象 | `tryDeserializeUri()` + `hoverAtPosition` action 直接用 active editor URI |
| Hover 返回 `{}` | `MarkdownString.value` 是 getter，`JSON.stringify` 无法序列化 | `summarizeResult()` 检测 Hover 数组形状，调用 `hoverContentsToText()` |
| `array type must have items` | VS Code JSON Schema 校验规则 | 在 `args` schema 中添加 `"items": {}` |
| `diagnostic.code` 类型错误 | 可能是 `string \| number \| {value} \| undefined` | 统一用 `String(rawCode)` 转换 |
| `@modelcontextprotocol/server` / `@modelcontextprotocol/node` 无法安装 | npm 实际发布的是旧单包 SDK | 改用 `@modelcontextprotocol/sdk@1.27.1` 的 v1 import path |
| v1 `setRequestHandler` 不接受方法字符串 | v1 SDK 仍要求 schema 常量 | 使用 `ListToolsRequestSchema` / `CallToolRequestSchema` |

---

## 扩展新工具的步骤

1. 在 `src/features/` 创建新文件，导出实现 `vscode.LanguageModelTool<T>` 的类
2. 在 `src/features/index.ts` 添加导出
3. 在 `src/extension.ts` 的 `activate()` 中调用 `vscode.lm.registerTool("tool_name", new MyTool())`
4. 在 `package.json` 的 `contributes.languageModelTools` 数组中添加工具描述（包含 `modelDescription`）
5. 更新 `.github/copilot-instructions.md` 说明何时自动调用新工具
6. `npm run compile` 验证
