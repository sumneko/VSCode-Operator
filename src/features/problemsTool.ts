import * as vscode from "vscode";
import * as path from "node:path";

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
  minSeverity?: string;
  severity?: string;
  pathGlob?: string | string[];
};

type SeverityName = ProblemItem["severity"];

const SEVERITY_RANK: Record<SeverityName, number> = {
  error: 4,
  warning: 3,
  information: 2,
  hint: 1
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
  return collectProblemsWithFilters();
}

function normalizeSeverity(value: unknown): SeverityName {
  if (typeof value !== "string") {
    return "warning";
  }

  switch (value.trim().toLowerCase()) {
    case "error":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    case "information":
    case "info":
      return "information";
    case "hint":
      return "hint";
    default:
      return "warning";
  }
}

function toUnixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(globPattern: string): RegExp {
  const pattern = toUnixPath(globPattern);
  let regex = "^";

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === "*") {
      const isDoubleStar = pattern[i + 1] === "*";
      if (isDoubleStar) {
        regex += ".*";
        i++;
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (ch === "?") {
      regex += "[^/]";
      continue;
    }

    regex += escapeRegex(ch);
  }

  regex += "$";
  return new RegExp(regex);
}

function isAbsolutePattern(globPattern: string): boolean {
  return path.isAbsolute(globPattern) || /^[a-zA-Z]:[\\/]/.test(globPattern);
}

type CompiledPattern = {
  absolute: boolean;
  matcher: RegExp;
};

function toGlobPatterns(pathGlob: string | string[] | undefined): string[] {
  const splitPatterns = (value: string): string[] => value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (typeof pathGlob === "string") {
    return splitPatterns(pathGlob);
  }

  if (Array.isArray(pathGlob)) {
    return pathGlob
      .filter((item): item is string => typeof item === "string")
      .flatMap((item) => splitPatterns(item));
  }

  return [];
}

function compilePattern(globPattern: string): CompiledPattern {
  return {
    absolute: isAbsolutePattern(globPattern),
    matcher: globToRegExp(globPattern)
  };
}

function matchCompiledPattern(compiled: CompiledPattern, uri: vscode.Uri): boolean {
  const filePath = uri.fsPath;
  if (!filePath) {
    return false;
  }

  if (compiled.absolute) {
    return compiled.matcher.test(toUnixPath(path.normalize(filePath)));
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return false;
  }

  const relative = path.relative(workspaceFolder.uri.fsPath, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  return compiled.matcher.test(toUnixPath(relative));
}

function createPathMatcher(pathGlob: string | string[] | undefined): ((uri: vscode.Uri) => boolean) | undefined {
  const patterns = toGlobPatterns(pathGlob);
  if (patterns.length === 0) {
    return undefined;
  }

  const includePatterns: CompiledPattern[] = [];
  const excludePatterns: CompiledPattern[] = [];

  for (const rawPattern of patterns) {
    if (rawPattern.startsWith("!") && rawPattern.length > 1) {
      excludePatterns.push(compilePattern(rawPattern.slice(1)));
      continue;
    }
    includePatterns.push(compilePattern(rawPattern));
  }

  return (uri: vscode.Uri): boolean => {
    const included = includePatterns.length === 0 || includePatterns.some((compiled) => matchCompiledPattern(compiled, uri));
    if (!included) {
      return false;
    }

    const excluded = excludePatterns.some((compiled) => matchCompiledPattern(compiled, uri));
    return !excluded;
  };
}

function collectProblemsWithFilters(filters?: {
  minSeverity?: SeverityName;
  pathGlob?: string | string[];
}): ProblemItem[] {
  const minSeverity = filters?.minSeverity ?? "warning";
  const minRank = SEVERITY_RANK[minSeverity];
  const pathMatcher = createPathMatcher(filters?.pathGlob);

  const entries = vscode.languages.getDiagnostics();
  const problems: ProblemItem[] = [];

  for (const [uri, diagnostics] of entries) {
    if (pathMatcher && !pathMatcher(uri)) {
      continue;
    }

    for (const diagnostic of diagnostics) {
      const severity = toSeverity(diagnostic.severity);
      if (SEVERITY_RANK[severity] < minRank) {
        continue;
      }

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
        severity,
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

    const minSeverity = normalizeSeverity(options.input.minSeverity ?? options.input.severity);
    const pathGlob = options.input.pathGlob;

    const all = collectProblemsWithFilters({ minSeverity, pathGlob });
    const items = all.slice(0, maxItems);
    const payload = {
      filter: {
        minSeverity,
        pathGlob: pathGlob ?? null
      },
      total: all.length,
      returned: items.length,
      items
    };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))
    ]);
  }
}
