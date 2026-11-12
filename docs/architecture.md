# 3DBox 当前架构

## 项目定位

3DBox 是一个多智能体仿真沙盒。世界服务维护设备、任务、资源、通信、物理和仿真时间；Agent 通过受权限限制的观察和动作接口参与世界；Console 将快照和事件呈现为二维／三维控制台。

仓库仍是一个 Git 仓库，代码按层放在 `packages/` 下。根目录的部分 `src/*` 文件保留兼容入口，便于旧测试、脚本和外部调用继续工作。

## 分层与职责

### World

位置：`packages/world`。场景在 `scenes/`，Rust/Rapier 源码在 `native/physics/`。

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

位置：`packages/agent`。Python 策略、协调器和 runner 位于 `packages/agent/python`，可安装的 Python 客户端位于 `sdk/python`。

Agent 层负责从观察生成动作：

- 规则策略；
- 路径和任务规划器；
- LLM Policy；
- 记忆、重试、动作预算和决策循环；
- 多 Agent 协作和协调器策略。

`packages/agent/src/agent-runtime.js` 只接收观察并调用策略。`packages/agent/src/llm-policy.js` 将外部模型输出限制为严格的 `{actions: [...]}` JSON，并执行超时、大小和动作数量限制。Agent 不获得 World 对象、Three.js 场景或 Rust 句柄。

### Console

位置：`packages/console`。

Console 负责展示和人工操作：

- React 控制台、面板和样式；
- Three.js 场景、镜头和模型；
- 快照／事件到视图模型的转换；
- 回放、场景设置和人工控制；
- WebGL 状态、画质和资源加载。

Console 的入口、React 面板和三维展示模块位于 `packages/console/src`，模型与纹理位于 `packages/console/assets`。Console 通过 npm 工作区依赖 World 的公开浏览器模块，构建产物位于 `packages/console/dist/index.html`。

在线 Console 通过 Control 提交人工动作，并从 World 的快照和事件更新画面。离线预览在浏览器内运行 World 内核。

## 数据流

```text
Agent Runtime ─── HTTP / MCP ──► Control Server ── HTTP ──► World
Console       ─── /control ────► Control Server
Console       ◄── /stream ──────────────────────────────── World
```

World 只接受语义命令，不接受普通调用方直接改写位置、电量、任务状态或事件历史。一次动作是否完成由 World 在目标 tick 中决定。

## 运行单元

Compose 为四个运行单元分别构建镜像。World 和 Control 通过内部服务名互连，Console 对外提供页面。

1. World Service：运行场景和仿真时钟，持有唯一世界状态，监听 World HTTP/WebSocket。
2. Control Server：独立 Rust 进程，监听 Axum HTTP 和 RMCP MCP；它转发请求，不复制 World 状态。
3. Agent Runtime：规则或 LLM 进程，通过 Control HTTP 或 MCP 读取观察并提交动作。
4. Console：提供构建后的页面，将同源 `/control` 转发到 Control，并将 `/stream` 转发到 World。

Agent 可以独立启动。Python 实验 runner 将会话管理和实时观察发到 World，将设备与协调器的 HTTP 请求发到 Control。
需要兼容 gRPC 时，可以在 runner 所在的环境启动 Python 网关并为它配置 World 地址。

本地开发可在仓库根目录先运行 `npm ci` 和 `npm run build`，然后在不同终端启动各项目。

```sh
BOX_WORLD_API_ONLY=1 npm start --workspace @42tr/3dbox4agent-world
cargo run --locked --manifest-path packages/control-server/Cargo.toml
npm start --workspace @42tr/3dbox4agent-console
npm run start:python --workspace @42tr/3dbox4agent-agent -- --fault none --archive
```

Console 默认监听 `127.0.0.1:8780`，Control 监听 `127.0.0.1:8789`，World 监听 `127.0.0.1:8787`。

## 依赖方向

- World 使用共享契约和服务端 Control 适配器；
- Control Server 只调用 World 的公开 HTTP 接口；
- Agent 通过 HTTP 或 RMCP 调用 Control Server；
- Console 的 HTTP 入口将 `/control` 转发到 Control Server，将实时 WebSocket 转发到 World 的 `/stream`；
- Agent 不依赖 Console；
- World 不依赖 Agent 策略或 React/Three.js。

## 后端选择

`physicsMode` 决定是否使用运动学或 Rapier 碰撞；`BOX_PHYSICS_BACKEND` 决定 Rapier 的 JS/WASM 或 Rust 实现。WASM 适用于浏览器和默认本地服务，Rust 适用于原生服务端和已迁移的任务／通信后端。

这些后端属于 World 层实现细节。Control、Agent 和 Console 不应根据后端名称分支。

## 当前迁移状态

- npm 工作区管理 World、Agent、Console 和共享协议包的依赖。
- World 的服务、内置场景、Rust/Rapier 源码和实验目录工具归入 World 包。
- Console 从自身目录构建和检查类型。根目录的 `index.html` 指向当次构建的产物。
- Python Agent 与协调器脚本归入 Agent。旧脚本路径继续可用。
- JSON 信封和 Protobuf 定义归入共享协议包。可选 Python gRPC 网关位于 `packages/control-server/gateways/grpc`，目前仍调用 World。
- 实验报告解析、回放和定时计划校验位于 World。Console 从各工作区构建页面和资源。
- Compose 通过服务名访问各服务。离线部署包保存四个镜像，跨项目 HTTP、MCP、WebSocket、发布和日志分支测试位于 `tests/integration`。

事件日志分支会比对源会话的运行时指纹，源码路径和锁文件也是指纹的一部分。
需要在升级后继续旧实验时，保留生成日志时的镜像或代码版本，并用对应的 World 运行时创建分支。
新版仍可读取受支持格式的回放。

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
npm run test:console-artifact
npm run test:container
npm run test:container-rust
npm run build
```

`npm run build` 生成 `packages/console/dist/index.html`。可直接打开该文件运行离线预览。
