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
  workspacePath?: string;
  sessionId?: string;
  threadId?: number;
};

type DebugClearBreakpointsInput = {
  filePath?: string;
  workspacePath?: string;
  all?: boolean;
};

type DebugGetThreadsInput = {
  workspacePath?: string;
  sessionId?: string;
};

type DebugGetStackTraceInput = {
  workspacePath?: string;
  sessionId?: string;
  threadId?: number;
  startFrame?: number;
  levels?: number;
};

type DebugGetScopesInput = {
  workspacePath?: string;
  sessionId?: string;
  frameId?: number;
};

type DebugGetVariablesInput = {
  workspacePath?: string;
  sessionId?: string;
  variablesReference?: number;
  start?: number;
  count?: number;
};

type DebugEvaluateInput = {
  workspacePath?: string;
  sessionId?: string;
  expression?: string;
  frameId?: number;
  context?: string;
};

type DebugGetTopFrameInput = {
  workspacePath?: string;
  sessionId?: string;
  threadId?: number;
};

type DebugSnapshotInput = {
  workspacePath?: string;
  sessionId?: string;
  threadId?: number;
  maxScopes?: number;
  maxVariablesPerScope?: number;
  evaluateExpressions?: string[];
  evaluateContext?: string;
  compact?: boolean;
};

type DebugStatusInput = {
  workspacePath?: string;
  sessionId?: string;
  compact?: boolean;
};

type DebugGetExceptionInfoInput = {
  workspacePath?: string;
  sessionId?: string;
  threadId?: number;
  includeTopFrame?: boolean;
};

type DapThread = {
  id: number;
  name?: string;
};

type DebugStopState = {
  reason?: string;
  description?: string;
  text?: string;
  threadId?: number;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
  at: string;
};

type DebugExceptionInfo = {
  isException: boolean;
  message: string | null;
  reason: string | null;
  description: string | null;
  text: string | null;
  threadId: number | null;
  at: string | null;
};

type AdapterExceptionQueryState = "supported" | "unsupported-or-unavailable" | "not-paused";

const DEBUG_PROBE_TIMEOUT_MS = 1200;

const knownSessions = new Map<string, vscode.DebugSession>();
const lastStopBySession = new Map<string, DebugStopState>();
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
    lastStopBySession.delete(session.id);
  });
  vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
    if (event.event === "continued") {
      lastStopBySession.delete(event.session.id);
      return;
    }
    if (event.event !== "stopped") {
      return;
    }

    const body = (event.body ?? {}) as Record<string, unknown>;
    lastStopBySession.set(event.session.id, {
      reason: typeof body.reason === "string" ? body.reason : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      text: typeof body.text === "string" ? body.text : undefined,
      threadId: typeof body.threadId === "number" ? body.threadId : undefined,
      allThreadsStopped: typeof body.allThreadsStopped === "boolean" ? body.allThreadsStopped : undefined,
      hitBreakpointIds: Array.isArray(body.hitBreakpointIds)
        ? body.hitBreakpointIds.filter((id): id is number => typeof id === "number")
        : undefined,
      at: new Date().toISOString()
    });
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message);
}

async function resolveThreadIdWithTimeout(
  session: vscode.DebugSession,
  inputThreadId?: number,
  timeoutMs: number = DEBUG_PROBE_TIMEOUT_MS
): Promise<number> {
  return withTimeout(
    resolveThreadId(session, inputThreadId),
    timeoutMs,
    `Resolve debug thread timed out after ${timeoutMs}ms`
  );
}

