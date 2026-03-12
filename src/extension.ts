import * as vscode from "vscode";
import { ExecuteCommandTool, ReadProblemsTool, RunSupportedCommandTool } from "./features";
import { LmToolsMcpBridgeServer } from "./mcp/bridgeServer";

export function activate(context: vscode.ExtensionContext): void {
  const mcpBridge = new LmToolsMcpBridgeServer();

  context.subscriptions.push(
    mcpBridge,
    vscode.lm.registerTool("codepilot_readProblems", new ReadProblemsTool()),
    vscode.lm.registerTool("codepilot_runSupportedCommand", new RunSupportedCommandTool()),
    vscode.lm.registerTool("codepilot_executeCommand", new ExecuteCommandTool()),
    vscode.commands.registerCommand("codepilot.mcpBridge.showStatus", async () => {
      await vscode.window.showInformationMessage(mcpBridge.getStatus());
    }),
    vscode.commands.registerCommand("codepilot.mcpBridge.restart", async () => {
      await mcpBridge.restart();
      await vscode.window.showInformationMessage(mcpBridge.getStatus());
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codepilot.mcpBridge")) {
        void mcpBridge.reloadFromConfiguration();
      }
    })
  );

  void mcpBridge.start();
}

export function deactivate(): void {
  // No long-running resources to dispose.
}
