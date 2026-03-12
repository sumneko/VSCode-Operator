import * as vscode from "vscode";
import {
  ActiveEditorSummaryTool,
  CompletionAtTool,
  ExecuteCommandTool,
  HoverAtPositionTool,
  HoverTopVisibleTool,
  ReadProblemsTool
} from "./features";
import { LmToolsMcpBridgeServer } from "./mcp/bridgeServer";
import { McpProxyServer } from "./mcp/proxyServer";

export function activate(context: vscode.ExtensionContext): void {
  const mcpProxy = new McpProxyServer();
  const mcpBridge = new LmToolsMcpBridgeServer();

  context.subscriptions.push(
    mcpProxy,
    mcpBridge,
    vscode.lm.registerTool("vscodeOperator_readProblems", new ReadProblemsTool()),
    vscode.lm.registerTool("vscodeOperator_activeEditorSummary", new ActiveEditorSummaryTool()),
    vscode.lm.registerTool("vscodeOperator_hoverTopVisible", new HoverTopVisibleTool()),
    vscode.lm.registerTool("vscodeOperator_hoverAtPosition", new HoverAtPositionTool()),
    vscode.lm.registerTool("vscodeOperator_completionAt", new CompletionAtTool()),
    vscode.lm.registerTool("vscodeOperator_executeCommand", new ExecuteCommandTool()),
    vscode.commands.registerCommand("vscodeOperator.mcpBridge.showStatus", async () => {
      await vscode.window.showInformationMessage(mcpBridge.getStatus());
    }),
    vscode.commands.registerCommand("vscodeOperator.mcpBridge.restart", async () => {
      await mcpBridge.restart();
      await vscode.window.showInformationMessage(mcpBridge.getStatus());
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("vscodeOperator.mcpBridge")) {
        void mcpBridge.reloadFromConfiguration();
      }
    })
  );

  // Start proxy first (if port is occupied another instance is acting as proxy, that's OK),
  // then always start the bridge regardless of proxy outcome.
  void mcpProxy.start().finally(() => mcpBridge.start());
}

export function deactivate(): void {
  // No long-running resources to dispose.
}
