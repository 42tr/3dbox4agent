# 架构与运行边界

| 目录 | 职责 |
| --- | --- |
| [packages/world](../packages/world) | 仿真内核、会话、物理、HTTP/WebSocket、日志、实验目录与回放。Supervisor 为每个会话启动独立 Worker。 |
| [packages/control-server](../packages/control-server) | Rust HTTP 与 MCP 服务。转发请求和凭据，由 World 校验权限并执行命令。可选 Python gRPC 网关位于 `gateways/grpc/`。 |
| [packages/agent](../packages/agent) | JS Agent 运行时、LLM 适配器，以及独立运行的 Python 设备策略、协调器和实验 runner。 |
| [packages/console](../packages/console) | React/Three.js 控制台、资源及同源入口。离线预览在浏览器里运行 World 的 JS 内核。 |
| [packages/control](../packages/control) | [版本化 JSON 信封](../packages/control/schemas)、[Protobuf 定义](../packages/control/proto)及 JS 校验与传输适配。 |
| [sdk/python](../sdk/python) | 可独立安装的 `box_agent` 客户端。 |

这四个应用各有 Dockerfile。仓库根目录管理 npm 工作区、Compose 和跨项目测试。根目录的旧脚本与导入路径仍可用，新代码放在对应的项目内。

## 请求和凭据

- 在线 Console 将同源 `/control/*` 发给 Control，将 `/stream` 的 WebSocket 升级转发给 World。在 Docker 中，宿主机的 8787 由 Console 提供，World 使用内部服务地址。
- 设备和协调器通过 Control 提交语义操作并读取授权观察。Python runner 单独使用管理员凭据创建和推进 World 会话。动作是否接受、何时执行以及最终状态都由 World 决定。
- 管理员负责配置、推进和签发凭据。观察者读取授权的全局快照与实时流，设备和协调器使用各自范围的观察和操作。导入回放时，Console 使用本地文件中的快照。
- JS 策略实现 `policy.decide(observation, context)`。LLM 适配器通过注入的 `complete()` 获取 `{actions: [...]}`，再检查输出大小、超时和动作数量。具体动作仍由 World 校验。

## 后端与本地配置

`physicsMode` 是会话配置，可选 `kinematic` 或 `rapier`。World 的后端由进程环境决定。在本地构建原生模块并启用原生物理、任务、通信和寻路时运行：

```sh
npm run build:rust-physics
BOX_PHYSICS_BACKEND=rust BOX_TASK_BACKEND=rust BOX_COMM_BACKEND=rust BOX_NAV_BACKEND=rust \
  BOX_WORLD_API_ONLY=1 npm start --workspace @42tr/3dbox4agent-world
```

- World 使用 `WORLD_BIND`、`WORLD_PORT` 和 `BOX_WORLD_WORKERS`。默认最多 4 个并发 Worker。
- Console 使用 `CONSOLE_BIND`、`CONSOLE_PORT`、`BOX_CONTROL_URL` 和 `BOX_WORLD_URL`。如果修改上游端口，更新 Console 对应的 URL。Control 的设置见[接口指南](../packages/control-server/README.md)。

## 数据与回放

活动会话和凭据存在内存中，服务重启会结束这些会话。Compose 将事件日志和实验目录 SQLite 存在 `world-data` 卷中。源码 Compose 可用 `BOX_REPLAY_JOURNAL=0` 只写事件。本地运行 World 时可用 `BOX_EVENT_JOURNAL_DIR` 启用日志，再设置 `BOX_REPLAY_JOURNAL=1` 保存可分支的快照。

导出报告保留服务仍持有的历史，可能从中途开始。新版可以读取受支持格式的旧回放。从持久快照创建可继续推进的分支时，World 会核对运行时指纹，包括源码、依赖和后端。升级后需要继续旧实验时，保留原镜像或对应的运行时版本及日志访问凭据。
