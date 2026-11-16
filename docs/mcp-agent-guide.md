# 外部 Agent 任务接入

Control 提供任务级 MCP：外部 Agent 创建运行、观察、分配任务、提交设备动作并分段推进；Console 显示同一运行的三维状态、执行记录、目标验收和回放。

当前交付第一阶段：`industrial-park-v2` 场景、`external` 指挥和 `agent` 执行模式。支持完整场景目标与指定任务集合。OAuth、多个控制者同时操作、自定义目标表达式及 primitive 控制尚未开放。

## 启动与签发凭据

按[项目启动指南](../README.md)启动 World、Rust Control 和 Console。Control 必须配置非空 `BOX_RUNNER_OPERATOR_TOKEN`。本地开发时可另设：

```sh
export BOX_CONSOLE_URL=http://127.0.0.1:8780
export BOX_CONTROL_DATA_DIR=.3dbox/control
cargo run --locked --manifest-path packages/control-server/Cargo.toml
```

Compose 的 Console 默认地址为 `http://127.0.0.1:8787`。修改外部地址时同步设置 `BOX_CONSOLE_URL`，保证工具返回的运行链接可访问；使用域名时同步配置 `BOX_ALLOWED_HOSTS`。远程部署须经过 HTTPS 和认证入口，不公开 World 或无认证的会话创建路由。

Compose 会将公网白名单传给 Console、Control 和 World，并保留服务间访问需要的 `control`、`world` 主机名。MCP SDK 的 Host 校验也读取此白名单。修改部署环境后需重新创建相关容器，单纯重启不会更新环境变量。

在 Console 左侧打开 **Agent 任务**，输入管理令牌并连接。在 **Agent 接入配置** 中为 Agent 签发接入凭据。管理令牌用于 Console 管理；接入令牌用于外部 Agent，绑定该接入身份创建的运行，不应混用。当前接入凭据有效期 30 天，默认最多两个并发运行、单次运行 30 分钟；撤销接入同时停止该身份的活动运行。

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

分配任务后还需要向所选设备提交 `execute_task`。动作使用自己的 `requestId`、`targetTick` 和 `expiresTick`；通常选择观察到的 tick 加一作为开始 tick。World 会进一步检查设备状态、任务归属和执行模式。

`box_advance` 每次最多 100 tick，按固定步长推进；墙钟预算为两秒，在单步边界停止，因此单个上游请求较慢时可能超过两秒。它返回实际执行步数、最新 revision 和停止原因。推进下一段使用新的 request ID；重试未确认的同一段必须保留原 ID 和参数。达到事件停止条件或某段结束，不等于整个运行已完成。

## Console 观察与操作

Agent 返回的 `console_url` 使用 `#run=<runId>`。链接只定位运行，不携带凭据。管理用户登录后点击 **打开三维观察与执行记录**，页面切换到 World 只读观察，并在 **Agent 过程** 中显示：

- 运行目标、当前阶段、tick 和已完成目标。
- 分配、动作、推进等工具调用的开始、结果和错误。
- Agent 主动提交的计划与进展摘要。
- World 的任务与设备事件，及最终验收结果。

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

首期保留运行与幂等记录，不自动删除历史。新建运行总数上限 1000，单个运行达到 50000 条记录后拒绝新的执行命令；每个身份工具调用上限 120 次/秒，业务事件流并发上限 64。World 每个进程生命周期最多保留 128 个幂等创建键，达到上限后停止接受新键；可在所有活动会话结束后重启 World 释放记录。清理与保留期管理后续提供。

## 验证

```sh
npm run test:task-runs
npm run test:control-server
npm run typecheck:ui
```

任务联调覆盖旧/新 HTTP MCP、stdio、完整任务链、World 创建/推进幂等、范围隔离、暂停恢复、推进中取消、SSE、回放、旧 JSON 迁移、Control 重启、响应丢失恢复和 World 进程退出。总体扩展方向见[设计方案](mcp-agent-execution-design.md)。

浏览器端到端检查可在安装 Playwright 与 Chromium 后运行 `node tests/integration/task-runs-browser.test.cjs`。也可用 `BOX_PLAYWRIGHT_MODULE` 指向已有模块、`BOX_CHROME_EXECUTABLE` 指定浏览器，`BOX_BROWSER_SCREENSHOT` 指定截图路径。该检查覆盖深链接、管理登录、三维观察接入与实时执行进度。
