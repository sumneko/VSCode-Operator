# VSCode Operator

A TypeScript VS Code extension that exposes native editor context as Language Model Tools, enabling Copilot Agent to autonomously operate VS Code (read diagnostics, query hover/LSP info, execute commands).

It also starts a local MCP bridge inside the Extension Host so external MCP clients can discover and call the currently registered VS Code language model tools.

## Simple Intro (For Marketplace)

VSCode Operator connects AI assistants to real VS Code context.
It exposes diagnostics, hover/completion capabilities, and command execution as tools, and provides a built-in local MCP bridge so external MCP clients can discover and call the same toolset in your live editor session.

> **For detailed architecture and design decisions, see [ARCHITECTURE.md](ARCHITECTURE.md).**

## Tools

| Tool | Reference name | Purpose |
|---|---|---|
| `vscodeOperator_readProblems` | `readProblems` | Read all diagnostics from the Problems panel |
| `vscodeOperator_activeEditorSummary` | `activeEditorSummary` | Get active editor file/language/cursor summary |
| `vscodeOperator_hoverTopVisible` | `hoverTopVisible` | Get hover info at top visible position |
| `vscodeOperator_hoverAtPosition` | `hoverAtPosition` | Get hover info at a specific line/column |
| `vscodeOperator_completionAt` | `completionAt` | Get completion candidates at a specific line/column |
| `vscodeOperator_executeCommand` | `executeCommand` | Execute any VS Code command by ID with automatic URI deserialization |

## MCP Bridge

- Default endpoint: `http://127.0.0.1:19191/mcp`
- Health check: `http://127.0.0.1:19191/health`
- Purpose: expose `vscode.lm.tools` over MCP `tools/list` and forward `tools/call` to `vscode.lm.invokeTool`
- Commands: `VSCode Operator: Show MCP Bridge Status`, `VSCode Operator: Restart MCP Bridge`
- Settings: `vscodeOperator.mcpBridge.enabled`, `vscodeOperator.mcpBridge.host`, `vscodeOperator.mcpBridge.port`, `vscodeOperator.mcpBridge.path`

### Customize MCP Port

Default MCP port is `19191`. Users can change it in settings.

```json
{
	"vscodeOperator.mcpBridge.port": 20191
}
```

## Development

```bash
npm install
npm run compile   # tsc -p ./ → dist/
npm run watch     # incremental compile during development
```

Press **F5** to launch an Extension Development Host. Copilot Agent can then invoke all three tools automatically based on context (see `.github/copilot-instructions.md`).

The local MCP bridge starts automatically on activation unless `vscodeOperator.mcpBridge.enabled` is disabled.
