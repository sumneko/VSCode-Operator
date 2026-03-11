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
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  if (request.params.name !== "echo") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const parsed = EchoArgsSchema.parse(request.params.arguments ?? {});

  return {
    content: [
      {
        type: "text",
        text: `Echo: ${parsed.message}`
      }
    ]
  };
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
