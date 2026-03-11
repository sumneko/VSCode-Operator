import * as vscode from "vscode";
import { ReadProblemsTool } from "./features";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.lm.registerTool("codepilot_readProblems", new ReadProblemsTool())
  );
}

export function deactivate(): void {
  // No long-running resources to dispose.
}
