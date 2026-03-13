import * as path from "node:path";
import * as vscode from "vscode";

type JsonObject = Record<string, unknown>;

type DebugStartInput = {
  name?: string;
  configuration?: JsonObject;
  workspacePath?: string;
  noDebug?: boolean;
};

type DebugSetBreakpointsInput = {
  filePath?: string;
  workspacePath?: string;
  lines?: number[];
  enabled?: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  clearExistingInFile?: boolean;
};

type DebugControlAction = "continue" | "stepOver" | "stepInto" | "stepOut" | "pause" | "restart" | "stop";

type DebugControlInput = {
  action?: DebugControlAction;
  sessionId?: string;
  threadId?: number;
};

type DebugClearBreakpointsInput = {
  filePath?: string;
  workspacePath?: string;
  all?: boolean;
};

type DebugGetThreadsInput = {
  sessionId?: string;
};

type DebugGetStackTraceInput = {
  sessionId?: string;
  threadId?: number;
  startFrame?: number;
  levels?: number;
};

type DebugGetScopesInput = {
  sessionId?: string;
  frameId?: number;
};

type DebugGetVariablesInput = {
  sessionId?: string;
  variablesReference?: number;
  start?: number;
  count?: number;
};

type DebugEvaluateInput = {
  sessionId?: string;
  expression?: string;
  frameId?: number;
  context?: string;
};

type DebugGetTopFrameInput = {
  sessionId?: string;
  threadId?: number;
};

type DebugSnapshotInput = {
  sessionId?: string;
  threadId?: number;
  maxScopes?: number;
  maxVariablesPerScope?: number;
  evaluateExpressions?: string[];
  evaluateContext?: string;
};

type DebugStatusInput = {
  sessionId?: string;
};

type DapThread = {
  id: number;
  name?: string;
};

const knownSessions = new Map<string, vscode.DebugSession>();
let sessionTrackingInitialized = false;

function ensureSessionTracking(): void {
  if (sessionTrackingInitialized) {
    return;
  }

  sessionTrackingInitialized = true;
  vscode.debug.onDidStartDebugSession((session) => {
    knownSessions.set(session.id, session);
  });
  vscode.debug.onDidTerminateDebugSession((session) => {
    knownSessions.delete(session.id);
  });
}

function getKnownSessions(): vscode.DebugSession[] {
  ensureSessionTracking();
  const active = vscode.debug.activeDebugSession;
  if (active) {
    knownSessions.set(active.id, active);
  }
  return [...knownSessions.values()];
}

function toResult(payload: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))
  ]);
}

function toError(message: string): vscode.LanguageModelToolResult {
  return toResult({ error: message });
}

function dapHintText(): string {
  return [
    "DAP hint:",
    "threadId <- debugGetThreads/debugGetTopFrame/debugSnapshot;",
    "frameId <- debugGetTopFrame/debugGetStackTrace;",
    "variablesReference <- debugGetScopes;",
    "if no frame exists, call debugControl(action='pause') first."
  ].join(" ");
}

function normalizeForCompare(value: string): string {
  const trimmed = value.trim();
  if (/^[a-zA-Z]:/.test(trimmed)) {
    return path.win32.normalize(trimmed.replace(/\//g, "\\")).toLowerCase();
  }
  return path.posix.normalize(trimmed.replace(/\\/g, "/"));
}

function resolveWorkspaceFolder(workspacePath?: string): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!workspacePath || workspacePath.trim().length === 0) {
    return folders[0];
  }

  const target = normalizeForCompare(workspacePath);
  return folders.find((folder) => normalizeForCompare(folder.uri.fsPath) === target);
}

function resolveFilePath(filePath: string, workspacePath?: string): string {
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath);
  }

  const folder = resolveWorkspaceFolder(workspacePath) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Relative filePath requires an open workspace. Provide an absolute path or workspacePath.");
  }

  return path.resolve(folder.uri.fsPath, filePath);
}

function resolveSession(sessionId?: string): vscode.DebugSession | undefined {
  const sessions = getKnownSessions();
  if (typeof sessionId === "string" && sessionId.trim().length > 0) {
    return sessions.find((s) => s.id === sessionId);
  }
  return vscode.debug.activeDebugSession ?? sessions[0];
}

