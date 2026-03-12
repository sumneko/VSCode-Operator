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

const TOOLS_RESOURCE_URI = "codepilot://tools";

type AliasDefinition = {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  toInvokeInput: (input: unknown) => { targetName: string; targetInput: Record<string, unknown> };
};

const ALIAS_DEFINITIONS: AliasDefinition[] = [
  {
    name: "get_problems",
    description: "Compatibility alias of codepilot_readProblems. Reads diagnostics from VS Code Problems panel.",
    inputSchema: {
      type: "object",
      properties: {
        maxItems: {
          type: "number",
          description: "Maximum number of diagnostics to return"
        }
      }
    },
    toInvokeInput: (input) => ({
      targetName: "codepilot_readProblems",
      targetInput: (input !== null && typeof input === "object" && !Array.isArray(input))
        ? (input as Record<string, unknown>)
        : {}
    })
  },
  {
    name: "get_diagnostics",
    description: "Compatibility alias of codepilot_readProblems. Reads diagnostics from VS Code Problems panel.",
    inputSchema: {
      type: "object",
      properties: {
        maxItems: {
          type: "number",
          description: "Maximum number of diagnostics to return"
        }
      }
    },
    toInvokeInput: (input) => ({
      targetName: "codepilot_readProblems",
      targetInput: (input !== null && typeof input === "object" && !Array.isArray(input))
        ? (input as Record<string, unknown>)
        : {}
    })
  },
  {
    name: "hover",
    description: "Compatibility alias of codepilot_runSupportedCommand(action=hoverAtPosition).",
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
        targetName: "codepilot_runSupportedCommand",
        targetInput: {
          action: "hoverAtPosition",
          line: typeof obj.line === "number" ? obj.line : 1,
          column: typeof obj.column === "number" ? obj.column : 1
        }
      };
    }
  },
  {
    name: "get_hover_info",
    description: "Compatibility alias of codepilot_runSupportedCommand(action=hoverAtPosition).",
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
        targetName: "codepilot_runSupportedCommand",
        targetInput: {
          action: "hoverAtPosition",
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
  const config = vscode.workspace.getConfiguration("codepilot.mcpBridge");
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
      ? { "codepilot/vscodeTags": [...info.tags] }
      : undefined
  };
}

function toAliasTool(alias: AliasDefinition): Tool {
  return {
    name: alias.name,
    description: alias.description,
    inputSchema: alias.inputSchema,
    _meta: {
      "codepilot/aliasOf": true
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
  private readonly output = vscode.window.createOutputChannel("CodePilot MCP Bridge");
  private httpServer: HttpServer | undefined;
  private currentConfig = getConfig();
  private currentPort: number | undefined;
  private lastError: string | undefined;

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

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    server.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.appendLine(`HTTP server error: ${this.lastError}`);
      void vscode.window.showWarningMessage(`CodePilot MCP bridge failed: ${this.lastError}`);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.currentConfig.port, this.currentConfig.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.httpServer = server;
    this.currentPort = this.getBoundPort(server);
    this.lastError = undefined;
    this.appendLine(`MCP bridge listening on ${this.getEndpointUrl()}`);
  }

  async stop(): Promise<void> {
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
      return "CodePilot MCP bridge is disabled.";
    }

    if (!this.httpServer || this.currentPort === undefined) {
      return this.lastError
        ? `CodePilot MCP bridge is not running. Last error: ${this.lastError}`
        : "CodePilot MCP bridge is not running.";
    }

    return `CodePilot MCP bridge is running at ${this.getEndpointUrl()}`;
  }

  getEndpointUrl(): string {
    const port = this.currentPort ?? this.currentConfig.port;
    return `http://${this.currentConfig.host}:${port}${this.currentConfig.path}`;
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
        name: "codepilot-vscode-tools",
        version: "0.0.1"
      },
      {
        capabilities: {
          tools: {},
          resources: {}
        },
        instructions: [
          "This server exposes VS Code language model tools that are currently registered inside the editor.",
          "Use tools/list to discover what the current VS Code session can do.",
          "Use tools/call to invoke a VS Code tool by its exact name with JSON arguments."
        ].join(" ")
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
            name: "CodePilot Tool Catalog",
            description: "A JSON document describing tools currently exposed by the CodePilot MCP bridge.",
            mimeType: "application/json"
          }
        ]
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request): Promise<ReadResourceResult> => {
      if (request.params.uri !== TOOLS_RESOURCE_URI) {
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

      const tools = getExposedTools();
      const payload = {
        endpoint: this.getEndpointUrl(),
        updatedAt: new Date().toISOString(),
        tools
      };

      return {
        contents: [
          {
            uri: TOOLS_RESOURCE_URI,
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