async function customRequestWithTimeout(
  session: vscode.DebugSession,
  command: string,
  args?: JsonObject,
  timeoutMs: number = DEBUG_PROBE_TIMEOUT_MS
): Promise<unknown> {
  return withTimeout(
    customRequest(session, command, args),
    timeoutMs,
    `DAP request '${command}' timed out after ${timeoutMs}ms`
  );
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

function getStopState(session: vscode.DebugSession): DebugStopState | undefined {
  return lastStopBySession.get(session.id);
}

function classifyStopKind(state: DebugStopState | undefined): "exception" | "breakpoint" | "pause" | "step" | "entry" | "other" | null {
  if (!state) {
    return null;
  }

  const reason = (state.reason ?? "").toLowerCase();
  const text = `${state.description ?? ""} ${state.text ?? ""}`.toLowerCase();
  if (reason.includes("exception") || text.includes("exception")) {
    return "exception";
  }
  if (reason.includes("breakpoint") || (state.hitBreakpointIds?.length ?? 0) > 0) {
    return "breakpoint";
  }
  if (reason.includes("pause")) {
    return "pause";
  }
  if (reason.includes("step")) {
    return "step";
  }
  if (reason.includes("entry")) {
    return "entry";
  }
  return "other";
}

function stopHandlingHint(kind: ReturnType<typeof classifyStopKind>): string | undefined {
  if (kind === "exception") {
    return "Stopped by exception. Do not treat this as a normal breakpoint. Inspect exception object/message and call stack first.";
  }
  if (kind === "breakpoint") {
    return "Stopped at breakpoint. Continue stepping/inspection as needed.";
  }
  return undefined;
}

function pickExceptionMessage(state: DebugStopState | undefined): string | null {
  if (!state) {
    return null;
  }

  const text = typeof state.text === "string" ? state.text.trim() : "";
  if (text.length > 0) {
    return text;
  }

  const description = typeof state.description === "string" ? state.description.trim() : "";
  return description.length > 0 ? description : null;
}

function toExceptionInfo(state: DebugStopState | undefined): DebugExceptionInfo {
  return {
    isException: classifyStopKind(state) === "exception",
    message: pickExceptionMessage(state),
    reason: state?.reason ?? null,
    description: state?.description ?? null,
    text: state?.text ?? null,
    threadId: state?.threadId ?? null,
    at: state?.at ?? null
  };
}

function toCompactFrame(frame: Record<string, unknown> | null): JsonObject | null {
  if (!frame) {
    return null;
  }

  const source = frame.source && typeof frame.source === "object"
    ? frame.source as Record<string, unknown>
    : undefined;

  return {
    id: typeof frame.id === "number" ? frame.id : null,
    name: typeof frame.name === "string" ? frame.name : null,
    line: typeof frame.line === "number" ? frame.line : null,
    column: typeof frame.column === "number" ? frame.column : null,
    sourcePath: typeof source?.path === "string" ? source.path : null
  };
}

function pickAdapterExceptionMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const info = value as Record<string, unknown>;
  if (typeof info.description === "string" && info.description.trim().length > 0) {
    return info.description.trim();
  }

  const details = info.details;
  if (details && typeof details === "object") {
    const detailMessage = (details as Record<string, unknown>).message;
    if (typeof detailMessage === "string" && detailMessage.trim().length > 0) {
      return detailMessage.trim();
    }
  }

  return null;
}

function hasAdapterExceptionDetails(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const info = value as Record<string, unknown>;
  if (typeof info.exceptionId === "string" && info.exceptionId.trim().length > 0) {
    return true;
  }

  if (typeof info.description === "string" && info.description.trim().length > 0) {
    return true;
  }

  const details = info.details;
  if (details && typeof details === "object") {
    const detailMessage = (details as Record<string, unknown>).message;
    if (typeof detailMessage === "string" && detailMessage.trim().length > 0) {
      return true;
    }
  }

  return false;
}

function toCompactAdapterException(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const info = value as Record<string, unknown>;
  return {
    exceptionId: typeof info.exceptionId === "string" ? info.exceptionId : null,
    description: typeof info.description === "string" ? info.description : null,
    breakMode: typeof info.breakMode === "string" ? info.breakMode : null
  };
}

function isLikelyBreakpointStop(frame: Record<string, unknown> | null): boolean {
  if (!frame) {
    return false;
  }

  const source = frame.source && typeof frame.source === "object"
    ? frame.source as Record<string, unknown>
    : undefined;
  const sourcePath = typeof source?.path === "string" ? source.path : undefined;
  const line = typeof frame.line === "number" ? frame.line : undefined;
  if (!sourcePath || !line || line <= 0) {
    return false;
  }

  const normalizedFramePath = normalizeForCompare(sourcePath);
  return vscode.debug.breakpoints
    .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
    .some((bp) => {
      if (!bp.enabled) {
        return false;
      }
      const bpPath = normalizeForCompare(bp.location.uri.fsPath);
      const bpLine = bp.location.range.start.line + 1;
      return bpPath === normalizedFramePath && bpLine === line;
    });
}

function emptyExceptionInfo(): DebugExceptionInfo {
  return {
    isException: false,
    message: null,
    reason: null,
    description: null,
    text: null,
    threadId: null,
    at: null
  };
}