async function customRequest(
  session: vscode.DebugSession,
  command: string,
  args?: JsonObject
): Promise<unknown> {
  try {
    return await session.customRequest(command, args);
  } catch (error) {
    throw new Error(`DAP request '${command}' failed: ${error instanceof Error ? error.message : String(error)} ${dapHintText()}`);
  }
}

async function getThreads(session: vscode.DebugSession): Promise<DapThread[]> {
  const response = await customRequest(session, "threads") as { threads?: unknown[] };
  const rawThreads = Array.isArray(response?.threads) ? response.threads : [];
  return rawThreads
    .map((item) => item as { id?: unknown; name?: unknown })
    .filter((item) => typeof item.id === "number")
    .map((item) => ({
      id: item.id as number,
      name: typeof item.name === "string" ? item.name : undefined
    }));
}

async function resolveThreadId(session: vscode.DebugSession, inputThreadId?: number): Promise<number> {
  if (typeof inputThreadId === "number" && Number.isInteger(inputThreadId) && inputThreadId > 0) {
    return inputThreadId;
  }

  const threads = await getThreads(session);
  if (threads.length === 0) {
    throw new Error(`No debug threads found in the active session. ${dapHintText()}`);
  }

  return threads[0].id;
}

function uniqueSortedPositiveIntegers(values: unknown): number[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const set = new Set<number>();
  for (const item of values) {
    if (typeof item === "number" && Number.isInteger(item) && item > 0) {
      set.add(item);
    }
  }

  return [...set].sort((a, b) => a - b);
}

function toDebugSessionSummary(session: vscode.DebugSession): JsonObject {
  return {
    id: session.id,
    name: session.name,
    type: session.type,
    workspaceFolder: session.workspaceFolder?.uri.fsPath ?? null
  };
}

export class DebugStartTool implements vscode.LanguageModelTool<DebugStartInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugStartInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const name = typeof input.name === "string" && input.name.trim().length > 0 ? input.name.trim() : undefined;
    const configuration = input.configuration && typeof input.configuration === "object"
      ? input.configuration as vscode.DebugConfiguration
      : undefined;

    if (!name && !configuration) {
      return toError("Provide either 'name' (launch config name) or 'configuration' (inline debug configuration). Tip: call vscodeOperator_debugStatus to inspect existing sessions first.");
    }

    const folder = resolveWorkspaceFolder(input.workspacePath);
    const started = name
      ? await vscode.debug.startDebugging(folder, name, { noDebug: Boolean(input.noDebug) })
      : await vscode.debug.startDebugging(folder, configuration!, { noDebug: Boolean(input.noDebug) });

    const active = vscode.debug.activeDebugSession;
    return toResult({
      started,
      activeSession: active ? toDebugSessionSummary(active) : null,
      sessions: getKnownSessions().map(toDebugSessionSummary)
    });
  }
}

export class DebugSetBreakpointsTool implements vscode.LanguageModelTool<DebugSetBreakpointsInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugSetBreakpointsInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    if (typeof input.filePath !== "string" || input.filePath.trim().length === 0) {
      return toError("filePath is required.");
    }

    const lines = uniqueSortedPositiveIntegers(input.lines);
    if (lines.length === 0) {
      return toError("lines must contain at least one positive integer line number (1-based).");
    }

    let resolved: string;
    try {
      resolved = resolveFilePath(input.filePath.trim(), input.workspacePath);
    } catch (error) {
      return toError(error instanceof Error ? error.message : String(error));
    }

    const uri = vscode.Uri.file(resolved);
    const clearExisting = Boolean(input.clearExistingInFile);
    if (clearExisting) {
      const existing = vscode.debug.breakpoints.filter((bp) => {
        if (!(bp instanceof vscode.SourceBreakpoint)) {
          return false;
        }
        return bp.location.uri.toString() === uri.toString();
      });
      if (existing.length > 0) {
        vscode.debug.removeBreakpoints(existing);
      }
    }

    const breakpoints = lines.map((line) => {
      const location = new vscode.Location(uri, new vscode.Position(line - 1, 0));
      return new vscode.SourceBreakpoint(
        location,
        input.enabled ?? true,
        input.condition,
        input.hitCondition,
        input.logMessage
      );
    });

    vscode.debug.addBreakpoints(breakpoints);

    return toResult({
      file: resolved,
      added: lines,
      clearExistingInFile: clearExisting,
      totalBreakpoints: vscode.debug.breakpoints.length
    });
  }
}

