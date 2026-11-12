# 3DBox 当前架构

## 项目定位

3DBox 是一个多智能体仿真沙盒。世界服务维护设备、任务、资源、通信、物理和仿真时间；Agent 通过受权限限制的观察和动作接口参与世界；Console 将快照和事件呈现为二维／三维控制台。

仓库仍是一个 Git 仓库，代码按层放在 `packages/` 下。根目录的部分 `src/*` 文件保留兼容入口，便于旧测试、脚本和外部调用继续工作。

## 分层与职责

### World

位置：`packages/world`，以及迁移中的根目录 `rust/`、`server/` 和领域模块。

World 是唯一的世界真值来源，负责：

- 场景和实体状态；
- 仿真时钟、固定步和世界事件；
- 任务、动作、资源、通信和环境规则；
- JS/WASM 与 Rust/Rapier 后端；
- 快照、回放、事件日志和事务回滚；
- 服务端会话和世界进程。

`packages/world/src/world-core.js` 是无头规则核心，`packages/world/src/world-runtime.js` 是对上层的运行时端口。普通 Agent、Console 和 LLM 不直接修改 World 对象。

### Control

位置：契约在 `packages/control`，独立服务在 `packages/control-server`。

Control 是独立的边界应用，不持有世界真值。它定义并提供：

- Action、Observation 和错误信封；
- Agent、协调者、管理员的权限边界；
- Axum HTTP 接口，供任何语言直接调用；
- RMCP Streamable HTTP 接口，供 Agent 通过 MCP 调用；
- 请求 ID、幂等、过期观察和重试语义；
- 到 World 服务的认证头转发和统一错误响应。

`packages/control/src/control-contracts.js` 不拥有世界状态。`packages/control-server` 使用
HTTP 代理把请求交给 World；`packages/world/src/control-api.js` 仍负责把语义能力
落到 World 运行时。调用方不需要安装 JS、Python 或其他语言客户端 SDK。

Control 的 MCP 工具从请求的 `Authorization: Bearer <agent-token>` 读取 Agent 凭据，
并把它转发给 World。这样 HTTP 和 MCP 共享同一套会话权限与审计边界。

### Agent

位置：`packages/agent`，以及 `sdk/python` 中的策略和示例。

Agent 层负责从观察生成动作：

- 规则策略；
- 路径和任务规划器；
- LLM Policy；
- 记忆、重试、动作预算和决策循环；
- 多 Agent 协作和协调器策略。

`packages/agent/src/agent-runtime.js` 只接收观察并调用策略。`packages/agent/src/llm-policy.js` 将外部模型输出限制为严格的 `{actions: [...]}` JSON，并执行超时、大小和动作数量限制。Agent 不获得 World 对象、Three.js 场景或 Rust 句柄。

### Console

位置：`packages/console`。

Console 只负责展示和人工操作：

- React 控制台、面板和样式；
- Three.js 场景、镜头和模型；
- 快照／事件到视图模型的转换；
- 回放、场景设置和人工控制；
- WebGL 状态、画质和资源加载。

入口和展示层已经迁入 `packages/console/src`：`app.html`、`mission-control.tsx`、`scene3d.js`、月面环境、水面展示、镜头、视觉运动和画质模块。根目录同名路径是兼容符号链接。面板依赖和部分世界领域模块仍通过兼容链接复用根目录代码。

Console 不直接调用 `world-core` 修改状态。它通过 Control 接口提交人工动作，并从快照和事件更新画面。

## 数据流

```text
Rule / LLM Policy
        │ observation / action
        ▼
Agent Runtime ── HTTP / MCP ──► Control Server
                                      │
Console ───────── HTTP ──────►         ▼
                              World Service
                                      │
                                      ▼
                 world-core + WASM/Rust/Rapier backend
                                      │
                             snapshot / events
                              ┌───────┴────────┐
                              ▼                ▼
                         Agent observe      Console view
```

