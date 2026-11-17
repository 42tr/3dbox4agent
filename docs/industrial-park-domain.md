# 现代工业园区领域层

`packages/world/src/industrial-park-domain.js` 为 `industrial-park-v2` 提供稳定的对象目录、任务模板和命令入口。它与确定性 World 分离，因此不会改变已有物理、任务依赖或回放格式。

## 对象目录

```js
const {createCatalog} = require('@42tr/3dbox4agent-world/industrial-park-domain');
const catalog = createCatalog();
```

目录包含 `scene`、`zone`、`building`、`warehouse`、`production_line`、`equipment`、`device`、`vehicle`、`material`、`utility`、`sensor`、`alarm`、`task` 等对象类型。每个对象都返回 `id`、`type`、`subtype`、位置、状态、能力和 `operations`。操作名称由 `operationCatalog` 统一声明。

World 服务提供只读发现接口：

```text
GET /industrial-park/catalog?sceneId=industrial-park-v2
GET /industrial-park/tasks?sceneId=industrial-park-v2
```

## 命令与幂等

```js
const domain = createIndustrialParkDomain();
domain.execute('equipment-main', 'diagnose', {result: 'bearing_wear'}, {
  actorId: 'robot-1',
  requestId: 'diagnose-001',
});
```

也可以取得对象句柄，直接调用目录中声明的方法：

```js
domain.object('equipment-main').diagnose({result: 'bearing_wear'});
```

命令只接受对象声明的操作。`requestId` 可用于安全重试；同一个 ID 和不同参数会返回冲突。每次成功命令都会生成事件，可通过 `subscribe()` 订阅，也会保存在 `snapshot().events` 中。

## 任务生命周期

```js
const task = domain.createTask('maintenance', {
  id: 'maintenance-001',
  targetObjectId: 'equipment-main',
});
domain.assignTask(task.id, 'robot-1');
domain.startTask(task.id);
for (let i = 0; i < 4; i++) domain.advanceTask(task.id);
```

任务状态为 `pending`、`assigned`、`active`、`paused`、`completed`、`failed` 或 `cancelled`。任务分配会检查所选对象的能力；任务启动会检查依赖是否已经完成。当前工业园区场景的五步链 `inspect → confirm → deliver → repair → verify` 会作为 `taskTemplates.scene` 返回，通用的入库、生产、物流、维修、质量、能源和应急模板位于 `taskTemplates.generic`。

后续将把领域命令与带认证的 session World 执行绑定，使 `execute()` 的状态变化同时驱动物理世界和任务验收。