export class DebugControlTool implements vscode.LanguageModelTool<DebugControlInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugControlInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const action = input.action;
    if (!action) {
      return toError("action is required. Supported: continue, stepOver, stepInto, stepOut, pause, restart, stop.");
    }

    const session = resolveSession(input.sessionId);
    if (!session) {
      return toError("No debug session is active. Call vscodeOperator_debugStart first, or inspect existing sessions via vscodeOperator_debugStatus.");
    }

    if (action === "stop") {
      const stopped = await vscode.debug.stopDebugging(session);
      return toResult({ action, stopped, sessionId: session.id });
    }

    if (action === "restart") {
      await vscode.commands.executeCommand("workbench.action.debug.restart");
      return toResult({ action, ok: true, sessionId: session.id });
    }

    const commandMap: Record<Exclude<DebugControlAction, "restart" | "stop">, string> = {
      continue: "continue",
      stepOver: "next",
      stepInto: "stepIn",
      stepOut: "stepOut",
      pause: "pause"
    };

    const threadId = await resolveThreadId(session, input.threadId);
    const dapCommand = commandMap[action as Exclude<DebugControlAction, "restart" | "stop">];
    await customRequest(session, dapCommand, { threadId });

    return toResult({
      action,
      dapCommand,
      sessionId: session.id,
      threadId,
      ok: true
    });
  }
}

export class DebugClearBreakpointsTool implements vscode.LanguageModelTool<DebugClearBreakpointsInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugClearBreakpointsInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const clearAll = Boolean(input.all);

    if (!clearAll && (typeof input.filePath !== "string" || input.filePath.trim().length === 0)) {
      return toError("Provide filePath to clear source breakpoints in one file, or set all=true to clear all breakpoints.");
    }

    let toRemove: vscode.Breakpoint[];
    if (clearAll) {
      toRemove = [...vscode.debug.breakpoints];
    } else {
      let resolved: string;
      try {
        resolved = resolveFilePath(input.filePath!.trim(), input.workspacePath);
      } catch (error) {
        return toError(error instanceof Error ? error.message : String(error));
      }

      const targetUri = vscode.Uri.file(resolved).toString();
      toRemove = vscode.debug.breakpoints.filter((bp) => {
        if (!(bp instanceof vscode.SourceBreakpoint)) {
          return false;
        }
        return bp.location.uri.toString() === targetUri;
      });
    }

    vscode.debug.removeBreakpoints(toRemove);

    return toResult({
      removed: toRemove.length,
      remaining: vscode.debug.breakpoints.length,
      mode: clearAll ? "all" : "file"
    });
  }
}

export class DebugGetThreadsTool implements vscode.LanguageModelTool<DebugGetThreadsInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugGetThreadsInput>): Promise<vscode.LanguageModelToolResult> {
    const session = resolveSession(options.input.sessionId);
    if (!session) {
      return toError("No debug session is active. Call vscodeOperator_debugStart first, or inspect existing sessions via vscodeOperator_debugStatus.");
    }

    const threads = await getThreads(session);
    return toResult({
      session: toDebugSessionSummary(session),
      total: threads.length,
      threads
    });
  }
}

export class DebugGetStackTraceTool implements vscode.LanguageModelTool<DebugGetStackTraceInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugGetStackTraceInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const session = resolveSession(input.sessionId);
    if (!session) {
      return toError("No debug session is active. Call vscodeOperator_debugStart first, or inspect existing sessions via vscodeOperator_debugStatus.");
    }

    const threadId = await resolveThreadId(session, input.threadId);
    const args: JsonObject = { threadId };
    if (typeof input.startFrame === "number" && Number.isInteger(input.startFrame) && input.startFrame >= 0) {
      args.startFrame = input.startFrame;
    }
    if (typeof input.levels === "number" && Number.isInteger(input.levels) && input.levels > 0) {
      args.levels = input.levels;
    }

    const response = await customRequest(session, "stackTrace", args);
    return toResult({
      session: toDebugSessionSummary(session),
      threadId,
      stackTrace: response
    });
  }
}

