import * as path from "node:path";
import { ChildProcess, fork } from "node:child_process";
import * as vscode from "vscode";

let mcpProcess: ChildProcess | undefined;

type ReadProblemsRequest = {
  type: "readProblemsRequest";
  requestId: string;
};

type ProblemItem = {
  file: string;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
  code?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

type ReadProblemsResponse = {
  type: "readProblemsResponse";
  requestId: string;
  problems: ProblemItem[];
};

type ReadProblemsToolInput = {
  maxItems?: number;
};

class ReadProblemsTool implements vscode.LanguageModelTool<ReadProblemsToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReadProblemsToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const maxItemsRaw = options.input.maxItems;
    const maxItems = typeof maxItemsRaw === "number"
      ? Math.max(1, Math.min(500, Math.trunc(maxItemsRaw)))
      : 200;

    const all = collectProblems();
    const items = all.slice(0, maxItems);
    const payload = {
      total: all.length,
      returned: items.length,
      items
    };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))
    ]);
  }
}

function toSeverity(severity: vscode.DiagnosticSeverity): ProblemItem["severity"] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    default:
      return "hint";
  }
}

function collectProblems(): ProblemItem[] {
  const entries = vscode.languages.getDiagnostics();
  const problems: ProblemItem[] = [];

  for (const [uri, diagnostics] of entries) {
    for (const diagnostic of diagnostics) {
      const rawCode = typeof diagnostic.code === "string"
        ? diagnostic.code
        : typeof diagnostic.code === "number"
          ? diagnostic.code
          : typeof diagnostic.code === "object"
            ? diagnostic.code.value
            : undefined;
      const code = rawCode === undefined ? undefined : String(rawCode);

      problems.push({
        file: uri.fsPath,
        severity: toSeverity(diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source,
        code,
        startLine: diagnostic.range.start.line + 1,
        startColumn: diagnostic.range.start.character + 1,
        endLine: diagnostic.range.end.line + 1,
        endColumn: diagnostic.range.end.character + 1
      });
    }
  }

  return problems;
}

function registerMcpBridge(processRef: ChildProcess): void {
  processRef.on("message", (raw) => {
    const message = raw as ReadProblemsRequest;
    if (!message || message.type !== "readProblemsRequest") {
      return;
    }

    const response: ReadProblemsResponse = {
      type: "readProblemsResponse",
      requestId: message.requestId,
      problems: collectProblems()
    };

    processRef.send?.(response);
  });
}

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

  registerMcpBridge(mcpProcess);

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
    vscode.lm.registerTool("codepilot_readProblems", new ReadProblemsTool()),
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
