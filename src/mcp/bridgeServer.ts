import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// We intentionally use the low-level Server API because this bridge dynamically
// wires tools/resources handlers from the live VS Code session on each request.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ListResourcesResult,
  type ReadResourceResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";

const DEFAULT_INPUT_SCHEMA = {
  type: "object",
  properties: {}
};

const TOOLS_RESOURCE_URI = "vscode-operator://tools";
const TOOL_SCHEMA_RESOURCE_URI = "vscode-operator://tool-schema";
const USAGE_GUIDE_RESOURCE_URI = "vscode-operator://usage";

const SERVER_INSTRUCTIONS = [
  "You are connected to VSCode Operator, a VS Code MCP bridge.",
  "Always prefer MCP tool calls over assumptions when editor state or APIs might matter.",
  "Before calling any tool, call tools/list to discover exact tool names and schemas.",
  "workspacePath is not required for generic MCP methods like initialize/tools/list/resources/list.",
  "When multiple workspaces exist, provide workspacePath for workspace-specific VS Code requests (for example tool arguments or resource URI query).",
  "If tools/list is unavailable in the client workflow, read resource vscode-operator://tools and vscode-operator://usage.",
  "Do not guess tool names. Use exact names returned by tools/list.",
  "Do not guess parameter names. Follow each tool's inputSchema exactly.",
  "Use dedicated tools for editor context: vscodeOperator_activeEditorSummary, vscodeOperator_hoverTopVisible, vscodeOperator_hoverAtPosition, and vscodeOperator_completionAt.",
  "When fixing code, prefer reading diagnostics via vscodeOperator_readProblems first."
].join(" ");

const USAGE_GUIDE_TEXT = [
  "VSCode Operator usage guide:",
  "1) Call tools/list first to discover exact tools and input schema.",
  "2) If list output is truncated, read vscode-operator://tools for compact name+description list.",
  "3) Query parameter schema using vscode-operator://tool-schema?name=<toolName>.",
  "4) Prefer tool calls over guessing API names or editor state.",
  "5) For diagnostics/fixes, call vscodeOperator_readProblems first.",
  "6) For editor summary, call vscodeOperator_activeEditorSummary.",
  "7) For hover/type info, call vscodeOperator_hoverTopVisible or vscodeOperator_hoverAtPosition.",
  "8) For completion discovery, call vscodeOperator_completionAt.",
  "9) Use vscodeOperator_executeCommand only when no specialized tool fits.",
  "10) For generic MCP calls (initialize/tools/list/resources/list), workspacePath is optional.",
  "11) For workspace-specific requests in multi-workspace mode, include workspacePath in tool arguments or in resource URI query (e.g. vscode-operator://tools?workspacePath=<abs path>).",
  "",
  "Parameter hints:",
  "- vscodeOperator_hoverAtPosition: line, column",
  "- vscodeOperator_completionAt: line, column, triggerCharacter(optional), filePath(optional)",
  "- Position is 1-based.",
  "",
  "Examples:",
  "- vscodeOperator_completionAt:",
  "  {\"line\":1,\"column\":4,\"triggerCharacter\":\".\"}",
  "- vscodeOperator_hoverAtPosition:",
  "  {\"line\":42,\"column\":18}"
].join("\n");

type AliasDefinition = {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  toInvokeInput: (input: unknown) => { targetName: string; targetInput: Record<string, unknown> };
};

