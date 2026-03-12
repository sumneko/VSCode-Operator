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

export function activate(context: vscode.ExtensionContext): void {
  const mcpBridge = new LmToolsMcpBridgeServer();

  context.subscriptions.push(
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

  void mcpBridge.start();
}

export function deactivate(): void {
  // No long-running resources to dispose.
}
