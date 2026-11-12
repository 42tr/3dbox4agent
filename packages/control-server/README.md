# 3DBox Control Server

独立的 Rust Control 应用。它不持有世界状态，而是把外部调用转发给
World 服务，并统一提供两种入口：

- Axum HTTP：任何语言都可以直接调用，不需要安装语言客户端 SDK；
- RMCP Streamable HTTP：Agent 或 MCP 客户端连接 /mcp，使用
  observe_agent、submit_action、cancel_action 和 send_agent_message 工具。

## 运行

先启动 World 服务（默认 127.0.0.1:8787），再启动 Control：

~~~sh
WORLD_URL=http://127.0.0.1:8787 \
CONTROL_BIND=127.0.0.1:8789 \
cargo run --manifest-path packages/control-server/Cargo.toml
~~~

常用环境变量：

- WORLD_URL：World HTTP 地址，默认 http://127.0.0.1:8787；
- CONTROL_BIND：Control 监听地址，默认 127.0.0.1:8789；
- CONTROL_AGENT_TOKEN：MCP 请求省略 Authorization 头时使用的默认 Agent token；
- RUST_LOG：日志过滤器。

## HTTP

/health 返回 Control 的进程状态，/world/health 转发 World 的健康和能力信息。
其他 HTTP 请求保留方法、查询参数、请求体和授权头，并转发到 WORLD_URL。
代理流式传输请求与响应，供 Console 的目录导入和下载复用 World 的限制。
World 上提供同源 /control 路由，Console 的 WebSocket 仍使用 World 上的 /stream。
设备可以直接使用 Control 地址：

~~~sh
curl -H "Authorization: Bearer $AGENT_TOKEN" \
  http://127.0.0.1:8789/sessions/$SESSION_ID/observations/rover-1
~~~

World 仍负责会话、权限、幂等、动作有效性和世界真值校验；Control 只负责
边界协议和路由。

## MCP

连接地址是 http://127.0.0.1:8789/mcp。默认情况下请求必须带：

~~~
Authorization: Bearer <agent-token>
~~~

RMCP 工具从 MCP 请求的 HTTP Authorization 头读取 Agent token，并把它原样
转发给 World。显式配置 CONTROL_AGENT_TOKEN 后，可以省略请求头并使用进程级默认凭据。
工具失败时返回 MCP `isError: true`，JSON 内容包含 World 的错误码及 HTTP 状态。

## 验证

~~~sh
npm run test:control-server
~~~
