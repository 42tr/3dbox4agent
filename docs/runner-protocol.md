# Runner 接入协议 v1

内置 Runner 默认随 Compose 常驻，`/health` 返回注册状态和当前运行 ID。Console 通过 Control 配置和启动实验，Runner 主动向 Control 请求任务。默认入口为 `/runners/v1`，浏览器通过同源 `/control/runners/v1` 访问。

## 注册和领取任务

1. 部署管理员配置 `BOX_RUNNER_OPERATOR_TOKEN`。在 Console 的 **Runner 实验 → 管理令牌与外部 Runner** 应用令牌并签发 `runnerId` 和 `runnerToken`。
2. 外部进程持 Runner Token 调用 `POST /runners/{runnerId}/register`，提交 `protocolVersion: 1` 和 `capabilities`。能力包括场景、物理模式、故障模式、策略标识、协调器上限和并发数。重连时重新注册。
3. 调用 `POST /runners/{runnerId}/claim` 领取任务。无任务时返回 `{"job":null}`。有任务时返回 `job`，内含 `runId`、`leaseToken`、`leaseSeconds` 和 `config`。空闲 Runner 应定期领取以更新在线状态。内置 Runner 每 0.5 秒检查队列。
4. 使用 Lease Token 调用 `POST /runs/{runId}/heartbeat` 续约。当前租约为 15 秒，建议每 2 秒续约。租约失效时停止本地执行，Control 会回收这次运行及会话。重新执行时由 Console 提交新的运行。
5. 结束时调用 `POST /runs/{runId}/finish`，提交 `status` 为 `completed`、`failed` 或 `timeout`，可带简短的 `reason` 代码。Control 会核验 World 是否完成，保存可用回放并关闭会话。停止由 Console 发起，Runner 从租约拒绝响应获知。

请求用 JSON，凭据使用 `Authorization: Bearer <token>`。请求结构见 [Runner v1 JSON Schema](../packages/control/schemas/runner.v1.schema.json)。

## 运行会话

使用 Lease Token 调用 `POST /runs/{runId}/session`。Control 根据已验证的运行配置创建独立 World 会话，重复调用返回同一个会话。响应包含 `sessionId`、场景和初始快照。管理员凭据由 Control 保管。

仿真请求使用 `/runs/{runId}/world/sessions/{sessionId}` 下的路径。World 继续使用现有的动作和观察定义，Runner 可以用任意语言实现策略。

| 路径相对于会话 | 方法 | 凭据 |
| --- | --- | --- |
| 根路径 | GET | Lease Token |
| `/step`，请求体 `{"count":1}` | POST | Lease Token |
| `/fault` | POST | Lease Token |
| `/coordinator/credentials` 或 `/coordinators/{nodeId}/credentials` | POST | Lease Token |
| `/agents/{agentId}/credentials` | POST | Lease Token |
| `/coordinator/observation` | GET | Coordinator Token |
| `/coordinator/decisions`、`/coordinator/revocations`、`/coordinator/proposals` | POST | Coordinator Token |
| `/observations/{agentId}` | GET | 对应 Agent Token |
| `/agents/{agentId}/actions`、`/actions/cancel`、`/messages`、`/lidar`、`/sample-reports` | POST | 对应 Agent Token |

运行凭据只对该运行和会话生效。收到 `runner_lease_inactive` 时停止本地执行。v1 使用固定步长，推进前应等待协调器分配和设备动作提交。Progress 来自 World 的推进结果，回放由 World 的实验目录生成，格式为 `3dbox-prototype-v1`。

## Console 管理接口

| 路径 | 用途 |
| --- | --- |
| `GET /runners`、`POST /runners` | 查看注册和在线状态，签发外部 Runner 凭据。 |
| `DELETE /runners/{runnerId}` | 撤销外部 Runner 的接入凭据和运行租约。 |
| `GET /runs`、`GET /runs/{runId}` | 查看运行状态、进度、错误和回放是否可用。 |
| `POST /runs` | 提交 `requestId`、`runnerId` 和 `config`。相同 UUID 和相同参数返回原运行。 |
| `POST /runs/{runId}/cancel` | 撤销租约并进入收尾。 |
| `POST /runs/{runId}/observer` | 获取运行中会话的只读观察凭据。 |
| `GET /runs/{runId}/report` | 读取归档的回放 JSON。 |

终态包括 `completed`、`cancelled`、`failed` 和 `timeout`。在会话创建前停止的运行没有回放。已产生快照的运行会在停止时尝试归档。Control 重启后保留历史和排队任务，仍有效的运行租约可以继续续约。

## 在外部主机运行参考实现

在具备项目源码和 Python 3.11 的主机运行以下命令，填入 Control 的 HTTPS 地址和 Console 签发的凭据：

```sh
export BOX_CONTROL_URL=https://control.example.com
export BOX_RUNNER_ID=已签发的RunnerID
export BOX_RUNNER_TOKEN=已签发的RunnerToken
python3 packages/agent/python/runner_web.py
```

替换策略或语言时，可参照 [Runner HTTP 客户端](../packages/agent/python/runner_client.py) 实现同一协议。使用 `npm run test:control-server` 验证内置 Runner、独立协议客户端、租约边界和回放。