export class DebugGetScopesTool implements vscode.LanguageModelTool<DebugGetScopesInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugGetScopesInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const session = resolveSession(input.sessionId);
    if (!session) {
      return toError("No debug session is active. Call vscodeOperator_debugStart first, or inspect existing sessions via vscodeOperator_debugStatus.");
    }

    if (typeof input.frameId !== "number" || !Number.isInteger(input.frameId) || input.frameId < 0) {
      return toError("frameId is required and must be an integer >= 0. Tip: call vscodeOperator_debugGetTopFrame or vscodeOperator_debugGetStackTrace first.");
    }

    const response = await customRequest(session, "scopes", { frameId: input.frameId });
    return toResult({
      session: toDebugSessionSummary(session),
      frameId: input.frameId,
      scopes: response
    });
  }
}

export class DebugGetVariablesTool implements vscode.LanguageModelTool<DebugGetVariablesInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugGetVariablesInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const session = resolveSession(input.sessionId);
    if (!session) {
      return toError("No debug session is active. Call vscodeOperator_debugStart first, or inspect existing sessions via vscodeOperator_debugStatus.");
    }

    if (typeof input.variablesReference !== "number" || !Number.isInteger(input.variablesReference) || input.variablesReference <= 0) {
      return toError("variablesReference is required and must be an integer > 0. Tip: call vscodeOperator_debugGetScopes and use scopes[*].variablesReference.");
    }

    const args: JsonObject = { variablesReference: input.variablesReference };
    if (typeof input.start === "number" && Number.isInteger(input.start) && input.start >= 0) {
      args.start = input.start;
    }
    if (typeof input.count === "number" && Number.isInteger(input.count) && input.count > 0) {
      args.count = input.count;
    }

    const response = await customRequest(session, "variables", args);
    return toResult({
      session: toDebugSessionSummary(session),
      variablesReference: input.variablesReference,
      variables: response
    });
  }
}

export class DebugEvaluateTool implements vscode.LanguageModelTool<DebugEvaluateInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugEvaluateInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const session = resolveSession(input.sessionId);
    if (!session) {
      return toError("No debug session is active. Call vscodeOperator_debugStart first, or inspect existing sessions via vscodeOperator_debugStatus.");
    }

    if (typeof input.expression !== "string" || input.expression.trim().length === 0) {
      return toError("expression is required.");
    }

    const args: JsonObject = {
      expression: input.expression,
      context: typeof input.context === "string" && input.context.trim().length > 0 ? input.context : "watch"
    };
    if (typeof input.frameId === "number" && Number.isInteger(input.frameId) && input.frameId >= 0) {
      args.frameId = input.frameId;
    }

    const response = await customRequest(session, "evaluate", args);
    return toResult({
      session: toDebugSessionSummary(session),
      evaluate: response
    });
  }
}

export class DebugGetTopFrameTool implements vscode.LanguageModelTool<DebugGetTopFrameInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugGetTopFrameInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const session = resolveSession(input.sessionId);
    if (!session) {
      return toError("No debug session is active. Call vscodeOperator_debugStart first, or inspect existing sessions via vscodeOperator_debugStatus.");
    }

    const threadId = await resolveThreadId(session, input.threadId);
    const response = await customRequest(session, "stackTrace", { threadId, startFrame: 0, levels: 1 }) as {
      stackFrames?: unknown[];
      totalFrames?: number;
    };

    const frames = Array.isArray(response.stackFrames) ? response.stackFrames : [];
    const topFrame = frames.length > 0 ? frames[0] : null;

    return toResult({
      session: toDebugSessionSummary(session),
      threadId,
      topFrame,
      totalFrames: typeof response.totalFrames === "number" ? response.totalFrames : frames.length,
      paused: topFrame !== null
    });
  }
}

