import * as vscode from "vscode";
import { ExecuteCommandTool, ReadProblemsTool, RunSupportedCommandTool } from "./features";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.lm.registerTool("codepilot_readProblems", new ReadProblemsTool()),
    vscode.lm.registerTool("codepilot_runSupportedCommand", new RunSupportedCommandTool()),
    vscode.lm.registerTool("codepilot_executeCommand", new ExecuteCommandTool())
  );
}

export function deactivate(): void {
  // No long-running resources to dispose.
}
