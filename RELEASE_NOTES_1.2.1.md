# VSCode Operator 1.2.1 Release Notes

## 中文

### 概览

`1.2.1` 是一个文档与使用规范更新版本，重点补充了 AI 使用调试器时的最佳实践，特别是调试会话的清理与复用边界。

本次版本基于 `1.2.0` 整理，主要面向以下问题进行改进：

- 避免 AI 误复用旧的调试会话
- 避免将前一次调试结论错误带入下一次调试
- 进一步降低 AI 在调试场景下的来回请求次数
- 让调试工具的推荐调用顺序更明确

### 重点更新

#### 1. 增强调试会话清理规则

已在 AI 指令与说明文档中明确要求：

- 启动新的调试会话前，先检查是否仍有旧会话存在
- 第二次及后续启动调试前，默认先断开之前的调试会话
- 如果前一次调试结果可能已经误用，必须先断开旧会话，再重新开始新的调试
- 调试分析完成后，如不再需要继续调试，应主动停止当前调试会话

这能显著降低 AI 误读旧状态、错误复用上下文的问题。

#### 2. 优化低往返调试流程说明

文档中进一步强化了推荐的低往返调试策略：

1. 优先调用 `vscodeOperator_debugSnapshot`
2. 仅在必要时再调用 `vscodeOperator_debugControl`
3. 仅在需要补充关键信息时调用 `vscodeOperator_debugEvaluate`
4. 如果需要重新跑一次调试，应先停止旧会话，再启动新会话

#### 3. 增加面向 AI 的调试提示模板

`README.md` 中新增了可直接复用的调试提示模板，帮助模型：

- 优先使用 `debugSnapshot`
- 避免不必要的额外工具调用
- 在结束调试后主动断开会话
- 在需要重新开始调试时，先停掉旧会话

#### 4. 同步架构文档

`ARCHITECTURE.md` 已同步更新，补充：

- 调试工具设计原则
- 调试会话卫生规则（session hygiene）
- 推荐的调试会话生命周期
- 低往返调试调用模式

### 变更文件

- `.github/copilot-instructions.md`
- `README.md`
- `ARCHITECTURE.md`

### 适合升级的人群

如果你正在使用 VSCode Operator 让 AI 参与调试，尤其是在以下场景中，建议升级到 `1.2.1`：

- 同一工作区内频繁重复启动调试
- AI 会连续多轮读取变量、调用栈和求值结果
- 希望减少调试时的上下文污染与误判
- 希望让模型更稳定地遵循统一调试流程

---

## English

### Overview

`1.2.1` is a documentation and usage-guidance release focused on improving how AI agents use the debugger, especially around debug session cleanup and stale-session avoidance.

This release is prepared on top of `1.2.0` and mainly improves the following areas:

- Preventing AI from accidentally reusing stale debug sessions
- Reducing the risk of carrying incorrect conclusions from a previous run into a new one
- Further reducing roundtrips in debugger-assisted workflows
- Making the recommended debugger tool flow more explicit

### Highlights

#### 1. Stronger debug session cleanup rules

The AI instructions and documentation now explicitly require that:

- A previous debug session should be checked before starting a new one
- For the second and later debug launches, the previous session should be stopped by default
- If previous debug results may have been misused, the old session must be stopped before starting a fresh run
- Once a debugging investigation is finished, the current session should be stopped if it is no longer needed

This helps reduce stale-state reuse and incorrect debugger context carry-over.

#### 2. Improved low-roundtrip debugging guidance

The recommended low-roundtrip flow is now documented more clearly:

1. Prefer `vscodeOperator_debugSnapshot` first
2. Use `vscodeOperator_debugControl` only when execution control is actually needed
3. Use `vscodeOperator_debugEvaluate` only for targeted follow-up inspection
4. If a fresh run is required, stop the old session before starting a new one

#### 3. Added AI-facing debugger prompt templates

`README.md` now includes reusable prompt templates that help models:

- prefer `debugSnapshot`
- avoid unnecessary extra tool calls
- stop sessions after investigations complete
- stop stale sessions before starting fresh debugging

#### 4. Architecture docs synchronized

`ARCHITECTURE.md` has been updated to reflect:

- debugger tool design principles
- debug session hygiene rules
- recommended debug session lifecycle
- low-roundtrip debugger call patterns

### Files Updated

- `.github/copilot-instructions.md`
- `README.md`
- `ARCHITECTURE.md`

### Recommended For

Upgrade to `1.2.1` if you use VSCode Operator for AI-assisted debugging, especially when:

- debug sessions are restarted frequently in the same workspace
- the AI performs repeated variable, stack, and evaluate inspections
- you want to reduce stale-context contamination during debugging
- you want the model to follow a more consistent debugger workflow
