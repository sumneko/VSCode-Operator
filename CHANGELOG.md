# Changelog

## 1.2.11

- MCP 端指令补充断点触发处理规则：外部 MCP 客户端通过 initialize 指令与 usage 资源即可获得"断点触发时检查附近代码、用工具读取行内容、断点行尚未执行"的说明。 / Added breakpoint-handling guidance to MCP-facing instructions: external MCP clients now receive breakpoint rules (inspect surrounding code, read lines via tools, the breakpoint line has not executed yet) through initialize instructions and the usage resource.
- 补充 VS Code 内置 Copilot Agent 的断点处理说明，明确断点行处于"即将执行"状态。 / Added breakpoint-handling guidance for the in-editor Copilot Agent, clarifying that the breakpoint line is in "about to execute" state.

## 1.2.10

- 补齐多工作区参数声明：为核心工具与调试工具输入类型补充可选 `workspacePath`，减少路由场景下的参数校验报错。 / Completed multi-workspace parameter declarations: added optional `workspacePath` to core and debugger tool inputs to reduce validation errors in routed calls.
- 修复 MCP 兼容别名参数透传：`get_problems/get_diagnostics/hover/get_hover_info` 现在声明并转发 `workspacePath`，多工作区下路由更稳定。 / Fixed MCP alias parameter passthrough: `get_problems/get_diagnostics/hover/get_hover_info` now declare and forward `workspacePath`, improving routing stability in multi-workspace mode.

## 1.2.9

- 修复多工作区路由参数透传问题：bridge server 在调用工具前会过滤掉工具 schema 中未声明的路由参数（如 `workspacePath`），避免 `activeEditorSummary`/`hoverTopVisible` 等无参工具因收到多余字段而报错。 / Fixed routing-parameter leakage in multi-workspace mode: the bridge server now strips routing-only parameters (e.g. `workspacePath`) that are not declared in the target tool's input schema, preventing spurious "unsupported fields" errors on no-parameter tools such as `activeEditorSummary` and `hoverTopVisible`.

## 1.2.8

- 统一调试状态语义：为 `stopKind/isException/paused/exception` 增加共享归一化逻辑，避免字段组合互相矛盾。 / Unified debug-state semantics: added shared normalization for `stopKind/isException/paused/exception` to prevent contradictory field combinations.
- 修复异常停靠漏判：`debugGetExceptionInfo` 现在始终执行有界实时停靠探测，即使缺少缓存 `stopState` 也能正确识别异常停靠。 / Fixed exception-stop false negatives: `debugGetExceptionInfo` now always performs bounded live pause probing, so exception stops are detected even when cached `stopState` is missing.

## 1.2.7

- 修复运行态超时：`debugGetExceptionInfo/debugStatus/debugGetTopFrame/debugSnapshot` 增加有界探测，目标未停靠时快速返回，避免请求挂起。 / Fixed runtime timeout behavior: added bounded probing in `debugGetExceptionInfo/debugStatus/debugGetTopFrame/debugSnapshot` so calls return quickly when the target is running instead of hanging.
- 改进状态一致性：`debugStatus` 在缺少缓存停靠事件时增加实时线程与栈帧兜底，异常/断点判定更稳定。 / Improved state consistency: `debugStatus` now falls back to live thread and top-frame probing when cached stop events are missing, making exception/breakpoint classification more reliable.

## 1.2.6

- 修复异常误判：普通断点不再因调试适配器支持 `exceptionInfo` 而被标记为异常停靠。 / Fixed false exception classification: normal breakpoints are no longer marked as exception stops just because the adapter supports `exceptionInfo`.
- 改进停靠状态一致性：在缺少 `stopped` 原因时，基于栈帧与断点位置推断 `paused/stopKind`，减少 `paused=false` 与栈帧并存的矛盾输出。 / Improved stop-state consistency: when `stopped` reason is unavailable, infer `paused/stopKind` from top frame and breakpoint location to avoid contradictory outputs like `paused=false` with a valid stack frame.

## 1.2.5

- 优化异常信息返回：仅在 `isException=true` 的异常停靠场景返回 `exception` 详情，减少普通断点与单步时的噪音。 / Refined exception payload behavior: `exception` details are returned only when `isException=true` (exception stops), reducing noise on normal breakpoints and stepping.
- 增加异常判定一致性：统一输出 `isException` 语义，并在调试适配器可用时补充异常能力探测结果。 / Improved exception classification consistency: unified `isException` semantics and added adapter exception-capability probing output when available.

## 1.2.4

- 调整调试快照输出：`debugSnapshot` 不再返回 `exception` 字段，避免误判异常断点。 / Updated debug snapshot output: `debugSnapshot` no longer returns the `exception` field to avoid exception-stop misclassification.
- 明确异常断点判定入口：需使用 `debugGetExceptionInfo` 判断当前是否为异常断点。 / Clarified exception-stop detection: use `debugGetExceptionInfo` to determine whether the current stop is an exception.

## 1.2.3

- 增强调试异常处理：`debugSnapshot/debugStatus/debugGetTopFrame` 现在返回 `stopKind/stopState/stopHint`，可区分 `exception` 与普通断点。 / Improved exception-stop handling: `debugSnapshot/debugStatus/debugGetTopFrame` now return `stopKind/stopState/stopHint` to distinguish `exception` from normal breakpoints.
- 补充 DAP 参数与异常断点处理提示，降低 AI 误判和参数误传。 / Added DAP-parameter and exception-stop guidance to reduce AI misclassification and invalid debug arguments.

## 1.2.2

- 强化 AI 调试防误用：默认要求新调试前先清理旧会话，并补充 DAP 参数获取提示（threadId/frameId/variablesReference）。 / Strengthened safe AI debugging: enforce stop-before-start guidance and added DAP parameter acquisition hints (threadId/frameId/variablesReference).

## 1.2.1

- 完善 AI 调试器使用说明，增加调试会话清理规则与低往返调试提示模板。 / Improved AI debugger guidance with session cleanup rules and low-roundtrip prompt templates.

## 1.2.0

- 新增 AI 可调用的调试器工具，支持断点、线程、调用栈、变量、求值与调试快照。 / Added AI-facing debugger tools for breakpoints, threads, stack traces, variables, evaluate, and debug snapshots.

## 1.1.3

- 问题面板读取支持筛选。 / Added filtering support for Problems panel reading.

## 1.1.2

- 常规更新。 / General maintenance update.

## 1.1.1

- 调整 git 与项目命名相关内容。 / Adjusted git and project naming-related metadata.

## 1.1.0

- 支持多工作区 MCP 路由，并补充指定文件能力与若干修复。 / Added multi-workspace MCP routing, specific-file support, and several fixes.

## 1.0.1

- 增强补全能力。 / Improved completion capabilities.

## 1.0.0

- 发布 1.x 首个正式版本，建立核心 VS Code Operator 工具集。 / First stable 1.x release with the core VS Code Operator toolset.

## 0.0.1

- 初始化 VS Code 扩展与 MCP 服务框架。 / Initial scaffold for the VS Code extension and MCP server framework.
