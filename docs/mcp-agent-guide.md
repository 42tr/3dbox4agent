# 外部 Agent 任务接入

Control 提供任务级 MCP：外部 Agent 创建运行、观察、分配任务、提交设备动作并分段推进；Console 显示同一运行的三维状态、执行记录、目标验收和回放。

任务工具支持 `industrial-park-v2` 场景、`external` 指挥，以及 `agent` 和 `primitive` 两种执行模式。可运行完整场景目标或指定任务集合。OAuth、多个控制者同时操作和自定义目标表达式尚未开放。

## 启动与签发凭据

按[项目启动指南](../README.md)启动 World、Rust Control 和 Console。Control 必须配置非空 `BOX_RUNNER_OPERATOR_TOKEN`。本地开发时可另设：

```sh
export BOX_CONSOLE_URL=http://127.0.0.1:8780
export BOX_CONTROL_DATA_DIR=.3dbox/control
cargo run --locked --manifest-path packages/control-server/Cargo.toml
```

Compose 的 Console 默认地址为 `http://127.0.0.1:8787`。修改外部地址时同步设置 `BOX_CONSOLE_URL`，保证工具返回的运行链接可访问；使用域名时同步配置 `BOX_ALLOWED_HOSTS`。远程部署须经过 HTTPS 和认证入口，不公开 World 或无认证的会话创建路由。

Compose 会将公网白名单传给 Console、Control 和 World，并保留服务间访问需要的 `control`、`world` 主机名。MCP SDK 的 Host 校验也读取此白名单。修改部署环境后需重新创建相关容器，单纯重启不会更新环境变量。

按 [Console 登录指南](console-login.md) 配置管理员账号后，在 Console 左侧打开 **Agent 任务**。未登录时自动跳转登录页，成功后返回原页面；已登录的浏览器可直接查看执行记录与回放，无需输入管理令牌。在 **Agent 接入配置** 中为 Agent 签发接入凭据。管理令牌只保存在服务器；接入令牌用于外部 Agent，绑定该接入身份创建的运行。当前接入凭据有效期 30 天，默认最多两个并发运行、单次运行 30 分钟；撤销接入同时停止该身份的活动运行。

接入令牌只在签发后显示一次。不要把令牌写进用户目标、计划摘要、URL 或版本库。

## 配置 MCP

### Streamable HTTP

使用 `http://127.0.0.1:8789/mcp/control`，或通过 Console 同源入口使用 `http://127.0.0.1:8780/control/mcp/control`。Compose 的 Console 端口默认是 8787。

客户端需要在每次请求中发送 `Authorization: Bearer <接入令牌>`。下面是配置结构示例，字段名以客户端为准：

```json
{
  "mcpServers": {
    "3dbox": {
      "type": "http",
      "url": "http://127.0.0.1:8789/mcp/control",
      "headers": {"Authorization": "Bearer <接入令牌>"}
    }
  }
}
```

### stdio

先构建适配器：

```sh
cargo build --locked --manifest-path packages/control-server/Cargo.toml --bins
```

配置客户端启动 `packages/control-server/target/debug/threebox-mcp-stdio` 的绝对路径：

```json
{
  "mcpServers": {
    "3dbox": {
      "command": "/absolute/path/threebox-mcp-stdio",
      "env": {
        "BOX_CONTROL_URL": "http://127.0.0.1:8789",
        "BOX_CONTROL_TOKEN": "<接入令牌>"
      }
    }
  }
}
```

stdio 适配器调用同一个 Control 业务 API，不另建 World。stdout 仅承载协议消息。客户端停止适配器不会立即删除业务运行，运行仍受空闲和总时间预算约束。

已验证的协议组合：Streamable HTTP `2025-11-25`、`2026-07-28`；stdio `2025-11-25`。旧设备级 `/mcp` 和 Runner v1 路由继续保留。静态接入令牌没有实现 OAuth 自动授权发现，要求 OAuth 的客户端需等待后续接入阶段。

## 向 Agent 提交任务

可以直接要求：

> 使用 3DBox MCP 完成工业园区的巡检、异常确认、备件运输、维修和复核。先获取能力说明，创建独立运行并给我 Console 链接。按任务依赖选择设备，提交执行动作并分段推进；遇到错误重新观察。最终以 Control 的验收结果为准。

工具目录与参数限制由 `box_get_capabilities` 和 `tools/list` 返回，共享定义在[工具 Schema](../packages/control/schemas/task-tools.v1.json)。