const ALIAS_DEFINITIONS: AliasDefinition[] = [
  {
    name: "get_problems",
    description: "Compatibility alias of vscodeOperator_readProblems. Reads diagnostics from VS Code Problems panel.",
    inputSchema: {
      type: "object",
      properties: {
        maxItems: {
          type: "number",
          description: "Maximum number of diagnostics to return"
        },
        minSeverity: {
          type: "string",
          description: "Minimum severity to include: error, warning, information, hint"
        },
        pathGlob: {
          oneOf: [
            { type: "string" },
            {
              type: "array",
              items: { type: "string" }
            }
          ],
          description: "Optional path glob filter (absolute or workspace-relative). Accepts string/comma-separated string/array. Prefix with ! for exclusion."
        }
      }
    },
    toInvokeInput: (input) => ({
      targetName: "vscodeOperator_readProblems",
      targetInput: (input !== null && typeof input === "object" && !Array.isArray(input))
        ? (input as Record<string, unknown>)
        : {}
    })
  },
  {
    name: "get_diagnostics",
    description: "Compatibility alias of vscodeOperator_readProblems. Reads diagnostics from VS Code Problems panel.",
    inputSchema: {
      type: "object",
      properties: {
        maxItems: {
          type: "number",
          description: "Maximum number of diagnostics to return"
        },
        minSeverity: {
          type: "string",
          description: "Minimum severity to include: error, warning, information, hint"
        },
        pathGlob: {
          oneOf: [
            { type: "string" },
            {
              type: "array",
              items: { type: "string" }
            }
          ],
          description: "Optional path glob filter (absolute or workspace-relative). Accepts string/comma-separated string/array. Prefix with ! for exclusion."
        }
      }
    },
    toInvokeInput: (input) => ({
      targetName: "vscodeOperator_readProblems",
      targetInput: (input !== null && typeof input === "object" && !Array.isArray(input))
        ? (input as Record<string, unknown>)
        : {}
    })
  },
  {
    name: "hover",
    description: "Compatibility alias of vscodeOperator_hoverAtPosition.",
    inputSchema: {
      type: "object",
      properties: {
        line: {
          type: "number",
          description: "1-based line number"
        },
        column: {
          type: "number",
          description: "1-based column number"
        }
      }
    },
    toInvokeInput: (input) => {
      const obj = (input !== null && typeof input === "object" && !Array.isArray(input))
        ? input as Record<string, unknown>
        : {};
      return {
        targetName: "vscodeOperator_hoverAtPosition",
        targetInput: {
          line: typeof obj.line === "number" ? obj.line : 1,
          column: typeof obj.column === "number" ? obj.column : 1
        }
      };
    }
  },
  {
    name: "get_hover_info",
    description: "Compatibility alias of vscodeOperator_hoverAtPosition.",
    inputSchema: {
      type: "object",
      properties: {
        line: {
          type: "number",
          description: "1-based line number"
        },
        column: {
          type: "number",
          description: "1-based column number"
        }
      }
    },
    toInvokeInput: (input) => {
      const obj = (input !== null && typeof input === "object" && !Array.isArray(input))
        ? input as Record<string, unknown>
        : {};
      return {
        targetName: "vscodeOperator_hoverAtPosition",
        targetInput: {
          line: typeof obj.line === "number" ? obj.line : 1,
          column: typeof obj.column === "number" ? obj.column : 1
        }
      };
    }
  }
];

const ALIAS_BY_NAME = new Map(ALIAS_DEFINITIONS.map((d) => [d.name, d]));

type BridgeConfig = {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
};

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "/mcp";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function getConfig(): BridgeConfig {
  const config = vscode.workspace.getConfiguration("vscodeOperator.mcpBridge");
  return {
    enabled: config.get<boolean>("enabled", true),
    host: config.get<string>("host", "127.0.0.1"),
    port: config.get<number>("port", 19191),
    path: normalizePath(config.get<string>("path", "/mcp"))
  };
}

function toMcpTool(info: vscode.LanguageModelToolInformation): Tool {
  return {
    name: info.name,
    description: info.description,
    inputSchema: (info.inputSchema as Tool["inputSchema"]) ?? DEFAULT_INPUT_SCHEMA,
    _meta: info.tags.length > 0
      ? { "vscodeOperator/vscodeTags": [...info.tags] }
      : undefined
  };
}

function toAliasTool(alias: AliasDefinition): Tool {
  return {
    name: alias.name,
    description: alias.description,
    inputSchema: alias.inputSchema,
    _meta: {
      "vscodeOperator/aliasOf": true
    }
  };
}

function getExposedTools(): Tool[] {
  const nativeTools = [...vscode.lm.tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toMcpTool);

  const aliasTools = ALIAS_DEFINITIONS.map(toAliasTool);
  return [...nativeTools, ...aliasTools];
}

