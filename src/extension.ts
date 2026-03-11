import * as path from "node:path";
import { ChildProcess, fork } from "node:child_process";
import * as vscode from "vscode";

let mcpProcess: ChildProcess | undefined;

function getServerEntry(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "dist", "mcp", "server.js");
}

function startMcpServer(context: vscode.ExtensionContext): void {
  if (mcpProcess && !mcpProcess.killed) {
    void vscode.window.showInformationMessage("MCP server is already running.");
    return;
  }

  const serverPath = getServerEntry(context);
  mcpProcess = fork(serverPath, [], {
    stdio: "pipe"
  });

  mcpProcess.on("error", (err) => {
    void vscode.window.showErrorMessage(`Failed to start MCP server: ${err.message}`);
  });

  mcpProcess.on("exit", (code) => {
    mcpProcess = undefined;
    const detail = code === null ? "terminated" : `exited with code ${code}`;
    void vscode.window.showInformationMessage(`MCP server ${detail}.`);
  });

  void vscode.window.showInformationMessage("MCP server started.");
}

function stopMcpServer(): void {
  if (!mcpProcess || mcpProcess.killed) {
    void vscode.window.showInformationMessage("MCP server is not running.");
    return;
  }

  mcpProcess.kill();
  mcpProcess = undefined;
  void vscode.window.showInformationMessage("MCP server stopped.");
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("codepilot.startMcpServer", () => startMcpServer(context)),
    vscode.commands.registerCommand("codepilot.stopMcpServer", stopMcpServer),
    {
      dispose: () => stopMcpServer()
    }
  );
}

export function deactivate(): void {
  stopMcpServer();
}