```text
box_get_capabilities
  → box_create_run
  → box_observe(view=coordinator)
  → box_assign_task
  → box_submit_action(type=execute_task)
  → box_advance
  → 继续观察与执行，直到运行进入终态
```

创建完整场景运行的参数示例：

```json
{
  "request_id": "park-maintenance-001",
  "scene_id": "industrial-park-v2",
  "objective": {
    "instruction": "完成园区巡检、运输、维修和复核",
    "type": "scene_completed"
  },
  "config": {"seed": 42, "speed": 5}
}
```

指定任务集合使用 `type: "all_tasks_done"` 和 `task_ids`。场景任务为 `inspect → confirm → deliver → repair → verify`；World 仍校验前置依赖。不能通过省略依赖跳过执行。目标创建后固定，Agent 的“已完成”摘要不会让目标通过验收。

在 `agent` 模式下，分配任务后向设备提交 `execute_task`。在 `primitive` 模式下，先把设备移动到作业范围，再提交 `work_task`。动作使用自己的 `requestId`、`targetTick` 和 `expiresTick`，通常选择观察到的 tick 加一作为开始 tick。World 会进一步检查设备状态、任务归属和执行模式。

`box_advance` 每次最多 100 tick，按固定步长推进；墙钟预算为两秒，在单步边界停止，因此单个上游请求较慢时可能超过两秒。它返回实际执行步数、最新 revision 和停止原因。推进下一段使用新的 request ID；重试未确认的同一段必须保留原 ID 和参数。达到事件停止条件或某段结束，不等于整个运行已完成。

支持进度通知的任务级 MCP 客户端可在 `tools/call` 的 `_meta.progressToken` 中发送字符串或数字。HTTP 与 stdio 会在 `notifications/progress` 中带回该值，报告调用开始和成功或失败。`box_advance` 的结束通知还包含实际推进步数。打开 `console_url` 可查看推进期间的连续进度。

## 设备参数与定向移动

调用 `box_observe` 时传入 `view: "agent"`、`agent_id` 和 `include_device: true`，即可读取 `observation.device`。它按同一仿真步返回设备参数、位置、电量、任务、可用动作、有限范围内的观测和本机动作记录。每条周边观测附带来源和观测步。协调器视图可用同一选项读取固定传感器参数和最近收到的读数。

Console 的「设备操作」面板也可提交方位角与距离，并在动作记录里查看实际移动距离。

设备 HTTP 客户端可以请求 `GET /sessions/{sessionId}/observations/{agentId}?include=device`。Python SDK 提供 `device_snapshot()`、`action_status(request_id)` 和 `move_direction(request_id, bearing_deg, distance_m, target_tick, expires_tick)`。

在 JavaScript 运动学仿真中，可通过 `box_submit_action` 发送以下动作。先查询 `availableActions`，使用设备当时提供的距离范围。

```json
{"requestId":"move-east","type":"move","direction":{"bearingDeg":90,"distanceM":5},"targetTick":1,"expiresTick":21}
```

方位角以正北为 0°，顺时针增加，正东为 90°。定向动作以提交时的位置为起点，执行前发现位置变化会返回 `pose_changed`。障碍、通行边界和其他设备会限制直线移动，结果返回 `position`、`completedM` 和 `remainingM`。`pose.courseDeg` 是有水平位移时根据相邻快照计算的行进方位。

### 勘察车地形扫描与采样

在使用 JavaScript 任务后端的 World 会话中，空闲勘察车可提交 `type: "scan"` 和 `survey: {"mode":"terrain_scan","bearingDeg":90,"radiusM":12}`。半径最小 2 米，最大值取设备感知范围与 30 米中的较小值。仿真在指定方位左右各 30° 的扇区沿五条射线测量。动作完成后，`result.points` 返回无遮挡观测点的坐标、高程、坡度与相对扫描起点的直线通行判定。

提交 `type: "scan"` 和 `survey: {"mode":"mark_access_point","scanRequestId":"scan-1","pointIndex":0}`，可标记本机一次扫描中的通行点。索引从 0 开始。动作完成时会从当前位置重新检查点是否仍在扫描范围内，以及直线路线能否通行。标记坐标保存在该动作的 `result.position`，随后可作为移动目标或通过设备消息共享。

在 `primitive` 模式下，给勘察车分配 `sample` 任务后，先移动至观察返回的作业接近点，再提交 `type: "work_task"`、`operation: "collect_sample"` 与所分配的 `taskId`。采样所需步数来自任务配置。设备观察中的 `device.samples` 返回本机样本及位置，`device.sampleStorage` 返回 4 个槽位的使用情况。报告送达后样本仍占用槽位。