function getToolSummaryList(): Array<{ name: string; description: string }> {
  return getExposedTools().map((tool) => ({
    name: tool.name,
    description: tool.description ?? ""
  }));
}

function getToolSchemaByName(name: string): Tool | undefined {
  return getExposedTools().find((tool) => tool.name === name);
}

function tryParseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function decodeDataPart(part: vscode.LanguageModelDataPart): { text: string; structuredContent?: Record<string, unknown> } {
  const candidate = part as unknown as {
    data?: Uint8Array;
    mimeType?: string;
  };
  const data = candidate.data instanceof Uint8Array ? candidate.data : undefined;
  const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : "application/octet-stream";

  if (!data) {
    return { text: `[tool returned binary data: ${mimeType}]` };
  }

  const isTextLike = mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.endsWith("+json");
  if (!isTextLike) {
    return { text: `[tool returned binary data: ${mimeType}, ${data.byteLength} bytes]` };
  }

  const text = new TextDecoder().decode(data);
  const parsed = mimeType.includes("json") || mimeType.endsWith("+json") ? tryParseJsonText(text) : undefined;
  return parsed && typeof parsed === "object"
    ? { text, structuredContent: parsed as Record<string, unknown> }
    : { text };
}

function toToolResultContent(result: vscode.LanguageModelToolResult): CallToolResult {
  const content: CallToolResult["content"] = [];
  let structuredContent: Record<string, unknown> | undefined;

  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      content.push({ type: "text", text: part.value });
      continue;
    }

    if (part instanceof vscode.LanguageModelPromptTsxPart) {
      content.push({
        type: "text",
        text: JSON.stringify(part.value, null, 2)
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      const decoded = decodeDataPart(part);
      content.push({ type: "text", text: decoded.text });
      structuredContent ??= decoded.structuredContent;
      continue;
    }

    content.push({
      type: "text",
      text: `[tool returned unsupported content part: ${Object.prototype.toString.call(part)}]`
    });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "Tool executed successfully with no content." });
  }

  return structuredContent ? { content, structuredContent } : { content };
}

