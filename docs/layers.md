# 3DBox 分层架构

当前代码按三个稳定边界逐步整理，并在单一 Git 仓库内用 `packages/` 分目录。第一阶段只增加适配层，不改变世界规则、快照格式或后端行为。

## 世界运行时层

`packages/world/src/world-core.js` 保存无头世界规则；根目录 `src/world-core.js` 只保留兼容入口。`packages/world/src/world-runtime.js` 是它对上层暴露的运行时端口，根目录 `src/world-runtime.js` 只保留兼容入口。端口只负责创建世界、推进仿真、读取观察、提交语义操作和释放世界，不依赖 HTTP、React、Three.js 或 Agent 策略。`src/engine.js` 仅保留给旧调用方的兼容入口。

JavaScript/WASM 与 Rust 原生后端都是该端口的实现细节。上层不应根据 `physicsBackend` 分支，后端差异应由服务端绑定阶段消化。

## 控制与能力层

`packages/control/src/control-contracts.js` 定义 Action、Observation 的共享信封校验，`packages/world/src/control-api.js` 将运行时能力暴露成稳定的语义接口；根目录同名文件只保留兼容入口：

- 读取单体观察；
- 提交移动、扫描、补能、任务、救援意图；
- 取消动作；
- 发送设备消息；
- 提交任务分配。

该层校验请求信封，运行时继续执行权威校验。HTTP、WebSocket、Python SDK、gRPC 和 React 控件都应成为这层的适配器，不应直接修改世界对象。

## Agent 策略层

`packages/agent/src/agent-runtime.js` 只定义观察到决策的循环。规则函数、规划器和 LLM 适配器都实现 `policy.decide(observation, context)`，返回一个或多个语义动作。策略不能取得世界对象、Three.js 场景或后端句柄。

`packages/control/src/agent-control-client.js` 提供带设备凭据的 HTTP 适配器；`createClientAgentRuntime()` 将它接入同一策略循环。规则 Agent 和 LLM Agent 因此共享观察、动作校验、权限隔离和服务端回放路径。

`packages/agent/src/llm-policy.js` 只负责把外部模型调用转换为严格的 `{actions: [...]}` JSON。模型供应商由调用方注入 `complete()`；适配器负责 schema、输出大小、动作数量和超时，动作仍由控制 API 和世界运行时最终校验。

LLM 的请求、模型输出、超时和拒绝应由策略适配器记录；动作仍必须经过控制层和世界运行时的权限、时效、资源和幂等校验。

## 数据流

```text
Agent policy -> semantic action -> Control API -> World runtime
       ^                                      |
       +--------- observation/event ----------+
                         |
                    3D renderer
```

渲染器只消费快照和事件。场景中的模型、相机和材质不是 Agent API；Agent 看到的是实体 ID、能力、局部观察和可执行动作。

## 后续拆分顺序

1. 把服务端的世界推进、观察和 Agent 路由全部改为使用控制层；
2. 已将纯世界规则收拢到独立的无头 `src/world-core.js`，`src/engine.js` 只保留兼容入口；
3. 让 `src/scene3d.js` 只订阅快照和事件；
4. 让 Python/gRPC/LLM 策略复用 `src/control-contracts.js` 对应的 Action/Observation/Event 契约；
5. 在需要时再把世界服务和 Agent 进程拆开，保持模块边界先于进程边界。
