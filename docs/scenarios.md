# 场景、实验与回放

在 Console 的世界设置中选择场景、种子和执行方式。切换场景后点击 **重新开始** 创建新世界。离线页面在浏览器内运行，连接世界服务后则由 World 推进仿真并提供快照。

## 场景入口

| 想验证的行为 | 场景或配置 |
| --- | --- |
| 巡检、备件运输、维修和并行任务 | `industrial-park-v1`、`industrial-park-parallel-v1` |
| 月面设施协作与采样复勘 | `lunar-outpost-v1`、`lunar-sampling-v1` |
| 建设、耗材、热控、运行耗电和中继 | [月面场景配置](../packages/world/scenes)，例如 [设施建设](../packages/world/scenes/lunar-construction.json)、[基础耗电](../packages/world/scenes/lunar-power.json) |
| 水陆空通行、海况扰动、梯队和驻留中继救援 | [水陆空协同](../packages/world/scenes/shore-surface.json)、[海况](../packages/world/scenes/shore-sea-state.json)、[梯队](../packages/world/scenes/shore-echelons.json)、[海岸救援](../packages/world/scenes/shore-rescue.json) |

自定义场景可在页面导入 JSON 或 YAML。CLI 可以检查文件并直接运行一次无头运动学仿真：

```sh
node scripts/check-scene.js packages/world/scenes/shore-surface.json
node scripts/run-scene.js packages/world/scenes/shore-surface.json 42 1000 none > shore-run.json
```

`run-scene.js` 的后三个参数依次为种子、最大步数和故障注入步，`none` 表示禁用故障。海岸任务观察可同时提供物理任务点 `waypoint` 和合法接近点 `approachPoint`。到达接近点后，World 仍按实际任务点检查作业距离。

## 多进程与定时实验

启动 World 与 Control 后，可用独立设备和协调器进程运行场景。会话管理、观察和动作的 HTTP 请求都通过 Control：

```sh
python3 packages/agent/python/multi_agent_demo.py \
  --control-url http://127.0.0.1:8789 \
  --scene industrial-park-parallel-v1 --fault none --archive > agent-run.json
```

启用 `--observe-stream` 时，可用 `--url` 或 `BOX_WORLD_URL` 指定 WebSocket 观察流的服务地址。

使用 Compose 时，打开 Console 左侧的 **Runner 实验** 选择 Runner 和实验参数，启动后可查看进度、停止或打开回放。也可以在命令行运行一次实验：

```sh
docker compose run --rm -T runner \
  python3 packages/agent/python/multi_agent_demo.py --fault none --physics rapier --archive > agent-run.json
```

- 使用 `--scene-file` 运行文件场景。使用 `--schedule-plan` 时，由计划提供场景、种子、物理模式、步数上限和扰动，并使用固定步推进。可从[园区扰动计划](../examples/experiments/park-disturbances.json)或[海岸恢复计划](../examples/experiments/shore-sea-recovery.json)开始。
- 可用 `--coordinators 2 --coordinator-fault-tick 50` 测试分片接管，或用 `--coordinator-policy` 加载单协调器策略。完整选项见 runner 的 `--help`。
- 可用 `--auto-rescue --rescue-search` 启用空闲设备的本机巡查救援。驻留中继故障用 `--fault resident`，runner 会分别判断任务是否完成和故障是否恢复。需要原生射线感知时，在原生 World 上同时传入 `--physics rapier --sensor-mode rapier`。

## 人工指挥与回放

- **指挥节点**按当前快照展示指令与分配来源。管理员可在凭据面板签发、轮换或撤销具名节点凭据。
- **任务计划审阅**用于暂停状态下的外部指挥。草稿最多 8 项，确认后逐条提交。世界版本变化、明确拒绝或响应未确认时停止后续请求，已接受的分配可以在任务指挥面板撤回。
- 在 Console 用 **导入回放** 打开浏览器导出文件或带 `--archive` 的 runner 报告，可按帧、步或事件定位。查看报告的历史覆盖范围时，注意保留的第一帧可能晚于会话创建。
- 对有持久快照的会话，可在同一 World 运行时中从指定版本创建分支。日志权限和升级兼容方式见[数据与回放](architecture.md#数据与回放)。