设备级 MCP 的 `submit_action` 可提交扫描、标记和采样，`observe_agent` 配合 `include_device: true` 可读取结果，`report_sample` 会将本机样本对应的任务 ID 交给模拟通信链路。`sampleReports` 显示提交、送达及失败状态。最近一次显式采样完成后，若任务链已经完成，仿真保留 120 步供设备上报，并让已提交的报告继续处理至终态。任务运行级 MCP 仍使用园区场景。可在 Console 选择 `lunar-heightfield-v1` 或 `lunar-materials-v1` 验证完整流程，Python SDK 则提供 `scan_terrain()`、`mark_access_point()`、`work_task(operation="collect_sample")` 与 `report_sample()`。

### 无人机升降与三维航点

JavaScript 运动学后端为飞行设备提供 `ascend`、`descend` 和 `move_to_3d`。在 Console 的「设备操作」中，垂直飞行表单接收升降距离，「移动目标」中的 Z 字段接收相对场景基准面的高度。

- `type: "move", vertical: {deltaM: 5}` 上升 5 米。下降使用负数，单次距离为 0.5–20 米。可用范围会随当前位置的地面高度和飞机当前高度变化。
- `type: "move", target: {x: 112, y: 70, z: 21}` 飞往三维航点。航线检查离地 2–35 米的飞行范围、建筑和地形净空，必要时尝试绕行或改变巡航高度。
- `type: "move", target: {x: 112, y: 70}` 在当前高度进行平面导航。

仍需填写 `requestId`、`targetTick` 和 `expiresTick`。动作进度包含当前位置的 Z、已飞距离和剩余航程。取消后设备停在最后一次已提交的位置和高度，观测、机载相机及回放使用同一个高度。Python SDK 提供 `change_altitude()` 和 `move_to_3d()`。

### 无人机起飞、着陆和定时悬停

在 Console 的「设备操作」中使用「起降与悬停」，也可在 `box_submit_action` 的 `type: "move"` 动作中传入 `flightControl`。

| 操作 | 参数 |
| --- | --- |
| 起飞 | `{mode: "takeoff", heightM: 8}` 从当前位置垂直起飞，目标离地高度为 3–15 米，默认 8 米。 |
| 着陆 | `{mode: "land", x: 112, y: 70}` 飞到落点后垂直下降。落点须在陆地、无障碍且坡度最多 12°。 |
| 悬停 | `{mode: "hover", durationTicks: 5}` 保持位置和高度 1–60 个仿真步。动作结果返回 `heldTicks` 和 `remainingTicks`。 |

默认内置场景中的无人机以空中状态开始。触地后，设备快照中的 `status.flightState` 会显示为 `landed`，`pose.z` 继续使用机体中心的高度。低空取消着陆后，可以重新着陆或起飞。Python SDK 提供 `takeoff()`、`land()` 和 `hover()`。三项动作支持 JavaScript 运动学后端。

## 运输和维修分步工序

创建 MCP 运行时设置 `config.execution_mode: "primitive"`，或在 Console 的世界设置中选择「单体分步执行」。读取设备观察的 `taskOperationsAvailable` 判断能否提交细分工序。为 `true` 时，`assignedTasks[].workOperation` 会为支持细分工序的任务返回下一道工序、执行步数和当前阻塞原因。Rust 任务后端返回 `false`，此时到达作业范围后提交只带任务 ID 的通用 `work_task`。

| 任务 | 工序顺序 |
| --- | --- |
| 运输 | `dock_pickup` 取货对接 → `load` 装货 → 移动到工位 → `dock_delivery` 卸货对接 → `unload` 卸货 → `handoff` 交接 |
| 维修 | `diagnose` 现场诊断 → `remove` 拆卸 → `install` 安装备件 → `self_test` 维修自检 |

例如在作业范围内提交 `{"type":"work_task","taskId":"deliver","operation":"load","requestId":"load-1","targetTick":51,"expiresTick":71}`。Python SDK 的 `work_task()` 接受 `operation=`，Console 会在设备卡和「已分配任务」显示当前工序入口。

卸货把备件放到工位，交接后维修任务才满足依赖。安装消耗一件任务备件，自检通过后维修任务才完成，可继续独立复核。任务撤回时，运输中的备件留在车辆当前位置。已经卸下或安装的备件保留实际状态，重新分配后分别接续交接或自检。同一个请求 ID 和参数重试会返回原动作记录。

