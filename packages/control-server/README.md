# Rust Control 接口

Control 以 Axum 提供 HTTP 接口，以 RMCP 提供 Streamable HTTP MCP。两种入口把凭据和语义请求转发给 World，由 World 校验角色、动作和会话状态。

## HTTP

本地默认地址为 `http://127.0.0.1:8789`。`CONTROL_BIND` 配置监听地址，`WORLD_URL` 配置上游，默认 `http://127.0.0.1:8787`。设置 `RUST_LOG` 可调整日志级别。启动命令见[项目 README](../../README.md#本地开发)。

| 请求 | 用途 |
| --- | --- |
| `GET /health` | 检查 Control 进程。 |
| `GET /world/health` | 读取 World 的健康状态和运行时能力。 |
| `POST /sessions` | 创建会话，返回会话 ID 和管理员令牌。 |
| `POST /sessions/:id/agents/:agentId/credentials` | 用管理员令牌签发设备凭据。 |
| `GET /sessions/:id/observations/:agentId` | 用设备令牌读取自身观察。 |
| `POST /sessions/:id/agents/:agentId/actions` | 提交语义动作。动作信封见[共享定义](../control/schemas/action.v1.schema.json)。 |

若已从 Console 获取设备凭据，可以使用页面生成的 `BOX_SESSION`、`BOX_AGENT` 和 `BOX_TOKEN`：

```sh
curl -fsS -H "Authorization: Bearer ${BOX_TOKEN}" \
  "http://127.0.0.1:8789/sessions/${BOX_SESSION}/observations/${BOX_AGENT}"
```

经 Console 同源访问时，HTTP 路径加上 `/control`。WebSocket 使用 Console 的 `/stream`，由 Console 转发到 World。

## Runner

Compose 部署启用版本化的 Runner 接口。Console 通过同源 `/control/runners/v1/*` 管理运行，Runner 通过 `/runners/v1/*` 注册和领取任务。配置、租约和接入示例见 [Runner 协议](../../docs/runner-protocol.md)。

## MCP

连接 `http://127.0.0.1:8789/mcp`，并携带 `Authorization: Bearer <agent-token>`。工具共有四个：

- `observe_agent` 读取自身观察。
- `submit_action` 提交动作。
- `cancel_action` 按请求 ID 取消动作。
- `send_agent_message` 通过仿真链路发送设备消息。

各工具都接收 `session_id` 和 `agent_id`。显式配置 `CONTROL_AGENT_TOKEN` 时，缺少授权头的 MCP 请求可使用该进程级令牌。工具失败时返回 `isError: true`，内容提供错误码和 HTTP 状态。

## 可选 gRPC 网关

先启动 World，然后从仓库根目录执行：

```sh
python3 -m pip install './sdk/python[grpc-stream]'
python3 packages/control-server/gateways/grpc/grpc_gateway.py --world-url http://127.0.0.1:8787
```

Python 网关监听 `127.0.0.1:8788`，直接连接 World，支持单次请求、授权观察流和管理员事件流。[gRPC 协议](../control/proto/agent.proto)

可用 `npm run test:control-server` 验证 HTTP、MCP 和 Console 转发。
