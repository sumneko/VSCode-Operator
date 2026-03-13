# VSCode Operator Architecture

This document summarizes the current architecture and implementation details for maintainers and AI contributors.

## Project Scope

VSCode Operator is a VS Code extension that exposes editor and debugger capabilities through `vscode.lm.registerTool`.

The extension also hosts a local MCP server stack in-process:

- `McpProxyServer` routes requests across workspaces
- `LmToolsMcpBridgeServer` exposes current `vscode.lm.tools`

This is not a sidecar process. All tool execution stays in the Extension Host so tools can read live VS Code state.

## Repository Layout

```text
src/
   extension.ts            # activation and tool registration
   features/
      commandTool.ts        # editor/context command tools
      problemsTool.ts       # diagnostics tool (severity/path filtering)
      debugTool.ts          # debugger control + inspection tools
      index.ts              # feature exports
   mcp/
      proxyServer.ts        # fixed-port proxy (19191 by default)
      bridgeServer.ts       # workspace-local MCP bridge (port+1, port+2...)
package.json              # contributes.languageModelTools + config/commands
README.md                 # user-facing docs
```

## Tool Surface

### Core editor tools

- `vscodeOperator_readProblems`
- `vscodeOperator_activeEditorSummary`
- `vscodeOperator_hoverTopVisible`
- `vscodeOperator_hoverAtPosition`
- `vscodeOperator_completionAt`
- `vscodeOperator_executeCommand`

### Debugger tools

- `vscodeOperator_debugStart`
- `vscodeOperator_debugSetBreakpoints`
- `vscodeOperator_debugClearBreakpoints`
- `vscodeOperator_debugControl`
- `vscodeOperator_debugGetThreads`
- `vscodeOperator_debugGetTopFrame`
- `vscodeOperator_debugGetStackTrace`
- `vscodeOperator_debugGetScopes`
- `vscodeOperator_debugGetVariables`
- `vscodeOperator_debugEvaluate`
- `vscodeOperator_debugSnapshot`
- `vscodeOperator_debugStatus`

## Diagnostics Tool Notes

`vscodeOperator_readProblems` supports:

- `minSeverity` (default `warning`, meaning warning + error)
- `pathGlob` filter with glob syntax
- absolute and workspace-relative globs
- comma-separated string patterns and string-array patterns
- exclusion patterns prefixed with `!`

## Debugger Tool Design

Implementation file: `src/features/debugTool.ts`

Key decisions:

- Use stable `vscode.debug` APIs plus DAP `customRequest(...)` for `threads/stackTrace/scopes/variables/evaluate`
- Do not rely on `vscode.debug.sessions` (not present in current type definitions)
- Maintain a session registry via:
   - `vscode.debug.onDidStartDebugSession`
   - `vscode.debug.onDidTerminateDebugSession`
   - fallback to `vscode.debug.activeDebugSession`

## Low-Roundtrip Strategy

To reduce AI request count during paused debugging, prefer:

1. `vscodeOperator_debugSnapshot`
2. then optional targeted follow-ups (`debugControl`, `debugEvaluate`)

`debugSnapshot` packs into one call:

- top frame
- selected scopes
- variables per scope (bounded by input limits)
- optional batch expression evaluation

This replaces typical multi-call chains (`threads -> stackTrace -> scopes -> variables -> evaluate`).

## MCP Architecture

### Proxy (`src/mcp/proxyServer.ts`)

- Binds to `127.0.0.1:<port>` (default `19191`)
- Receives bridge registrations via `/bridge-channel`
- Routes `/mcp` requests by session, `workspacePath`, or fallback strategy
- Exposes health endpoint `/health`

### Bridge (`src/mcp/bridgeServer.ts`)

- Each VS Code window starts a bridge on an auto-selected port (`port+1` and up)
- Registers itself to proxy through a persistent SSE channel
- Exposes MCP at configured path (default `/mcp`)
- Converts VS Code tool results into MCP response content

### Why HTTP bridge

- Extension Host is not launched as a stdio MCP server process
- Local HTTP keeps integration simple for external MCP clients
- Still runs in-process for direct access to VS Code APIs

## Configuration and Commands

Settings:

- `vscodeOperator.mcpBridge.enabled`
- `vscodeOperator.mcpBridge.host`
- `vscodeOperator.mcpBridge.port`
- `vscodeOperator.mcpBridge.path`

Commands:

- `vscodeOperator.mcpBridge.showStatus`
- `vscodeOperator.mcpBridge.restart`

## Development

```bash
npm install
npm run compile
npm run watch
```

- Press `F5` to launch Extension Development Host
- Entry point is `src/extension.ts`
- Compiled output is `dist/`

## Known Pitfalls

- URI arguments may lose type over JSON boundaries; deserialize where needed
- `MarkdownString` hover content does not stringify directly; extract text explicitly
- JSON schema arrays in tool definitions must include `items`
- Use schema constants for MCP SDK v1 request handlers
