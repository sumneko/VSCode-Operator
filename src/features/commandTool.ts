import * as vscode from "vscode";

type SupportedAction = "hoverTopVisible" | "activeEditorSummary" | "hoverAtPosition";

type SupportedCommandToolInput = {
  action: SupportedAction;
  /** For hoverAtPosition: line number (1-based) */
  line?: number;
  /** For hoverAtPosition: column number (1-based) */
  column?: number;
};

type ExecuteCommandToolInput = {
  command: string;
  args?: unknown[];
  argsJson?: string;
};

function hoverContentsToText(hover: vscode.Hover): string {
  const parts = hover.contents.map((content) => {
    if (typeof content === "string") {
      return content;
    }

    if (content instanceof vscode.MarkdownString) {
      return content.value;
    }

    const maybeMarkedString = content as { language?: string; value?: string };
    if (typeof maybeMarkedString.value === "string") {
      return maybeMarkedString.language
        ? `(${maybeMarkedString.language})\n${maybeMarkedString.value}`
        : maybeMarkedString.value;
    }

    return String(content);
  });

  return parts.join("\n---\n").trim();
}

function summarizeResult(result: unknown): string {
  if (result === undefined) {
    return "Command executed successfully. The command did not return a value.";
  }

  if (typeof result === "string") {
    return result;
  }

  // vscode.Hover instances have a `contents` array of MarkdownString/MarkedString.
  // JSON.stringify cannot serialize MarkdownString getters, so we handle them explicitly.
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0] as Record<string, unknown>;
    if (first !== null && typeof first === "object" && Array.isArray(first["contents"])) {
      const texts = (result as vscode.Hover[])
        .map(hoverContentsToText)
        .filter((t) => t.length > 0);
      return texts.length > 0
        ? texts.join("\n\n")
        : "Hover results exist but all contents are empty.";
    }
  }

  try {
    const text = JSON.stringify(result, null, 2);
    const maxLen = 8000;
    if (text.length > maxLen) {
      return `${text.slice(0, maxLen)}\n... (truncated)`;
    }
    return text;
  } catch {
    return String(result);
  }
}

/**
 * Attempt to convert a plain value into a vscode.Uri when it looks like one.
 * Handles: URI strings ("file:///...") and plain objects with a `scheme` property.
 */
function tryDeserializeUri(value: unknown): unknown {
  if (typeof value === "string") {
    // file:// or other scheme URI strings
    if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(value)) {
      return vscode.Uri.parse(value);
    }
    // Absolute file paths (Windows or POSIX)
    if (/^[a-zA-Z]:[/\\]/.test(value) || value.startsWith("/")) {
      return vscode.Uri.file(value);
    }
    return value;
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // vscode.Uri-shaped object: must have scheme + (path or fsPath)
    if (typeof obj["scheme"] === "string" && (typeof obj["path"] === "string" || typeof obj["fsPath"] === "string")) {
      return vscode.Uri.from({
        scheme: obj["scheme"] as string,
        authority: typeof obj["authority"] === "string" ? obj["authority"] : undefined,
        path: (typeof obj["path"] === "string" ? obj["path"] : obj["fsPath"]) as string,
        query: typeof obj["query"] === "string" ? obj["query"] : undefined,
        fragment: typeof obj["fragment"] === "string" ? obj["fragment"] : undefined
      });
    }
    // Position-shaped object: { line, character }
    if (typeof obj["line"] === "number" && typeof obj["character"] === "number") {
      return new vscode.Position(obj["line"] as number, obj["character"] as number);
    }
  }

  return value;
}

function parseArgs(input: ExecuteCommandToolInput): unknown[] {
  let raw: unknown[];

  if (Array.isArray(input.args)) {
    raw = input.args;
  } else if (typeof input.argsJson === "string" && input.argsJson.trim().length > 0) {
    const parsed = JSON.parse(input.argsJson);
    if (!Array.isArray(parsed)) {
      throw new Error("argsJson must decode to a JSON array.");
    }
    raw = parsed;
  } else {
    return [];
  }

  return raw.map(tryDeserializeUri);
}

export class RunSupportedCommandTool implements vscode.LanguageModelTool<SupportedCommandToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<SupportedCommandToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const action = options.input.action;

    if (action === "activeEditorSummary") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart("No active text editor.")
        ]);
      }

      const selection = editor.selection.active;
      const summary = [
        `Active file: ${editor.document.uri.fsPath}`,
        `Language: ${editor.document.languageId}`,
        `Cursor: line ${selection.line + 1}, column ${selection.character + 1}`
      ].join("\n");

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(summary)
      ]);
    }

    if (action === "hoverTopVisible") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart("No active text editor.")
        ]);
      }

      const top = editor.visibleRanges[0]?.start ?? editor.selection.active;
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        editor.document.uri,
        top
      );

      if (!hovers || hovers.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `No hover information at line ${top.line + 1}, column ${top.character + 1}.`
          )
        ]);
      }

      const body = hovers.map(hoverContentsToText).filter((text) => text.length > 0).join("\n\n");
      const summary = [
        `Hover at top visible position in ${editor.document.uri.fsPath}`,
        `Location: line ${top.line + 1}, column ${top.character + 1}`,
        body.length > 0 ? body : "Hover content exists but is empty."
      ].join("\n\n");

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(summary)
      ]);
    }

    if (action === "hoverAtPosition") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart("No active text editor.")
        ]);
      }

      const line = typeof options.input.line === "number" ? options.input.line - 1 : 0;
      const col = typeof options.input.column === "number" ? options.input.column - 1 : 0;
      const position = new vscode.Position(Math.max(0, line), Math.max(0, col));

      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        editor.document.uri,
        position
      );

      if (!hovers || hovers.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `No hover information at line ${line + 1}, column ${col + 1}.`
          )
        ]);
      }

      const body = hovers.map(hoverContentsToText).filter((text) => text.length > 0).join("\n\n");
      const summary = [
        `Hover at line ${line + 1}, column ${col + 1} in ${editor.document.uri.fsPath}`,
        body.length > 0 ? body : "Hover content exists but is empty."
      ].join("\n\n");

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(summary)
      ]);
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`Unsupported action: ${action}`)
    ]);
  }
}

export class ExecuteCommandTool implements vscode.LanguageModelTool<ExecuteCommandToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ExecuteCommandToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const { command } = options.input;
    if (!command || typeof command !== "string") {
      throw new Error("command is required.");
    }

    const args = parseArgs(options.input);
    const result = await vscode.commands.executeCommand(command, ...args);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(summarizeResult(result))
    ]);
  }
}