## Console 观察与操作

Agent 返回的 `console_url` 使用 `#run=<runId>`，链接中只有运行标识。管理用户打开链接即可进入 World 的只读三维观察，已归档的运行直接打开三维回放。未登录时先进入登录页，登录后自动打开同一运行。**Agent 过程** 中显示：

- 运行目标、当前阶段、tick 和已完成目标。
- 读取观察、任务分配和设备动作的调用记录，包含设备、任务和调用结果。最新记录在顶部，可展开查看详情。
- 本段推进的实时步数，以及结束时的实际步数和停止原因。
- Agent 主动提交的计划与进展摘要。
- World 的任务与设备事件，及最终验收结果。

实时三维观察默认跟随最近一次成功分配任务、提交或取消动作所指向的设备。视角随设备移动，场景仍显示全局态势。点击场景左上角的视图按钮，可在工具栏切换「自动跟随 Agent」。查看历史帧时暂停自动跟随，点击「返回实时」后继续。

外部 Agent 的其他工具、聊天和内部推理不会自动同步。需要展示的简短说明使用 `box_record_note`。

Console 可以暂停、恢复、停止运行或打开已归档回放。暂停、恢复与停止会改变 `control_epoch`，旧 epoch 的后续写入被拒绝。切换其他世界前先断开当前只读观察。

全局三维观察、全局 World 事件与完整回放仅向管理身份开放。外部接入身份通过设备/协调器范围观察世界，事件查询中的全局 World payload 会被隐藏；它仍可查询自己的工具记录、目标进度和验收结果。

## 生命周期与故障恢复

- Agent 思考时 World 不推进，Console 显示“等待 Agent 下一步”。外部模式不使用 Runner 的 15 秒租约。
- 默认五分钟无控制者交互进入暂停，总墙钟预算默认 30 分钟；管理 Console 轮询和订阅不会为外部 Agent 续期。
- 发生 `outcome_unknown` 时，运行进入 `reconciling` 并阻止其他修改。重试原工具及原参数，让 Control 查回 World 回执；不得换 ID 重做。确认后可用新 ID 推进下一段。暂停后恢复仍有未确认操作时，会先回到确认阶段；只允许重试该条原请求，后续新操作使用恢复后的 epoch。
- Control 重启后保留运行、命令与事件。World 会话仍在时可以恢复；World 会话丢失则明确结束为失败。不能跨 World 重启无损续跑。
- 取消立即阻止后续写入，已在执行的单步允许结算，随后归档。已验收的终态不会被迟到的取消改写。
- 任务结果与回放状态独立。归档失败会显示相应错误；历史被截断时回放标记为部分覆盖。

运行数据位于 `BOX_CONTROL_DATA_DIR`，缺省继承 `BOX_RUNNER_DATA_DIR`，再缺省为 `.3dbox/control`。事务数据库为 `control.sqlite3`；现有 Runner 状态首次启动时导入 SQLite，原 JSON 备份为 `runner-state.json.migrated`，旧回放文件保持可读。部署升级前保留整个数据目录的备份。首期只支持一个 Control 写实例。

历史运行和请求回执保留在 Control 中，创建配额按身份的活动运行数计算。创建结果未确认时，以相同 `request_id` 重试。World 的创建回执可在运行截止时间内重试，最长 30 分钟。会话关闭后释放快照和凭据，保留足以拒绝重复创建的记录。单个运行达到 50000 条记录后拒绝新的执行命令。每个身份工具调用上限为 120 次/秒，业务事件流并发上限为 64。

## 验证

```sh
npm run test:task-runs
npm run test:control-server
npm run typecheck:ui
```

任务联调覆盖旧/新 HTTP MCP、stdio、完整任务链、World 创建/推进幂等、范围隔离、暂停恢复、推进中取消、SSE、回放、旧 JSON 迁移、Control 重启、响应丢失恢复和 World 进程退出。总体扩展方向见[设计方案](mcp-agent-execution-design.md)。

浏览器端到端检查可在安装 Playwright 与 Chromium 后运行 `node tests/integration/task-runs-browser.test.cjs`。也可用 `BOX_PLAYWRIGHT_MODULE` 指向已有模块、`BOX_CHROME_EXECUTABLE` 指定浏览器，`BOX_BROWSER_SCREENSHOT` 指定截图路径。该检查覆盖深链接、管理登录、三维观察接入与实时执行进度。
