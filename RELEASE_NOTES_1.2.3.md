# VSCode Operator 1.2.3 Release Notes

## 中文

### 更新摘要

- 调试工具新增停止原因识别，AI 可以区分异常断点与普通断点。
- `debugSnapshot`、`debugStatus`、`debugGetTopFrame` 现在返回 `stopKind/stopState/stopHint`。
- 增强 DAP 参数提示，减少 `threadId/frameId/variablesReference` 误传。
- 补充异常断点处理建议：先看异常信息与调用栈，再决定继续或单步。

### 影响

- 降低 AI 在调试异常场景下误判为普通断点的概率。
- 降低因 DAP 参数不正确导致的调试调用失败。

## English

### Summary

- Added stop-reason awareness so AI can distinguish exception stops from normal breakpoints.
- `debugSnapshot`, `debugStatus`, and `debugGetTopFrame` now return `stopKind/stopState/stopHint`.
- Improved DAP parameter hints to reduce invalid `threadId/frameId/variablesReference` usage.
- Added guidance for exception-stop handling: inspect exception details and stack first, then decide to continue or step.

### Impact

- Reduces AI misclassification in exception-stop scenarios.
- Reduces debugger call failures caused by invalid DAP arguments.
