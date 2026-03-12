# CodePilot VS Code Extension

A TypeScript VS Code extension that exposes native editor context as Language Model Tools, enabling Copilot Agent to autonomously operate VS Code (read diagnostics, query hover/LSP info, execute commands).

It also starts a local MCP bridge inside the Extension Host so external MCP clients can discover and call the currently registered VS Code language model tools.

> **For detailed architecture and design decisions, see [ARCHITECTURE.md](ARCHITECTURE.md).**

## Tools

| Tool | Reference name | Purpose |
|---|---|---|
| `codepilot_readProblems` | `readProblems` | Read all diagnostics from the Problems panel |
| `codepilot_runSupportedCommand` | `runSupportedCommand` | Optimized editor actions: `activeEditorSummary`, `hoverTopVisible`, `hoverAtPosition`, `completionAt` |
| `codepilot_executeCommand` | `executeCommand` | Execute any VS Code command by ID with automatic URI deserialization |

## MCP Bridge

- Default endpoint: `http://127.0.0.1:19191/mcp`
- Health check: `http://127.0.0.1:19191/health`
- Purpose: expose `vscode.lm.tools` over MCP `tools/list` and forward `tools/call` to `vscode.lm.invokeTool`
- Commands: `CodePilot: Show MCP Bridge Status`, `CodePilot: Restart MCP Bridge`
- Settings: `codepilot.mcpBridge.enabled`, `codepilot.mcpBridge.host`, `codepilot.mcpBridge.port`, `codepilot.mcpBridge.path`

## Development

```bash
npm install
npm run compile   # tsc -p ./ → dist/
npm run watch     # incremental compile during development
```

Press **F5** to launch an Extension Development Host. Copilot Agent can then invoke all three tools automatically based on context (see `.github/copilot-instructions.md`).

The local MCP bridge starts automatically on activation unless `codepilot.mcpBridge.enabled` is disabled.
