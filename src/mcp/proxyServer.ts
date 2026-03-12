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
          this.appendLine(`Bridge disconnected: ${workspacePath}`);
        });

        return; // connection stays open
      }

      // Handle MCP requests - forward to appropriate bridge
      if (url && url.startsWith("/mcp")) {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", async () => {
          try {
            // Parse the MCP request to extract workspacePath
            const request = body ? JSON.parse(body) : {};
            const workspacePath = request.params?.workspacePath || request.workspacePath;

            if (!workspacePath) {
              // No workspace path provided, return error
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "workspacePath parameter is required in request"
                })
              );
              return;
            }

            const bridge = this.bridges.get(workspacePath);
            if (!bridge) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: `No bridge registered for workspace: ${workspacePath}`
                })
              );
              return;
            }

            // Forward request to the appropriate bridge
            await this.forwardRequest(bridge, method || "GET", url, body, res);
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
    res: ServerResponse
  ): Promise<void> {
    const options = {
      hostname: bridge.host,
      port: bridge.port,
      path: url,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const { request } = await import("node:http");
    const proxyReq = request(options, (proxyRes) => {
      let responseBody = "";
      proxyRes.on("data", (chunk) => {
        responseBody += chunk;
      });
      proxyRes.on("end", () => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        res.end(responseBody);
      });
    });

    proxyReq.on("error", (error) => {
      this.appendLine(`Error forwarding request to bridge: ${error instanceof Error ? error.message : String(error)}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Error reaching bridge: ${error instanceof Error ? error.message : String(error)}`
        })
      );
    });

    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();
  }
}
