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

### Architecture

VSCode Operator uses a **proxy + bridge architecture** to support multiple VS Code workspaces simultaneously:

- **Proxy Server**: Listens on fixed port `19191`, routes MCP requests to appropriate workspace bridges based on `workspacePath` parameter
- **Bridge Server**: Each VS Code instance runs its own bridge (auto-assigned port 19192+), queries its local tools and registers with the proxy

### Endpoints & Configuration

- **Proxy endpoint**: `http://127.0.0.1:19191/mcp` (stable, connect here)
- **Bridge registers at**: Each bridge auto-discovers an available port and registers with the proxy
- **Health check**: `http://127.0.0.1:19191/health`
- **Commands**: `VSCode Operator: Show MCP Bridge Status`, `VSCode Operator: Restart MCP Bridge`
- **Settings**: `vscodeOperator.mcpBridge.enabled`, `vscodeOperator.mcpBridge.host`, `vscodeOperator.mcpBridge.port`, `vscodeOperator.mcpBridge.path`

### Multi-Workspace Usage

When multiple VS Code instances are running:

1. Each runs its own MCP bridge server (auto-assigned port 19192+)
2. All bridges register with the central proxy on port 19191
3. MCP clients connect to the proxy endpoint: `http://127.0.0.1:19191/mcp`
4. Include `workspacePath` parameter in tool calls to route to correct bridge:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "vscodeOperator_hoverAtPosition",
    "arguments": {
      "workspacePath": "/absolute/path/to/projectA",
      "line": 10,
      "column": 5
    }
  }
}
```

### Customize Proxy Port

Default proxy port is `19191`. To change it:

```json
{
  "vscodeOperator.mcpBridge.port": 20191
}
```

Note: Only the **first instance** uses the configured port. Additional instances auto-increment (19192, 19193, etc.).

## Development

```bash
npm install
npm run compile   # tsc -p ./ → dist/
npm run watch     # incremental compile during development
```

Press **F5** to launch an Extension Development Host. Copilot Agent can then invoke all three tools automatically based on context (see `.github/copilot-instructions.md`).

The local MCP bridge starts automatically on activation unless `vscodeOperator.mcpBridge.enabled` is disabled.
