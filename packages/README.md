# 3DBox 分层目录

完整架构说明见 [`docs/architecture.md`](../docs/architecture.md)。

仓库保持单一 Git，按层组织代码：

- `packages/world`：世界运行时和服务端适配；当前 `world-core` 仍在根目录，运行时端口已迁入；
- `packages/control`：跨层协议契约与客户端；
- `packages/agent`：规则、规划器和 LLM 策略；
- `packages/console`：React/Three.js 前端迁移目标。

根目录 `src/*` 目前保留兼容入口，确保已有 Node 服务、浏览器构建和测试继续工作。迁移按依赖方向逐步进行。
