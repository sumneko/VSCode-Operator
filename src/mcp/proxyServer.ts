import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

  async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    server.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.appendLine(`HTTP server error: ${this.lastError}`);
      void vscode.window.showWarningMessage(`VSCode Operator Proxy failed: ${this.lastError}`);
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
        this.appendLine(`Bridge connected: ${workspacePath} at ${host}:${port}`);

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
          // Clean up any sessions that were routed to this bridge
          for (const [sid, b] of this.sessions) {
            if (b.workspacePath === workspacePath) {
              this.sessions.delete(sid);
            }
          }
          this.appendLine(`Bridge disconnected: ${workspacePath}`);
        });

        return; // connection stays open
      }

      // Handle MCP requests - forward to appropriate bridge
      if (url && url.startsWith("/mcp")) {
        const urlObj = new URL(url, "http://127.0.0.1");
        const workspacePathFromUrl = urlObj.searchParams.get("workspacePath");
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        // DELETE = session teardown
        if (method === "DELETE") {
          if (sessionId) {
            const bridge = this.sessions.get(sessionId);
            this.sessions.delete(sessionId);
            if (bridge) {
              await this.forwardRequest(bridge, "DELETE", url, "", req.headers, res);
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

            let bridge: BridgeRegistration | undefined;

            // 1. Existing session → always route to the same bridge
            if (sessionId && !isInitialize) {
              bridge = this.sessions.get(sessionId);
              if (!bridge) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Session not found or expired: ${sessionId}` }));
                return;
              }
            }

            // 2. workspacePath-based routing (URL param preferred, then body)
            if (!bridge) {
              const workspacePath: string | null =
                workspacePathFromUrl ??
                parsed.params?.arguments?.workspacePath ??
                parsed.params?.workspacePath ??
                null;
              if (workspacePath) {
                bridge = this.bridges.get(workspacePath);
                if (!bridge) {
                  res.writeHead(404, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `No bridge registered for workspace: ${workspacePath}` }));
                  return;
                }
              }
            }

            // 3. Fallback: only one bridge open → auto-route
            if (!bridge) {
              if (this.bridges.size === 1) {
                bridge = [...this.bridges.values()][0];
              } else if (this.bridges.size === 0) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "No VS Code bridge is connected yet. Open a workspace in VS Code first." }));
                return;
              } else {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  error: "Multiple workspaces are open. Specify workspacePath as a URL query parameter: /mcp?workspacePath=/path/to/workspace"
                }));
                return;
              }
            }

            await this.forwardRequest(bridge, method || "POST", url, body, req.headers, res);
          } catch (error) {
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
    res: ServerResponse
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
    const proxyReq = request(
      { hostname: bridge.host, port: bridge.port, path: url, method, headers },
      (proxyRes) => {
        // Capture mcp-session-id from initialize response to enable session routing
        const newSessionId = proxyRes.headers["mcp-session-id"] as string | undefined;
        if (newSessionId) {
          this.sessions.set(newSessionId, bridge);
        }
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