World 只接受语义命令，不接受普通调用方直接改写位置、电量、任务状态或事件历史。一次动作是否完成由 World 在目标 tick 中决定。

## 运行单元

当前部署可以拆成四个运行单元：

1. World Service：运行场景和仿真时钟，持有唯一世界状态，监听 World HTTP/WebSocket。
2. Control Server：独立 Rust 进程，监听 Axum HTTP 和 RMCP MCP；它转发请求，不复制 World 状态。
3. Agent Runtime：规则或 LLM 进程，通过 Control HTTP 或 MCP 读取观察并提交动作。
4. Console：浏览器应用，通过 Control HTTP 提交人工命令；实时观察在迁移期间仍可使用 World WebSocket。

本地开发时可以把 Agent 逻辑嵌在任意宿主进程里，但它仍只能通过 Control
协议访问 World。生产部署时四个单元可以分别扩缩容，Control 和 Agent 不需要
链接 Rust 或 JavaScript SDK。

## 依赖方向

```text
control-contracts ───────► Control Server
                                  │ HTTP
                                  ▼
                           World Service
                                  ▲
                                  │ HTTP / WS
                              Console
```

允许的关系：

- World 使用共享契约和服务端 Control 适配器；
- Control Server 只调用 World 的公开 HTTP 接口；
- Agent 通过 HTTP 或 RMCP 调用 Control Server；
- Console 通过 HTTP 调用 Control Server；实时 WebSocket 在迁移期间仍兼容直连 World；
- Agent 不依赖 Console；
- World 不依赖 Agent 策略或 React/Three.js。

## 后端选择

`physicsMode` 决定是否使用运动学或 Rapier 碰撞；`BOX_PHYSICS_BACKEND` 决定 Rapier 的 JS/WASM 或 Rust 实现。WASM 适用于浏览器和默认本地服务，Rust 适用于原生服务端和已迁移的任务／通信后端。

这些后端属于 World 层实现细节。Control、Agent 和 Console 不应根据后端名称分支。

## 当前迁移状态

已完成：

- World Core 与运行时端口；
- World Core 直接依赖的主要领域模块已迁入 `packages/world/src`；
- World 服务的物理、Rust 绑定、日志和事务支持已迁入 `packages/world/server`；
- World Server、Rapier 适配器和构建脚本已优先读取迁移后的 World 模块；
- Control 契约和独立 Rust Control Server 骨架；
- Axum HTTP 代理与 `/health`；
- RMCP Streamable HTTP `/mcp` 及 Agent 工具；
- 规则 Agent 端到端链路；
- LLM Policy 基础适配器；
- Console 入口和三维展示层迁入 `packages/console`；
- 根目录兼容入口和单文件构建保持可用。

仍在迁移：

- World 的 Rust、server、场景和领域模块；
- World 的实验报告、回放视图和剩余纯领域工具；
- World HTTP/WS 入口与 Supervisor 仍保留在根目录，待应用入口迁入 `packages/world`；
- Console 面板依赖、纯视图模块和 3D 资源；
- Agent 和 Console 从直连 World 迁移到 Control Server；
- Control Server 的 HTTP/MCP 集成测试与部署配置；
- 前端对 World 内部模块的剩余兼容链接。

## 开发规则

新增世界规则时放入 World，不把业务状态写进 Console 或 Agent。新增外部能力时先定义 Control 契约，再接入客户端和策略。新增 LLM 时通过 `policy.decide()` 或 `complete()` 接入，模型输出必须经过严格 JSON 和 World 最终校验。新增 3D 模型时只改 Console 资源和展示适配，不把装饰网格当作碰撞真值。

## 常用验证

```sh
npm run test:world-core
npm run test:layers
npm run test:agent-http
npm run test:llm-policy
npm run test:control-server
npm run typecheck:ui
npm run build
```

`npm run build` 会生成根目录的单文件 `index.html`。该文件是构建产物，验证后不要把本机生成差异当成架构源码修改。
