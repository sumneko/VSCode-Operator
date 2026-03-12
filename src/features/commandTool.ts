import * as vscode from "vscode";

type ActiveEditorSummaryToolInput = Record<string, never>;
type HoverTopVisibleToolInput = Record<string, never>;

type HoverAtPositionToolInput = {
  /** 1-based line number */
  line?: number;
  /** 1-based column number */
  column?: number;
};

type CompletionAtToolInput = {
  /** 1-based line number */
  line?: number;
  /** 1-based column number */
  column?: number;
  /** Optional trigger character (e.g. ":" or ".") */
  triggerCharacter?: string;
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

async function resolveTargetDocument(): Promise<vscode.TextDocument | undefined> {
  return vscode.window.activeTextEditor?.document;
}

function getPosition(document: vscode.TextDocument, input: { line: number; column: number }): vscode.Position {
  const inputLine = input.line! - 1;
  const inputCol = input.column! - 1;

  const line = Math.max(0, Math.min(inputLine, Math.max(0, document.lineCount - 1)));
  const maxChar = document.lineAt(line).text.length;
  const character = Math.max(0, Math.min(inputCol, maxChar));

  return new vscode.Position(line, character);
}

function getUnsupportedInputKeys(input: Record<string, unknown>, allowed: string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(input).filter((key) => !allowedSet.has(key));
}

function buildInputValidationError(toolName: string, details: string): string {
  return [
    `Invalid input for ${toolName}: ${details}`,
    "Use exact parameter names from tools/list inputSchema.",
    "If unsure, read resource vscode-operator://usage."
  ].join(" ");
}

function validateNoFields(toolName: string, input: Record<string, unknown>): string | undefined {
  const unsupportedKeys = getUnsupportedInputKeys(input, []);
  if (unsupportedKeys.length > 0) {
    return buildInputValidationError(toolName, `unsupported fields: ${unsupportedKeys.join(", ")}.`);
  }

  return undefined;
}

function validatePositionInput(
  toolName: string,
  input: Record<string, unknown>,
  allowTriggerCharacter: boolean
): string | undefined {
  const allowed = allowTriggerCharacter ? ["line", "column", "triggerCharacter"] : ["line", "column"];
  const unsupportedKeys = getUnsupportedInputKeys(input, allowed);
  if (unsupportedKeys.length > 0) {
    return buildInputValidationError(toolName, `unsupported fields: ${unsupportedKeys.join(", ")}.`);
  }

  const line = input["line"];
  const column = input["column"];
  if (!Number.isInteger(line) || (line as number) < 1) {
    return buildInputValidationError(toolName, "line must be an integer >= 1.");
  }
  if (!Number.isInteger(column) || (column as number) < 1) {
    return buildInputValidationError(toolName, "column must be an integer >= 1.");
  }

  if (allowTriggerCharacter && input["triggerCharacter"] !== undefined) {
    const triggerCharacter = input["triggerCharacter"];
    if (typeof triggerCharacter !== "string" || triggerCharacter.length === 0) {
      return buildInputValidationError(toolName, "triggerCharacter must be a non-empty string when provided.");
    }
  }

  return undefined;
}

export class ActiveEditorSummaryTool implements vscode.LanguageModelTool<ActiveEditorSummaryToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ActiveEditorSummaryToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const validationError = validateNoFields("vscodeOperator_activeEditorSummary", options.input as Record<string, unknown>);
    if (validationError) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(validationError)
      ]);
    }

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
}

export class HoverTopVisibleTool implements vscode.LanguageModelTool<HoverTopVisibleToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<HoverTopVisibleToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const validationError = validateNoFields("vscodeOperator_hoverTopVisible", options.input as Record<string, unknown>);
    if (validationError) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(validationError)
      ]);
    }

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
}

export class HoverAtPositionTool implements vscode.LanguageModelTool<HoverAtPositionToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<HoverAtPositionToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const validationError = validatePositionInput(
      "vscodeOperator_hoverAtPosition",
      options.input as Record<string, unknown>,
      false
    );
    if (validationError) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(validationError)
      ]);
    }

    const document = await resolveTargetDocument();
    if (!document) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("No active text editor.")
      ]);
    }

    const input = options.input as HoverAtPositionToolInput & { line: number; column: number };
    const position = getPosition(document, input);

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      position
    );

    if (!hovers || hovers.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `No hover information at line ${position.line + 1}, column ${position.character + 1}.`
        )
      ]);
    }

    const body = hovers.map(hoverContentsToText).filter((text) => text.length > 0).join("\n\n");
    const summary = [
      `Hover at line ${position.line + 1}, column ${position.character + 1} in ${document.uri.fsPath}`,
      body.length > 0 ? body : "Hover content exists but is empty."
    ].join("\n\n");

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(summary)
    ]);
  }
}

export class CompletionAtTool implements vscode.LanguageModelTool<CompletionAtToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CompletionAtToolInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const validationError = validatePositionInput(
      "vscodeOperator_completionAt",
      options.input as Record<string, unknown>,
      true
    );
    if (validationError) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(validationError)
      ]);
    }

    const document = await resolveTargetDocument();
    if (!document) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart("No active text editor.")
      ]);
    }

    const input = options.input as CompletionAtToolInput & { line: number; column: number };
    const position = getPosition(document, input);

    const completionList = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      document.uri,
      position,
      options.input.triggerCharacter
    );

    if (!completionList || completionList.items.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `No completions at line ${position.line + 1}, column ${position.character + 1}.`
        )
      ]);
    }

    const kindLabel = (kind?: vscode.CompletionItemKind): string => {
      const map: Partial<Record<vscode.CompletionItemKind, string>> = {
        [vscode.CompletionItemKind.Method]: "method",
        [vscode.CompletionItemKind.Function]: "function",
        [vscode.CompletionItemKind.Field]: "field",
        [vscode.CompletionItemKind.Property]: "property",
        [vscode.CompletionItemKind.Variable]: "variable",
        [vscode.CompletionItemKind.Class]: "class",
        [vscode.CompletionItemKind.Interface]: "interface",
        [vscode.CompletionItemKind.Constant]: "constant",
        [vscode.CompletionItemKind.Enum]: "enum",
        [vscode.CompletionItemKind.EnumMember]: "enum member"
      };
      return kind !== undefined ? (map[kind] ?? "item") : "item";
    };

    const docText = (item: vscode.CompletionItem): string => {
      if (!item.documentation) return "";
      if (item.documentation instanceof vscode.MarkdownString) return item.documentation.value;
      return String(item.documentation);
    };

    const maxItems = 200;
    const items = completionList.items.slice(0, maxItems);
    const lines = items.map((item) => {
      const label = typeof item.label === "string" ? item.label : item.label.label;
      const detail = typeof item.label === "object" && item.label.detail
        ? item.label.detail
        : (item.detail ?? "");
      const kind = kindLabel(item.kind);
      const doc = docText(item);
      const parts = [`- ${label} (${kind})`];
      if (detail) parts.push(detail);
      if (doc) parts.push(`// ${doc.split("\n")[0]}`);
      return parts.join("  ");
    });

    const total = completionList.items.length;
    const header = [
      `Completions at line ${position.line + 1}, column ${position.character + 1} in ${document.uri.fsPath}`,
      total > maxItems ? `(showing ${maxItems} of ${total} items)` : `(${total} items)`
    ].join(" ");

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart([header, ...lines].join("\n"))
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
