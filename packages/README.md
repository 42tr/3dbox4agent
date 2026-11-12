# 3DBox 分层目录

完整架构说明见 docs/architecture.md。

仓库保持单一 Git，按层组织代码：

- `packages/world` 保存仿真内核、HTTP/WebSocket 服务、场景、Rust/Rapier 模块和实验目录工具。
- `packages/control` 保存共享契约、Protobuf 定义和 HTTP 适配器。
- `packages/control-server` 是提供 Axum HTTP 和 RMCP MCP 的 Rust 服务。可选 Python gRPC 网关在 `gateways/grpc`。
- `packages/agent` 保存 JS 运行时、LLM 适配以及 Python Agent、协调器和实验 runner。
- `packages/console` 保存 React/Three.js 控制台、面板和资源，并生成 `dist/index.html`。
- `sdk/python` 提供可单独安装的 `box_agent` 客户端库。

在仓库根目录运行 `npm ci` 安装 npm 工作区依赖。根目录保留旧命令和导入路径，供现有调用方逐步迁移。
