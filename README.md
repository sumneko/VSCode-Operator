# CodePilot VS Code Extension

This project is a TypeScript VS Code extension that provides native tools for Copilot in the editor context.

## What is included

- VS Code extension entry: `src/extension.ts`
- Problems feature module: `src/features/problemsTool.ts`
- TypeScript compile pipeline: `npm run compile`

## Development

```bash
npm install
npm run compile
```

Press `F5` to launch an Extension Development Host. Copilot can then invoke the `codepilot_readProblems` language model tool.
