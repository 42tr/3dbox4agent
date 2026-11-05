# 月面设施建设

本组件在已有世界、任务、耗材、动作和回放协议中增加设施建设。示例为 `examples/scenes/lunar-construction.json`，浏览器“场景与世界设置”可选择“月面基地建设”，也可导入该文件。

## 场景契约

施工区引用场景中已有的矩形碰撞代理。该区域从运行开始就不可穿越；建成时不在设备当前位置突然生成碰撞体。未建成设施在全局三维视图中显示施工线框，完成后显示原有设施模型，碰撞范围保持不变。

```json
{
  "constructionSites": [
    {"id":"greenhouse","name":"月面温室","obstacleId":"greenhouse"}
  ],
  "materials": [
    {"id":"construction-kit","name":"设施建造材料","quantity":1}
  ],
  "tasks": [
    {
      "id":"build-greenhouse","name":"建设月面温室",
      "behavior":"build","buildSite":"greenhouse",
      "role":"robot","capability":"build",
      "target":[78,42],"duration":14,"dependsOn":[],
      "materialCost":[{"id":"construction-kit","amount":1}]
    }
  ]
}
```

片段需与完整场景的 `agents`、`obstacles`、`resource` 和通信配置一起使用。`obstacleId` 必须引用已存在的碰撞代理；每个施工区对应一项 `build` 任务，施工区和代理不能重复使用。带 `build` 能力的设备必须为地面平台。

施工目标为区域外的工作点，距矩形边界 1.1–4 米。通过配置校验不代表路径一定可达，正常寻路、能源、任务依赖和设备状态检查仍然适用。范例中温室工作点为 `[78,42]`，供能设施工作点为 `[60,60]`。

```sh
node scripts/check-scene.js examples/scenes/lunar-construction.json --strict
```

## 执行与耗材

建设使用既有任务分配和执行接口。`build` 是任务行为；没有新增可绕过任务、能源和位置检查的“直接建成”动作。

- 分配任务时预留配置中的材料，预留仍属于现有任务及分配代次。
- 自动、设备启动和单体分步执行使用同一工作时长及能源规则。
- 取消执行意图保留任务与材料预留，继续作业不产生第二次分配。
- 设备故障、低电量或撤回任务会释放未消费的材料，替代设备使用新的分配代次。
- 完成时设施状态和耗材扣除一并提交；异常回滚恢复原生组件、事件和实际物理状态。重复完成拒绝再次建造或扣除。

完整原生模式由 Rust 资源组件持有设施状态，固定步、工作条件、任务和事件通过既有原生组件协作；浏览器预览保留 JavaScript 实现。旧场景未配置施工区时不新增建设状态字段。

## 状态、显示与观察范围

全局快照可带可选 `construction.sites`，初始设施只有身份、名称、碰撞代理和 `status: "planned"`。完成后为 `status: "built"`，并记录 `taskId`、`agentId`、`assignmentId` 和 `builtTick`。`construction_completed` 事件与相同任务、设备、代次及完成时刻对应。已建成设施不依赖施工设备之后的位置、能源或可用状态。

右侧“基地建设”面板显示当前快照的建成数、实际工作进度、施工设备、耗材和完成时刻。切换历史帧使用该帧的数据；不会从实时状态补入未来的建筑或材料消耗。JSON 评估指标在配置该组件时增加建设总数、已建数和待建数。

单体观察不返回全局设施表。设备仍通过已有观察取得自己的任务和材料预留；全局建设面板隐藏，三维施工区显示中性的碰撞范围，并提示本机建设任务可在任务链中查看。该显示不会读取其他设备造成的设施建成状态。

## 开发与独立智能体

```sh
npm run build:rust-physics
BOX_PHYSICS_BACKEND=rust BOX_TASK_BACKEND=rust BOX_COMM_BACKEND=rust BOX_NAV_BACKEND=rust BOX_EVENT_JOURNAL_DIR=.3dbox/events BOX_REPLAY_JOURNAL=1 node server/world-supervisor.js
```

浏览器打开该服务页面并连接后，可使用现有分配及设备控制面板。独立 Python 进程使用相同协议；命令行通过场景文件载入新配置：

```sh
PYTHONPATH=sdk/python python3 sdk/python/multi_agent_demo.py --url http://127.0.0.1:8787 --scene-file examples/scenes/lunar-construction.json --physics rapier --sensor-mode rapier --dispatch external --fault none --clock step --max-ticks 900 --timeout 180 --archive > construction-run.json
```

回放需保留原有覆盖范围标记。内存历史可能按容量截断；启用持久快照日志后，完整记录保留在对应运行的日志中，可通过现有授权日志接口分页读取。不要把缺少早期帧的报告标成完整历史，也不要用另一轮运行补帧。

## 验证范围与边界

测试入口为 `construction.test.js`、`construction-native.test.js`、`construction-world.test.js`、`construction-lifecycle.test.js`、`construction-actions.test.js`、`construction-mixed.test.js`、`construction-server.test.js` 和 `construction-ui.test.js`。

覆盖实际两处建设和材料守恒、八组完整 JS/Rust 世界对照、设备／单体动作、中断／替代施工、真实完成后异常回滚、物理碰撞范围、二进制状态流、局部观察、独立日志分支、严格回放及只读面板。示例继续使用同一套园区和月面引擎。

这是固定施工区域内的抽象建设任务。动态选址、结构受力、施工分阶段几何、氧气生产和设施运营供能仍需后续组件，不属于本组件已实现的行为。现场机械救援由独立组件实现，见 [月面设备协同救援](lunar-rescue.md)。
