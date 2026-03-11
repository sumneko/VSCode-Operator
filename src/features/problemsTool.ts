import * as vscode from "vscode";

export type ProblemItem = {
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

type ReadProblemsToolInput = {
  maxItems?: number;
};

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

export function collectProblems(): ProblemItem[] {
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

export class ReadProblemsTool implements vscode.LanguageModelTool<ReadProblemsToolInput> {
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