export class DebugSnapshotTool implements vscode.LanguageModelTool<DebugSnapshotInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugSnapshotInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const session = resolveSession(input.sessionId);
    if (!session) {
      return toError("No debug session is active. Call vscodeOperator_debugStart first, or inspect existing sessions via vscodeOperator_debugStatus.");
    }

    const threadId = await resolveThreadId(session, input.threadId);
    const stack = await customRequest(session, "stackTrace", { threadId, startFrame: 0, levels: 1 }) as {
      stackFrames?: Array<Record<string, unknown>>;
      totalFrames?: number;
    };

    const topFrame = Array.isArray(stack.stackFrames) && stack.stackFrames.length > 0
      ? stack.stackFrames[0]
      : null;
    const frameId = topFrame && typeof topFrame.id === "number" ? topFrame.id : undefined;

    if (frameId === undefined) {
      return toResult({
        session: toDebugSessionSummary(session),
        threadId,
        paused: false,
        topFrame: null,
        scopes: [],
        evaluations: [],
        note: "No top frame is available. The debugger may be running instead of paused. Use vscodeOperator_debugControl(action='pause') and retry, or continue to a breakpoint."
      });
    }

    const maxScopes = typeof input.maxScopes === "number"
      ? Math.max(1, Math.min(20, Math.trunc(input.maxScopes)))
      : 3;
    const maxVariablesPerScope = typeof input.maxVariablesPerScope === "number"
      ? Math.max(1, Math.min(200, Math.trunc(input.maxVariablesPerScope)))
      : 50;

    const scopesResponse = await customRequest(session, "scopes", { frameId }) as {
      scopes?: Array<Record<string, unknown>>;
    };
    const rawScopes = Array.isArray(scopesResponse.scopes) ? scopesResponse.scopes : [];
    const selectedScopes = rawScopes.slice(0, maxScopes);

    const scopes = await Promise.all(selectedScopes.map(async (scope) => {
      const variablesReference = typeof scope.variablesReference === "number" ? scope.variablesReference : 0;
      if (variablesReference <= 0) {
        return {
          scope,
          totalVariables: 0,
          variables: [] as Array<Record<string, unknown>>
        };
      }

      try {
        const variablesResponse = await customRequest(session, "variables", {
          variablesReference,
          start: 0,
          count: maxVariablesPerScope
        }) as {
          variables?: Array<Record<string, unknown>>;
        };

        const vars = Array.isArray(variablesResponse.variables) ? variablesResponse.variables : [];
        return {
          scope,
          totalVariables: vars.length,
          variables: vars
        };
      } catch (error) {
        return {
          scope,
          totalVariables: 0,
          variables: [] as Array<Record<string, unknown>>,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }));

    const expressions = Array.isArray(input.evaluateExpressions)
      ? input.evaluateExpressions.filter((expr): expr is string => typeof expr === "string" && expr.trim().length > 0)
      : [];

    const evaluateContext = typeof input.evaluateContext === "string" && input.evaluateContext.trim().length > 0
      ? input.evaluateContext
      : "watch";

    const evaluations = await Promise.all(expressions.map(async (expression) => {
      try {
        const result = await customRequest(session, "evaluate", { expression, frameId, context: evaluateContext });
        return { expression, result };
      } catch (error) {
        return {
          expression,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }));

    return toResult({
      session: toDebugSessionSummary(session),
      threadId,
      paused: true,
      topFrame,
      totalFrames: typeof stack.totalFrames === "number" ? stack.totalFrames : undefined,
      limits: {
        maxScopes,
        maxVariablesPerScope
      },
      scopes,
      evaluations
    });
  }
}

export class DebugStatusTool implements vscode.LanguageModelTool<DebugStatusInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugStatusInput>): Promise<vscode.LanguageModelToolResult> {
    const selected = resolveSession(options.input.sessionId);

    const breakpointsByFile = vscode.debug.breakpoints
      .filter((bp) => bp instanceof vscode.SourceBreakpoint)
      .map((bp) => bp as vscode.SourceBreakpoint)
      .reduce<Record<string, number>>((acc, bp) => {
        const file = bp.location.uri.fsPath;
        acc[file] = (acc[file] ?? 0) + 1;
        return acc;
      }, {});

    let threadPreview: DapThread[] | undefined;
    if (selected) {
      try {
        threadPreview = await getThreads(selected);
      } catch {
        threadPreview = undefined;
      }
    }

    return toResult({
      activeSession: selected ? toDebugSessionSummary(selected) : null,
      allSessions: getKnownSessions().map(toDebugSessionSummary),
      breakpoints: {
        total: vscode.debug.breakpoints.length,
        sourceByFile: breakpointsByFile
      },
      threads: threadPreview ?? null,
      note: "Paused/running state is debugger-adapter specific. Use debug_get_stacktrace/debug_get_scopes/debug_get_variables for live inspection."
    });
  }
}
