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
CONTROL_BIND=127.0.0.1:8788 \
cargo run --manifest-path packages/control-server/Cargo.toml
~~~

常用环境变量：

- WORLD_URL：World HTTP 地址，默认 http://127.0.0.1:8787；
- CONTROL_BIND：Control 监听地址，默认 127.0.0.1:8788；
- CONTROL_AGENT_TOKEN：MCP 工具未从请求 Authorization 头取得凭据时使用的默认 Agent token；
- RUST_LOG：日志过滤器。

## HTTP

/health 由 Control 自己响应。其他没有被 /mcp 占用的路径会保留
method、query、JSON body 及 Authorization、Content-Type、Accept 头，
转发到 WORLD_URL。因此现有 World API 可以通过同一个 Control 地址访问，
例如：

~~~sh
curl -H "Authorization: Bearer $AGENT_TOKEN" \
  http://127.0.0.1:8788/sessions/$SESSION_ID/observations/rover-1
~~~

World 仍负责会话、权限、幂等、动作有效性和世界真值校验；Control 只负责
边界协议和路由。

## MCP

连接地址是 http://127.0.0.1:8788/mcp。默认情况下请求必须带：

~~~
Authorization: Bearer <agent-token>
~~~

RMCP 工具从 MCP 请求的 HTTP Authorization 头读取 Agent token，并把它原样
转发给 World。显式配置 CONTROL_AGENT_TOKEN 后，可以省略请求头并使用进程级默认凭据。
这样 Agent 不需要为 Control 安装或维护 JS、Python 等语言 SDK。

## 验证

~~~sh
cargo check --manifest-path packages/control-server/Cargo.toml
~~~
