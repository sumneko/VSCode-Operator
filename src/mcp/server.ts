import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsResult
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const EchoArgsSchema = z.object({
  message: z.string().describe("Message to echo back")
});

const ReadProblemsArgsSchema = z.object({
  maxItems: z.number().int().positive().max(500).optional().describe("Maximum number of problems to return")
});

type ProblemItem = {
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

type ReadProblemsResponse = {
  type: "readProblemsResponse";
  requestId: string;
  problems: ProblemItem[];
};

function requestProblemsFromHost(timeoutMs = 3000): Promise<ProblemItem[]> {
  if (typeof process.send !== "function") {
    throw new Error("MCP server is not running with an IPC channel.");
  }

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      const message = raw as ReadProblemsResponse;
      if (!message || message.type !== "readProblemsResponse" || message.requestId !== requestId) {
        return;
      }

      cleanup();
      resolve(Array.isArray(message.problems) ? message.problems : []);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while reading VS Code problems panel."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      process.off("message", onMessage);
    };

    process.on("message", onMessage);
    process.send?.({ type: "readProblemsRequest", requestId });
  });
}

const server = new Server(
  {
    name: "codepilot-dev-helper",
    version: "0.0.1"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
  return {
    tools: [
      {
        name: "echo",
        description: "Echo back a message",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message to echo"
            }
          },
          required: ["message"]
        }
      },
      {
        name: "read_problems",
        description: "Read items from the VS Code Problems panel",
        inputSchema: {
          type: "object",
          properties: {
            maxItems: {
              type: "number",
              description: "Maximum number of problems to return (default 200)"
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  if (request.params.name === "echo") {
    const parsed = EchoArgsSchema.parse(request.params.arguments ?? {});

    return {
      content: [
        {
          type: "text",
          text: `Echo: ${parsed.message}`
        }
      ]
    };
  }

  if (request.params.name === "read_problems") {
    const parsed = ReadProblemsArgsSchema.parse(request.params.arguments ?? {});
    const maxItems = parsed.maxItems ?? 200;
    const problems = await requestProblemsFromHost();
    const sliced = problems.slice(0, maxItems);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total: problems.length,
              returned: sliced.length,
              items: sliced
            },
            null,
            2
          )
        }
      ]
    };
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
