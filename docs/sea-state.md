# 海况与通航演练

`shore-sea-state-v1` 是第20个内置场景。它使用同一套水陆空、任务、通信、能耗与通行代价组件，保留16台设备和7项依赖任务；原来的19个场景定义保持不变。北部勘察点为 `[92,30]`，两处通航区全部位于配置水域内。

## 条件模型与操作

新场景的 `terrain` 中配置 `north-sea` 和 `south-sea`，平静条件下速度、单位航程能耗倍率均为1。它们使用通用 `terrain-effect` 接口，不存在按场景ID绕过世界协议的海况入口。生效后的倍率与区域基础倍率相乘；飞行设备不受影响。区域完全位于水域中，因此本例实际受扰航行者只有水面设备。自定义混合水陆区域仍可影响其中的地面设备，不应被称为纯水面限制。

在页面设置中选择“海岸通航海况演练”，通过“海况与通航扰动”卡选择水域并提交持续步数。手动操作沿用默认速度倍率0.5、单位距离能耗倍率1.8。卡片显示当前已提交的实际倍率；从实验导入的0.35／2.5等值也不会被错误显示为默认值。历史、只读、导入回放和单体视图遵守原有控制权限。

时间／能耗优先会评估在途路线，只有更优路线才改道；距离优先保留距离目标，但仍承受实际减速与耗能。条件到期后再次评估。回放保存权威条件与事件；从活动条件创建的独立日志分支保留到期时间、物理边界及各自凭据。单体的静态返程估计不会因全局实时海况改变；本机位置变化仍会改变该估计。

二维、三维与卡片以整个矩形在水域并集内的覆盖情况判定水域，包含区域接缝与陆地空洞，不能只检查中心点或名字。三维平静通航区为淡蓝色，活动海况为琥珀色；这只是条件区域可视化，不制造波浪或修改设备姿态。单体视图不显示全局动态海况。

## 可运行实验

先启动原生世界服务，再运行以下命令；默认服务地址是 `http://127.0.0.1:8787`，可用 `--url` 指向其他本地服务。

```sh
BOX_PHYSICS_BACKEND=rust BOX_TASK_BACKEND=rust BOX_COMM_BACKEND=rust BOX_NAV_BACKEND=rust node server/world-server.js
python3 sdk/python/multi_agent_demo.py --scene shore-sea-state-v1 --physics rapier --sensor-mode rapier --fault none --dispatch networked_reported --link-profile long --clock step --coordinators 2 --archive
python3 sdk/python/multi_agent_demo.py --schedule-plan examples/experiments/shore-sea-state.json --sensor-mode rapier --fault none --dispatch networked_reported --link-profile long --clock step --coordinators 2 --archive
python3 sdk/python/multi_agent_demo.py --schedule-plan examples/experiments/shore-sea-recovery.json --sensor-mode rapier --fault none --dispatch networked_reported --link-profile long --clock step --coordinators 2 --coordinator-fault-tick 50 --archive
```

第一项为平静对照。第二项在T10使北部海况恶化80步、在T70使南部恶化180步；分别在T90／T250仍然生效，若世界继续运行则在T91／T251解除。世界任务提前结束时，终态快照保留当时条件，不伪造结束后的恢复事件。

第三项另外在T45使 `boat-3` 模拟链路中断20步，并在T50终止第一个指挥进程；剩余节点重新取得分片与有效凭据。`--schedule-plan` 与旧的 `--outage` 选项互斥，组合实验必须把中断写入计划。设备本地动作RPC不经过模拟链路；本例验证的是原有中央状态／任务链路抽象下的本机继续执行与指挥恢复，不是完整无线电网络或真实部署性能。

示例采用固定步进。独立进程数量、实际事件、失败／恢复、原始记录截断标记和回放覆盖应以每次报告为准；不能把单次成功当作跨种子统计。回归入口：`npm run test:sea-state`。

本实现没有新增流体、浮力、潮汐、方向性水流或两栖切换。设计计划要求首期抽象海况，并排除了高保真物理；高保真不是本例完成条件。后续进度已有多梯队组织、引导点、救援模板、指挥节点及计划审阅的代码与数据验证；更多局部失联组合、三场景Beta性能与平台验收仍需继续工作。实际浏览器画面与交互尚待手动解锁Mac后验收。


## 当前验证口径

种子42的独立16设备／双指挥进程运行：平静对照T203完成，双区海况T215完成；加入巡查艇失联与指挥节点退出的组合仍在T215完成。原始报告分别保留225／239／240帧完整内存回放，没有拼接；退出码区分正常／父进程结束时终止和主动故障注入。

另一个只扰动南部海况区的原生Rapier／射线配对评估覆盖种子0–19、40次实际世界运行，全部完成7项任务，逐帧与JS编排状态一致。平均完成步数112.8→121.3，配对差值8.5步（样本标准差1.10）；平均能耗9.2815→9.938。20次扰动均有实际船艇受扰航程，8次触发在途评估，其中1次改道、7次保留、0次不可达。记录采用既有 `3dbox-terrain-comparison-v1` 报告格式；不是对双区SDK计划的20种子结论，也不是实时吞吐结果。物理接触按实际记录保留，不把合法通行位置等同于所有安全指标均为零。
