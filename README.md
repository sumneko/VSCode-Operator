# CodePilot MCP VS Code Extension

This project is a TypeScript VS Code extension scaffold that includes an embedded MCP server framework.

## What is included

- VS Code extension entry: `src/extension.ts`
- MCP stdio server: `src/mcp/server.ts`
- MCP client config for VS Code: `.vscode/mcp.json`
- TypeScript compile pipeline: `npm run compile`

## Development

```bash
npm install
npm run compile
```

Press `F5` to launch an Extension Development Host, then run:

- `CodePilot: Start MCP Server`
- `CodePilot: Stop MCP Server`

## MCP SDK references

- Official MCP organization: `https://github.com/modelcontextprotocol`
- TypeScript SDK repository: `https://github.com/modelcontextprotocol/typescript-sdk`
- MCP documentation: `https://modelcontextprotocol.io/`

`https://modelcontextprotocol.io/llms-full.txt` was consulted but could not be parsed by tooling in this environment.