function normalizeStopSemantics(params: {
  paused: boolean;
  stopKind: ReturnType<typeof classifyStopKind>;
  isException?: boolean;
  exception?: DebugExceptionInfo | null;
  topFrame?: Record<string, unknown> | null;
}): {
  paused: boolean;
  stopKind: ReturnType<typeof classifyStopKind>;
  isException: boolean;
  exception: DebugExceptionInfo;
} {
  let paused = params.paused;
  let stopKind = params.stopKind;
  let isException = Boolean(params.isException);
  let exception = params.exception ?? emptyExceptionInfo();

  if (!paused) {
    return {
      paused: false,
      stopKind: null,
      isException: false,
      exception: emptyExceptionInfo()
    };
  }

  if (!stopKind) {
    stopKind = isLikelyBreakpointStop(params.topFrame ?? null) ? "breakpoint" : "other";
  }

  if (stopKind === "exception") {
    isException = true;
  }

  if (isException) {
    paused = true;
    stopKind = "exception";
    exception = {
      ...exception,
      isException: true,
      reason: exception.reason ?? "exception"
    };
  } else {
    exception = {
      ...exception,
      isException: false
    };
  }

  return {
    paused,
    stopKind,
    isException,
    exception
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

    let threadId: number;
    let response: {
      stackFrames?: unknown[];
      totalFrames?: number;
    };
    try {
      threadId = await resolveThreadIdWithTimeout(session, input.threadId);
      response = await customRequestWithTimeout(session, "stackTrace", { threadId, startFrame: 0, levels: 1 }) as {
        stackFrames?: unknown[];
        totalFrames?: number;
      };
    } catch (error) {
      const stopState = getStopState(session);
      const stopKind = classifyStopKind(stopState);
      return toResult({
        session: toDebugSessionSummary(session),
        threadId: input.threadId ?? null,
        stopState: stopState ?? null,
        stopKind,
        stopHint: stopHandlingHint(stopKind) ?? null,
        topFrame: null,
        totalFrames: 0,
        paused: false,
        note: isTimeoutError(error)
          ? "Live stack probing timed out. The target may be running or adapter did not respond in time."
          : "Live stack probing failed. The target may be running or adapter does not support stackTrace at this moment."
      });
    }

    const frames = Array.isArray(response.stackFrames) ? response.stackFrames : [];
    const topFrame = frames.length > 0 ? frames[0] : null;
    const stopState = getStopState(session);
    const stopKind = classifyStopKind(stopState);
    const normalized = normalizeStopSemantics({
      paused: topFrame !== null,
      stopKind,
      topFrame: topFrame as Record<string, unknown> | null
    });

    return toResult({
      session: toDebugSessionSummary(session),
      threadId,
      stopState: stopState ?? null,
      stopKind: normalized.stopKind,
      stopHint: stopHandlingHint(normalized.stopKind) ?? null,
      topFrame,
      totalFrames: typeof response.totalFrames === "number" ? response.totalFrames : frames.length,
      paused: normalized.paused
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

    let threadId: number;
    let stack: {
      stackFrames?: Array<Record<string, unknown>>;
      totalFrames?: number;
    };
    try {
      threadId = await resolveThreadIdWithTimeout(session, input.threadId);
      stack = await customRequestWithTimeout(session, "stackTrace", { threadId, startFrame: 0, levels: 1 }) as {
        stackFrames?: Array<Record<string, unknown>>;
        totalFrames?: number;
      };
    } catch (error) {
      const compact = Boolean(input.compact);
      const timeoutNote = isTimeoutError(error)
        ? "Live stack probing timed out. The debugger is likely running or adapter did not respond in time."
        : "Live stack probing failed. The debugger may be running instead of paused.";
      if (compact) {
        return toResult({
          session: toDebugSessionSummary(session),
          threadId: input.threadId ?? null,
          paused: false,
          topFrame: null,
          note: `${timeoutNote} Use vscodeOperator_debugGetExceptionInfo to determine whether the current stop is an exception.`
        });
      }

      return toResult({
        session: toDebugSessionSummary(session),
        threadId: input.threadId ?? null,
        stopState: getStopState(session) ?? null,
        paused: false,
        topFrame: null,
        scopes: [],
        evaluations: [],
        note: `${timeoutNote} Use vscodeOperator_debugControl(action='pause') and retry, or continue to a breakpoint. Use vscodeOperator_debugGetExceptionInfo to determine whether the current stop is an exception.`
      });
    }

    const topFrame = Array.isArray(stack.stackFrames) && stack.stackFrames.length > 0
      ? stack.stackFrames[0]
      : null;
    const frameId = topFrame && typeof topFrame.id === "number" ? topFrame.id : undefined;
    const stopState = getStopState(session);
    const compact = Boolean(input.compact);

    if (frameId === undefined) {
      if (compact) {
        return toResult({
          session: toDebugSessionSummary(session),
          threadId,
          paused: false,
          topFrame: null,
          note: "No top frame is available. The debugger may be running instead of paused. Use vscodeOperator_debugGetExceptionInfo to determine whether the current stop is an exception."
        });
      }

      return toResult({
        session: toDebugSessionSummary(session),
        threadId,
        stopState: stopState ?? null,
        paused: false,
        topFrame: null,
        scopes: [],
        evaluations: [],
        note: "No top frame is available. The debugger may be running instead of paused. Use vscodeOperator_debugControl(action='pause') and retry, or continue to a breakpoint. Use vscodeOperator_debugGetExceptionInfo to determine whether the current stop is an exception."
      });
    }

    if (compact) {
      return toResult({
        session: toDebugSessionSummary(session),
        threadId,
        paused: true,
        topFrame: toCompactFrame(topFrame)
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
      stopState: stopState ?? null,
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
    const compact = Boolean(options.input.compact);

    const breakpointsByFile = vscode.debug.breakpoints
      .filter((bp) => bp instanceof vscode.SourceBreakpoint)
      .map((bp) => bp as vscode.SourceBreakpoint)
      .reduce<Record<string, number>>((acc, bp) => {
        const file = bp.location.uri.fsPath;
        acc[file] = (acc[file] ?? 0) + 1;
        return acc;
      }, {});

    let threadPreview: DapThread[] | undefined;
    const stopState = selected ? getStopState(selected) : undefined;
    let stopKind = classifyStopKind(stopState);
    let exception = toExceptionInfo(stopState);
    let paused = stopState !== undefined;
    let topFrame: Record<string, unknown> | null = null;
    let probeNote: string | undefined;

    if (selected) {
      try {
        threadPreview = await withTimeout(getThreads(selected), DEBUG_PROBE_TIMEOUT_MS, `DAP request 'threads' timed out after ${DEBUG_PROBE_TIMEOUT_MS}ms`);
      } catch (error) {
        threadPreview = undefined;
        if (isTimeoutError(error)) {
          probeNote = "Thread probing timed out.";
        }
      }

      if (threadPreview && threadPreview.length > 0) {
        const preferredThreadId = stopState?.threadId ?? threadPreview[0].id;
        try {
          const stack = await customRequestWithTimeout(selected, "stackTrace", {
            threadId: preferredThreadId,
            startFrame: 0,
            levels: 1
          }) as {
            stackFrames?: Array<Record<string, unknown>>;
          };
          topFrame = Array.isArray(stack.stackFrames) && stack.stackFrames.length > 0 ? stack.stackFrames[0] : null;
          paused = topFrame !== null;
        } catch (error) {
          paused = false;
          if (isTimeoutError(error)) {
            probeNote = "Live stack probing timed out.";
          }
        }

        if (paused) {
          if (!stopKind) {
            stopKind = isLikelyBreakpointStop(topFrame) ? "breakpoint" : "other";
          }
          try {
            const exceptionInfo = await customRequestWithTimeout(selected, "exceptionInfo", { threadId: preferredThreadId });
            if (hasAdapterExceptionDetails(exceptionInfo)) {
              stopKind = "exception";
              exception = {
                isException: true,
                message: pickAdapterExceptionMessage(exceptionInfo),
                reason: "exception",
                description: toCompactAdapterException(exceptionInfo)?.description as string | null,
                text: null,
                threadId: preferredThreadId,
                at: stopState?.at ?? null
              };
            }
          } catch {
            // Non-exception stop or adapter doesn't support exceptionInfo.
          }
        } else {
          stopKind = null;
          exception = {
            isException: false,
            message: null,
            reason: null,
            description: null,
            text: null,
            threadId: null,
            at: null
          };
        }
      }
    }

    const normalizedStatus = normalizeStopSemantics({
      paused,
      stopKind,
      isException: exception.isException,
      exception,
      topFrame
    });

    if (compact) {
      return toResult({
        activeSession: selected ? toDebugSessionSummary(selected) : null,
        stopKind: normalizedStatus.stopKind,
        exception: normalizedStatus.exception,
        paused: normalizedStatus.paused,
        breakpoints: {
          total: vscode.debug.breakpoints.length
        },
        threads: {
          total: threadPreview?.length ?? 0
        },
        note: probeNote ?? null
      });
    }

    return toResult({
      activeSession: selected ? toDebugSessionSummary(selected) : null,
      allSessions: getKnownSessions().map(toDebugSessionSummary),
      breakpoints: {
        total: vscode.debug.breakpoints.length,
        sourceByFile: breakpointsByFile
      },
      stopState: stopState ?? null,
      stopKind: normalizedStatus.stopKind,
      paused: normalizedStatus.paused,
      stopHint: stopHandlingHint(normalizedStatus.stopKind) ?? null,
      exception: normalizedStatus.exception,
      threads: threadPreview ?? null,
      topFrame: toCompactFrame(topFrame),
      probeNote: probeNote ?? null,
      note: "Paused/running state is debugger-adapter specific. Use debug_get_stacktrace/debug_get_scopes/debug_get_variables for live inspection."
    });
  }
}

export class DebugGetExceptionInfoTool implements vscode.LanguageModelTool<DebugGetExceptionInfoInput> {
  async invoke(options: vscode.LanguageModelToolInvocationOptions<DebugGetExceptionInfoInput>): Promise<vscode.LanguageModelToolResult> {
    const input = options.input;
    const session = resolveSession(input.sessionId);
    if (!session) {
      return toError("No debug session is active. Call vscodeOperator_debugStart first, or inspect existing sessions via vscodeOperator_debugStatus.");
    }

    const stopState = getStopState(session);
    const stopKind = classifyStopKind(stopState);
    let exception = toExceptionInfo(stopState);
    const includeTopFrame = Boolean(input.includeTopFrame);
    let isException = stopKind === "exception";

    // stopState can be missing or stale on some adapters, so always probe pause state
    // via a bounded live stack request before classifying exception state.

    let rawTopFrame: Record<string, unknown> | null = null;
    let topFrame: JsonObject | null = null;
    let paused = false;
    let resolvedThreadId: number | undefined;
    {
      try {
        const preferredThreadId = typeof input.threadId === "number"
          ? input.threadId
          : stopState?.threadId;
        resolvedThreadId = await resolveThreadIdWithTimeout(session, preferredThreadId);
        const stack = await customRequestWithTimeout(session, "stackTrace", {
          threadId: resolvedThreadId,
          startFrame: 0,
          levels: 1
        }) as {
          stackFrames?: Array<Record<string, unknown>>;
        };
        rawTopFrame = Array.isArray(stack.stackFrames) && stack.stackFrames.length > 0 ? stack.stackFrames[0] : null;
        paused = rawTopFrame !== null;
        if (includeTopFrame) {
          topFrame = toCompactFrame(rawTopFrame);
        }
      } catch {
        paused = false;
        if (includeTopFrame) {
          topFrame = null;
        }
      }
    }

    let adapterException: JsonObject | null = null;
    let adapterExceptionQuery: AdapterExceptionQueryState = paused
      ? "unsupported-or-unavailable"
      : "not-paused";
    if (paused) {
      try {
        const threadId = resolvedThreadId ?? await resolveThreadIdWithTimeout(
          session,
          typeof input.threadId === "number" ? input.threadId : stopState?.threadId
        );
        const exceptionInfo = await customRequestWithTimeout(session, "exceptionInfo", { threadId });
        adapterException = toCompactAdapterException(exceptionInfo);
        adapterExceptionQuery = "supported";

        const adapterMessage = pickAdapterExceptionMessage(exceptionInfo);
        const adapterReportsException = hasAdapterExceptionDetails(exceptionInfo);
        if (adapterReportsException || stopKind === "exception") {
          exception = {
            ...exception,
            isException: true,
            message: adapterMessage ?? exception.message,
            threadId
          };
          isException = true;
        }
      } catch (error) {
        if (isTimeoutError(error)) {
          adapterExceptionQuery = "not-paused";
          paused = false;
        }
        // Some adapters don't support exceptionInfo, or current stop is not an exception.
      }
    }

    const normalized = normalizeStopSemantics({
      paused,
      stopKind,
      isException,
      exception,
      topFrame: rawTopFrame
    });

    if (!normalized.isException) {
      normalized.exception = {
        ...normalized.exception,
        message: null,
        description: null,
        text: null
      };
    }

    const basePayload: JsonObject = {
      session: toDebugSessionSummary(session),
      stopKind: normalized.stopKind,
      isException: normalized.isException,
      paused: normalized.paused,
      adapterExceptionQuery,
      adapterException
    };
    if (normalized.isException) {
      basePayload.exception = normalized.exception;
    }

    if (!includeTopFrame) {
      return toResult(basePayload);
    }

    basePayload.topFrame = topFrame;
    return toResult(basePayload);
  }
}
