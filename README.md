# 3DBox 多智能体仿真

3DBox 用于模拟工业园区、月面基地和海岸场景中的多设备协作。可以在三维控制台运行任务、注入扰动、查看设备观察和回放，也可以用独立的 Agent 或协调器接入同一个世界。

## 启动

有 Docker Engine 和 Docker Compose 时，从仓库根目录运行：

```sh
docker compose up --build --wait
```

打开 `http://127.0.0.1:8787/`，点击 **连接世界服务**。Control 的 HTTP 和 MCP 入口在 `127.0.0.1:8789`。用 `BOX_HTTP_PORT` 或 `BOX_CONTROL_PORT` 调整宿主机端口。

默认 World 使用 JavaScript 规则，选择 Rapier 物理时使用 WASM。需要原生 Rust 后端时运行 `BOX_IMAGE_TARGET=world-rust docker compose up --build --wait`。

## 本地开发

使用 Node.js 22、Python 3.11 和 Rust 工具链。先在仓库根目录安装依赖并构建 Console：

```sh
npm ci
npm run build
```

直接打开 `packages/console/dist/index.html` 可以在浏览器中离线运行仿真。修改页面、场景或渲染代码后，重新构建页面。

要运行服务端仿真，在三个终端分别启动：

| 项目 | 命令 | 默认地址 |
| --- | --- | --- |
| World | `BOX_WORLD_API_ONLY=1 npm start --workspace @42tr/3dbox4agent-world` | `127.0.0.1:8787` |
| Rust Control | `cargo run --locked --manifest-path packages/control-server/Cargo.toml` | `127.0.0.1:8789` |
| Console | `npm start --workspace @42tr/3dbox4agent-console` | `127.0.0.1:8780` |

打开 Console 地址并连接世界。Agent runner 可另开终端启动：

```sh
npm run start:python --workspace @42tr/3dbox4agent-agent -- --fault none --archive
```

## 验证

```sh
npm run test:ui               # Console 与类型检查
npm run test:control-server   # Console、Rust Control 和 World 联调
npm run test:container        # Docker 集成验收
npm run test:container-rust   # Docker 原生后端验收
```

运行 `npm test` 可执行主回归套件。涉及原生后端时先执行 `npm run build:rust-physics`，涉及 Python 实时流时安装 `./sdk/python[grpc-stream]`。

## 指南

- [项目结构、服务边界与数据持久化](docs/architecture.md)
- [场景、实验与回放](docs/scenarios.md)
- [Control HTTP、MCP 和 gRPC 网关](packages/control-server/README.md)
- [Python SDK](sdk/python/SDK-README.md)
- [构建部署包、远程访问和代理配置](deploy/README.md)
