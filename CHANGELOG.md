# Changelog

## Unreleased

- Added debugger tool suite for AI-driven debugging:
	- start/stop/control sessions
	- set/clear breakpoints
	- inspect threads, stack frames, scopes, and variables
	- evaluate expressions in debug context
	- one-shot `debugSnapshot` tool to reduce request roundtrips
- Added path and severity filtering to `vscodeOperator_readProblems`:
	- `minSeverity` (default `warning`)
	- `pathGlob` supports absolute/relative globs
	- supports comma-separated patterns, array patterns, and `!` exclusions
- Updated MCP/tool metadata and documentation to reflect new debugger capabilities.

## 0.0.1

- Initial scaffold for VS Code extension with MCP server framework.
