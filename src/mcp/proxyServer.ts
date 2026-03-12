import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";

export interface BridgeRegistration {
  workspacePath: string;
  host: string;
  port: number;
}

/**
 * Proxy server that routes MCP requests to different VS Code bridge instances
 * based on the workspacePath parameter.
 *
 * Listens on a fixed port (19191) and maintains a registry of active bridges.
 */
export class McpProxyServer implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("VSCode Operator Proxy");
  private httpServer: HttpServer | undefined;
  private bridges = new Map<string, BridgeRegistration>();
  /** mcp-session-id → bridge that owns the session */
  private sessions = new Map<string, BridgeRegistration>();
  private lastError: string | undefined;

  private summarizeText(value: string, max = 1200): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "<empty>";
    }
    return normalized.length > max ? `${normalized.slice(0, max)} ...[truncated ${normalized.length - max} chars]` : normalized;
  }

  private safePreviewJsonBody(body: string): string {
    if (!body.trim()) {
      return "<empty>";
    }
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const preview = {
        jsonrpc: parsed.jsonrpc,
        id: parsed.id,
        method: parsed.method,
        params: parsed.params
      };
      return this.summarizeText(JSON.stringify(preview));
    } catch {
      return this.summarizeText(body);
    }
  }

  private normalizeWorkspacePathForCompare(value: string): string {
    const trimmed = decodeURIComponent(value).trim();
    if (/^[a-zA-Z]:/.test(trimmed)) {
      // Windows path compare: case-insensitive + slash-insensitive
      return path.win32.normalize(trimmed.replace(/\//g, "\\")).toLowerCase();
    }

    return path.posix.normalize(trimmed.replace(/\\/g, "/"));
  }

  private findBridgeByWorkspacePath(workspacePath: string): BridgeRegistration | undefined {
    const direct = this.bridges.get(workspacePath);
    if (direct) {
      return direct;
    }

    const normalizedInput = this.normalizeWorkspacePathForCompare(workspacePath);
    for (const bridge of this.bridges.values()) {
      if (this.normalizeWorkspacePathForCompare(bridge.workspacePath) === normalizedInput) {
        return bridge;
      }
    }

    return undefined;
  }

  private extractWorkspacePathFromPayload(parsed: Record<string, unknown>, workspacePathFromUrl: string | null): string | null {
    const params = parsed.params as Record<string, unknown> | undefined;
    const args = params?.arguments as Record<string, unknown> | undefined;

    const fromFields =
      workspacePathFromUrl ??
      (typeof args?.workspacePath === "string" ? args.workspacePath : null) ??
      (typeof params?.workspacePath === "string" ? params.workspacePath : null) ??
      (typeof parsed.workspacePath === "string" ? parsed.workspacePath : null);

    if (fromFields) {
      return fromFields;
    }

    // Resource reads often put workspacePath inside params.uri query string.
    const uriRaw = typeof params?.uri === "string" ? params.uri : null;
    if (uriRaw) {
      try {
        const uri = new URL(uriRaw);
        const fromUri = uri.searchParams.get("workspacePath");
        if (fromUri) {
          return fromUri;
        }
      } catch {
        // Ignore invalid URIs and continue fallback.
      }
    }

    return null;
  }

  private isGenericMcpMethod(method: string): boolean {
    return method === "initialize"
      || method === "notifications/initialized"
      || method === "tools/list"
      || method === "resources/list"
      || method === "prompts/list";
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    server.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.appendLine(`HTTP server error: ${this.lastError}`);
      // EADDRINUSE is expected in multi-instance mode; keep it as log only.
      if (err.code !== "EADDRINUSE") {
        void vscode.window.showWarningMessage(`VSCode Operator Proxy failed: ${this.lastError}`);
      }
    });

    const proxyPort = vscode.workspace.getConfiguration("vscodeOperator.mcpBridge").get<number>("port", 19191);

    let bound = false;
    await new Promise<void>((resolve) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          // Another VS Code instance already owns the proxy, that's fine
          this.appendLine(`MCP proxy port ${proxyPort} already in use, another instance is acting as proxy.`);
        } else {
          this.lastError = error.message;
          this.appendLine(`HTTP server error: ${this.lastError}`);
        }
        server.close();
        resolve();
      });
      server.listen(proxyPort, "127.0.0.1", () => {
        bound = true;
        resolve();
      });
    });

    if (!bound) {
      // Port occupied by another instance - proxy is already running
      return;
    }

    this.httpServer = server;
    this.lastError = undefined;
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "<no-workspace>";
    this.appendLine(`Proxy elected: current instance became proxy (pid=${process.pid}, workspace=${workspace})`);
    this.appendLine(`MCP proxy listening on http://127.0.0.1:${proxyPort}`);
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    this.bridges.clear();

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

    this.appendLine("MCP proxy stopped.");
  }

  dispose(): void {
    void this.stop();
    this.output.dispose();
  }

  private appendLine(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { method, url } = req;

    try {
      // Health check
      if (method === "GET" && url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", workspaces: [...this.bridges.keys()] }));
        return;
      }

      // Persistent SSE channel: Bridge connects here to register and stay alive
      if (method === "GET" && url?.startsWith("/bridge-channel")) {
        const urlObj = new URL(url, "http://127.0.0.1");
        const workspacePath = urlObj.searchParams.get("workspacePath");
        const host = urlObj.searchParams.get("host") ?? "127.0.0.1";
        const port = parseInt(urlObj.searchParams.get("port") ?? "0", 10);

        if (!workspacePath || !port) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "workspacePath and port are required" }));
          return;
        }

        // Keep the connection open as SSE
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        });

        // Register bridge
        this.bridges.set(workspacePath, { workspacePath, host, port });
        this.appendLine(`Bridge connected: ${workspacePath} at ${host}:${port} (bridges=${this.bridges.size})`);

        // Send periodic pings so we can detect dead connections from this side too
        const pingInterval = setInterval(() => {
          try {
            res.write("data: ping\n\n");
          } catch {
            clearInterval(pingInterval);
          }
        }, 15_000);

        // Auto-unregister when bridge closes the connection
        req.on("close", () => {
          clearInterval(pingInterval);
          this.bridges.delete(workspacePath);
          let removedSessions = 0;
          // Clean up any sessions that were routed to this bridge
          for (const [sid, b] of this.sessions) {
            if (b.workspacePath === workspacePath) {
              this.sessions.delete(sid);
              removedSessions++;
            }
          }
          this.appendLine(`Bridge disconnected: ${workspacePath} (removedSessions=${removedSessions}, bridges=${this.bridges.size})`);
        });

        return; // connection stays open
      }

      // Handle MCP requests - forward to appropriate bridge
      if (url && url.startsWith("/mcp")) {
        const urlObj = new URL(url, "http://127.0.0.1");
        const workspacePathFromUrl = urlObj.searchParams.get("workspacePath");
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

        // DELETE = session teardown
        if (method === "DELETE") {
          this.appendLine(`[${requestId}] MCP DELETE: sessionId=${sessionId ?? "<none>"}`);
          if (sessionId) {
            const bridge = this.sessions.get(sessionId);
            this.sessions.delete(sessionId);
            if (bridge) {
              this.appendLine(`[${requestId}] Route by session -> ${bridge.workspacePath}`);
              await this.forwardRequest(bridge, "DELETE", url, "", req.headers, res, requestId);
              return;
            }
          }
          res.writeHead(200); res.end(); return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", async () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            const rpcMethod: string = parsed.method ?? "";
            const isInitialize = rpcMethod === "initialize";
            this.appendLine(
              `[${requestId}] Incoming MCP ${method ?? "POST"} method=${rpcMethod || "<unknown>"} sessionId=${sessionId ?? "<none>"} queryWorkspace=${workspacePathFromUrl ?? "<none>"} payload=${this.safePreviewJsonBody(body)}`
            );

            let bridge: BridgeRegistration | undefined;

            // 1. Existing session → always route to the same bridge
            if (sessionId && !isInitialize) {
              bridge = this.sessions.get(sessionId);
              if (!bridge) {
                this.appendLine(`[${requestId}] Route failed: unknown session ${sessionId}`);
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Session not found or expired: ${sessionId}` }));
                return;
              }
              this.appendLine(`[${requestId}] Route by session -> ${bridge.workspacePath}`);
            }

            // 2. workspacePath-based routing (URL param preferred, then body)
            if (!bridge) {
              const workspacePath = this.extractWorkspacePathFromPayload(parsed as Record<string, unknown>, workspacePathFromUrl);
              if (workspacePath) {
                bridge = this.findBridgeByWorkspacePath(workspacePath);
                if (!bridge) {
                  this.appendLine(`[${requestId}] Route failed: workspace not registered ${workspacePath}`);
                  res.writeHead(404, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `No bridge registered for workspace: ${workspacePath}` }));
                  return;
                }
                this.appendLine(`[${requestId}] Route by workspace -> ${workspacePath}`);
              }
            }

            // 3. Fallback when workspace is still unspecified.
            if (!bridge) {
              if (this.bridges.size === 1) {
                bridge = [...this.bridges.values()][0];
                this.appendLine(`[${requestId}] Route by single-bridge fallback -> ${bridge.workspacePath}`);
              } else if (this.bridges.size === 0) {
                this.appendLine(`[${requestId}] Route failed: no bridge connected`);
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "No VS Code bridge is connected yet. Open a workspace in VS Code first." }));
                return;
              } else if (this.isGenericMcpMethod(rpcMethod)) {
                // Generic MCP methods are workspace-agnostic; pick a deterministic default bridge.
                bridge = [...this.bridges.values()].sort((a, b) => a.workspacePath.localeCompare(b.workspacePath))[0];
                this.appendLine(`[${requestId}] Route by multi-bridge generic-method fallback (${rpcMethod}) -> ${bridge.workspacePath}`);
              } else {
                this.appendLine(`[${requestId}] Route failed: multi-bridge requires workspacePath`);
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  error: "Multiple workspaces are open. Provide workspacePath in VS Code tool request arguments / resource URI query, or in /mcp?workspacePath=/path/to/workspace (recommended for initialize)."
                }));
                return;
              }
            }

            await this.forwardRequest(bridge, method || "POST", url, body, req.headers, res, requestId);
          } catch (error) {
            this.appendLine(`[${requestId}] Invalid MCP request: ${error instanceof Error ? error.message : String(error)}`);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: `Invalid request: ${error instanceof Error ? error.message : String(error)}`
              })
            );
          }
        });
        return;
      }

      // Unknown request
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Internal error: ${error instanceof Error ? error.message : String(error)}`
        })
      );
    }
  }

  private async forwardRequest(
    bridge: BridgeRegistration,
    method: string,
    url: string,
    body: string,
    reqHeaders: import("node:http").IncomingHttpHeaders,
    res: ServerResponse,
    requestId: string
  ): Promise<void> {
    // Forward relevant headers to the bridge
    const headers: Record<string, string | string[]> = {
      "content-type": (reqHeaders["content-type"] as string | undefined) ?? "application/json"
    };
    if (body.length > 0) {
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    for (const h of ["mcp-session-id", "accept", "last-event-id"] as const) {
      if (reqHeaders[h]) {
        headers[h] = reqHeaders[h] as string;
      }
    }

    const { request } = await import("node:http");
    this.appendLine(
      `[${requestId}] Forward -> ${bridge.host}:${bridge.port}${url} method=${method} headers=${this.summarizeText(JSON.stringify({
        sessionId: reqHeaders["mcp-session-id"] ?? null,
        accept: reqHeaders.accept ?? null,
        contentType: reqHeaders["content-type"] ?? null
      }))} payload=${this.safePreviewJsonBody(body)}`
    );
    const proxyReq = request(
      { hostname: bridge.host, port: bridge.port, path: url, method, headers },
      (proxyRes) => {
        // Capture mcp-session-id from initialize response to enable session routing
        const newSessionId = proxyRes.headers["mcp-session-id"] as string | undefined;
        if (newSessionId) {
          this.sessions.set(newSessionId, bridge);
          this.appendLine(`[${requestId}] Session established: ${newSessionId} -> ${bridge.workspacePath}`);
        }
        let responsePreview = "";
        let responseBytes = 0;
        proxyRes.on("data", (chunk: Buffer | string) => {
          const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          responseBytes += Buffer.byteLength(text);
          if (responsePreview.length < 1200) {
            responsePreview += text.slice(0, 1200 - responsePreview.length);
          }
        });
        proxyRes.on("end", () => {
          const contentType = String(proxyRes.headers["content-type"] ?? "");
          this.appendLine(
            `[${requestId}] Response <- status=${proxyRes.statusCode ?? 200} contentType=${contentType || "<unknown>"} bytes=${responseBytes} body=${this.summarizeText(responsePreview || "<stream/no-preview>")}`
          );
        });
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        // Pipe supports both plain JSON and SSE streaming responses
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (error) => {
      this.appendLine(`Error forwarding request to bridge: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Error reaching bridge: ${error instanceof Error ? error.message : String(error)}`
          })
        );
      }
    });

    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();
  }
}