export class LmToolsMcpBridgeServer implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("VSCode Operator MCP Bridge");
  private httpServer: HttpServer | undefined;
  private currentConfig = getConfig();
  private currentPort: number | undefined;
  private lastError: string | undefined;
  private workspacePath: string | undefined;
  private proxyConnection: import("node:http").ClientRequest | undefined;

  async start(): Promise<void> {
    this.currentConfig = getConfig();

    if (!this.currentConfig.enabled) {
      this.appendLine("MCP bridge is disabled by configuration.");
      await this.stop();
      return;
    }

    if (this.httpServer) {
      return;
    }

    // Get workspace path
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.appendLine("No workspace folder open. MCP bridge requires an open workspace.");
      return;
    }
    this.workspacePath = workspaceFolders[0].uri.fsPath;

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    server.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.appendLine(`HTTP server error: ${this.lastError}`);
      // EADDRINUSE is expected while probing/competing for ports in multi-instance mode.
      if (err.code !== "EADDRINUSE") {
        void vscode.window.showWarningMessage(`VSCode Operator MCP bridge failed: ${this.lastError}`);
      }
    });

    // Try to find an available port starting from proxyPort+1
    let port = this.currentConfig.port + 1;
    let listened = false;
    const maxAttempts = 100;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, this.currentConfig.host, () => {
            server.off("error", reject);
            listened = true;
            resolve();
          });
        });
        break;
      } catch (error) {
        if (attempt < maxAttempts - 1) {
          port++;
        } else {
          this.lastError = `Could not find available port after ${maxAttempts} attempts`;
          this.appendLine(this.lastError);
          throw error;
        }
      }
    }

    if (!listened) {
      this.lastError = "Failed to listen on any port";
      this.appendLine(this.lastError);
      throw new Error(this.lastError);
    }

    this.httpServer = server;
    this.currentPort = port;
    this.lastError = undefined;

    // Connect to proxy via persistent SSE channel
    void this.connectToProxy();

    this.appendLine(`MCP bridge listening on ${this.getEndpointUrl()}`);
  }

  async stop(): Promise<void> {
    // Closing the proxy connection signals the proxy to auto-unregister this bridge
    this.proxyConnection?.destroy();
    this.proxyConnection = undefined;

    const server = this.httpServer;
    this.httpServer = undefined;
    this.currentPort = undefined;

    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.appendLine("MCP bridge stopped.");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async reloadFromConfiguration(): Promise<void> {
    const next = getConfig();
    const changed = JSON.stringify(this.currentConfig) !== JSON.stringify(next);
    this.currentConfig = next;

    if (!changed && this.httpServer) {
      return;
    }

    if (!next.enabled) {
      await this.stop();
      this.appendLine("MCP bridge disabled after configuration change.");
      return;
    }

    await this.restart();
  }

  getStatus(): string {
    if (!this.currentConfig.enabled) {
      return "VSCode Operator MCP bridge is disabled.";
    }

    if (!this.httpServer || this.currentPort === undefined) {
      return this.lastError
        ? `VSCode Operator MCP bridge is not running. Last error: ${this.lastError}`
        : "VSCode Operator MCP bridge is not running.";
    }

    return `VSCode Operator MCP bridge is running at ${this.getEndpointUrl()}`;
  }

  getEndpointUrl(): string {
    const port = this.currentPort ?? this.currentConfig.port;
    return `http://${this.currentConfig.host}:${port}${this.currentConfig.path}`;
  }

  private async connectToProxy(): Promise<void> {
    if (!this.workspacePath || !this.currentPort || !this.httpServer) {
      return;
    }

    const params = new URLSearchParams({
      workspacePath: this.workspacePath,
      host: this.currentConfig.host,
      port: String(this.currentPort)
    });

    const { request } = await import("node:http");
    const req = request(
      {
        hostname: "127.0.0.1",
        port: this.currentConfig.port,
        path: `/bridge-channel?${params}`,
        method: "GET",
        headers: { "Accept": "text/event-stream" }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.appendLine(`Proxy channel rejected with status ${res.statusCode}, re-electing...`);
          void this.reelectAndReconnect();
          return;
        }
        this.appendLine("Connected to proxy (persistent channel).");
        res.on("data", () => { /* consume keep-alive pings */ });
        res.on("close", () => {
          this.proxyConnection = undefined;
          if (this.httpServer) {
            this.appendLine("Proxy channel closed, re-electing...");
            void this.reelectAndReconnect();
          }
        });
      }
    );

    req.on("error", () => {
      this.proxyConnection = undefined;
      if (this.httpServer) {
        this.appendLine("Proxy channel error, re-electing...");
        void this.reelectAndReconnect();
      }
    });

    req.end();
    this.proxyConnection = req;
  }

  private async reelectAndReconnect(): Promise<void> {
    if (!this.httpServer) {
      return;
    }

    // Try to become the new proxy
    try {
      this.appendLine(`Starting proxy re-election attempt (workspace=${this.workspacePath ?? "<unknown>"}, pid=${process.pid})`);
      const { McpProxyServer } = await import("./proxyServer.js");
      const proxy = new McpProxyServer();
      await proxy.start();
      this.appendLine("Proxy re-election attempt finished (this instance may now be proxy, or another instance already owns it).");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } catch (e) {
      this.appendLine(`Re-election error: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!this.httpServer) {
      return;
    }

    // Reconnect to whichever instance won the election
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await this.connectToProxy();
  }

  dispose(): void {
    void this.stop();
    this.output.dispose();
  }

  private appendLine(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private getBoundPort(server: HttpServer): number {
    const address = server.address();
    return typeof address === "object" && address !== null
      ? (address as AddressInfo).port
      : this.currentConfig.port;
  }

  private createProtocolServer(): Server {
    const server = new Server(
      {
        name: "vscode-operator-vscode-tools",
        version: "0.0.1"
      },
      {
        capabilities: {
          tools: {},
          resources: {}
        },
        instructions: SERVER_INSTRUCTIONS
      }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: getExposedTools() };
    });

    server.setRequestHandler(ListResourcesRequestSchema, async (): Promise<ListResourcesResult> => {
      return {
        resources: [
          {
            uri: TOOLS_RESOURCE_URI,
            name: "VSCode Operator Tool Summary",
            description: "Compact JSON list of tool names and descriptions.",
            mimeType: "application/json"
          },
          {
            uri: TOOL_SCHEMA_RESOURCE_URI,
            name: "VSCode Operator Tool Schema Lookup",
            description: "Read with ?name=<toolName> to get a single tool's input schema.",
            mimeType: "application/json"
          },
          {
            uri: USAGE_GUIDE_RESOURCE_URI,
            name: "VSCode Operator Usage Guide",
            description: "Guidance for models to prefer MCP tools and discovery flow.",
            mimeType: "text/plain"
          }
        ]
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request): Promise<ReadResourceResult> => {
      if (request.params.uri === USAGE_GUIDE_RESOURCE_URI) {
        return {
          contents: [
            {
              uri: USAGE_GUIDE_RESOURCE_URI,
              mimeType: "text/plain",
              text: USAGE_GUIDE_TEXT
            }
          ]
        };
      }

      if (request.params.uri.startsWith(TOOL_SCHEMA_RESOURCE_URI)) {
        let toolName = "";
        try {
          const parsed = new URL(request.params.uri);
          toolName = parsed.searchParams.get("name") ?? "";
        } catch {
          toolName = "";
        }

        if (!toolName) {
          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify({
                  error: "Missing query parameter 'name'.",
                  usage: "vscode-operator://tool-schema?name=vscodeOperator_completionAt"
                }, null, 2)
              }
            ]
          };
        }

        const tool = getToolSchemaByName(toolName);
        if (!tool) {
          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify({
                  error: `Tool not found: ${toolName}`
                }, null, 2)
              }
            ]
          };
        }

        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "application/json",
              text: JSON.stringify({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema ?? DEFAULT_INPUT_SCHEMA
              }, null, 2)
            }
          ]
        };
      }

      if (!request.params.uri.startsWith(TOOLS_RESOURCE_URI)) {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/plain",
              text: `Resource not found: ${request.params.uri}`
            }
          ]
        };
      }

      const tools = getToolSummaryList();
      const payload = {
        endpoint: this.getEndpointUrl(),
        updatedAt: new Date().toISOString(),
        usage: "Use vscode-operator://tool-schema?name=<toolName> to query a tool input schema.",
        tools
      };

      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2)
          }
        ]
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const toolName = request.params.name;
      const input = request.params.arguments;
      const alias = ALIAS_BY_NAME.get(toolName);
      const invokeTarget = alias ? alias.toInvokeInput(input) : {
        targetName: toolName,
        targetInput: (input as Record<string, unknown> | undefined) ?? {}
      };
      const info = vscode.lm.tools.find((tool) => tool.name === invokeTarget.targetName);

      if (!info) {
        return {
          content: [{ type: "text", text: `VS Code tool not found: ${invokeTarget.targetName}` }],
          isError: true
        };
      }

      if (invokeTarget.targetInput !== undefined && (typeof invokeTarget.targetInput !== "object" || invokeTarget.targetInput === null || Array.isArray(invokeTarget.targetInput))) {
        return {
          content: [{ type: "text", text: "Tool arguments must be a JSON object." }],
          isError: true
        };
      }

      try {
        const result = await vscode.lm.invokeTool(
          invokeTarget.targetName,
          {
            toolInvocationToken: undefined,
            input: invokeTarget.targetInput
          }
        );
        return toToolResultContent(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true
        };
      }
    });

    return server;
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${this.currentConfig.host}`);

      if (requestUrl.pathname === "/health") {
        const payload = {
          status: "ok",
          endpoint: this.getEndpointUrl(),
          tools: vscode.lm.tools.length
        };
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload, null, 2));
        return;
      }

      if (requestUrl.pathname !== this.currentConfig.path) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      const protocolServer = this.createProtocolServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

      await protocolServer.connect(transport);

      try {
        await transport.handleRequest(req, res);
      } finally {
        await transport.close();
        await protocolServer.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.appendLine(`Request handling failed: ${message}`);

      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }

      if (!res.writableEnded) {
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
            data: message
          },
          id: null
        }));
      }
    }
  }
}
