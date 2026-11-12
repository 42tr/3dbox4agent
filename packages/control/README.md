# 3DBox Control Contracts

跨层共享的 Action/Observation 契约。它不拥有世界状态，也不包含 Agent 策略。

Control 的独立服务端位于 ../control-server，使用 Rust Axum 提供 HTTP 入口，
并使用 RMCP 提供 MCP 入口。调用方直接使用 HTTP 或 MCP 协议，不需要安装本目录
中的语言客户端；现有 agent-control-client.js 仅作为迁移期间的兼容代码保留。
