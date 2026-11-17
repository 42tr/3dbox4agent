# Console 账号与浏览器会话

Console 提供单管理员账号登录。浏览器打开 `/#run=<runId>` 时先检查 `/auth/session`：已登录直接读取执行记录；未登录跳转 `/login?returnTo=...`，登录成功返回原运行。Agent 任务与 Runner 实验共用登录态，回放、事件流、观察凭据和管理操作都经过服务器会话校验。

## 部署配置

在部署 `.env` 中配置以下字段，文件权限设为 `0600`，不要提交到仓库：

```dotenv
BOX_CONSOLE_USERNAME=admin
BOX_CONSOLE_PASSWORD_HASH=scrypt:<salt>:<hash>
BOX_RUNNER_OPERATOR_TOKEN=<与 Control 相同的管理令牌>
BOX_CONSOLE_URL=https://3dbox.example.com
BOX_ALLOWED_HOSTS=3dbox.example.com
```

运行下列命令输入至少 12 位密码，终端只输出可保存到 `.env` 的哈希，密码不会进入命令历史或进程参数：

```sh
python3 -c 'import getpass,sys; sys.stdout.write(getpass.getpass("Console password: "))' | node packages/console/server/hash-password.js
```

重新创建 Console 容器以应用环境变量：`docker compose up -d --build console`。Compose 会把会话目录挂载到 `console-data` 卷；本地启动默认使用 `.3dbox/console`，可通过 `BOX_CONSOLE_DATA_DIR` 修改。首次创建持久目录时运行用户需要写权限，容器镜像已为 `node` 用户配置目录所有权。

## 会话行为

- 登录有效期 7 天，刷新、新标签页和服务重启可复用会话。
- Cookie 使用 `HttpOnly`、`SameSite=Lax`；`BOX_CONSOLE_URL` 为 HTTPS 时同时设置 `Secure`。生产环境应配置实际 HTTPS 地址。
- 服务器只保存会话令牌的 SHA-256 摘要。退出登录即撤销该会话、关闭对应事件流，其他标签页下一次请求会跳回登录。
- 修改账号、密码哈希或管理令牌后重建 Console，会使旧会话失效。当前为单实例、单管理员部署，不提供注册或多用户权限分配。
- 登录与浏览器管理写请求校验同源 Origin 和 JSON 内容类型。每个直连来源五分钟最多尝试登录 10 次；反向代理后的请求共享来源限额。
- 登录返回地址仅允许 Console 根页面及其查询、片段，不允许跳转外站。

浏览器使用 `/console-api/runs/v1/...` 与 `/console-api/runners/v1/...`。Console 在校验会话后向 Control 注入服务器端管理凭据。浏览器不接收管理令牌，也不把它存入 localStorage、URL 或 Cookie。

外部 MCP 与 Runner 客户端继续走原 `/control/...` 接口并携带各自 Bearer 凭据，浏览器 Cookie 不会提升这些接口的权限。普通 World 预览和原有会话接口不属于本次管理登录范围；公网部署仍应按部署指南限制 World 接口。

## 验证

```sh
node packages/console/tests/console-auth.test.js
npm run typecheck --workspace @42tr/3dbox4agent-console
npm run build
# 需要已构建的 Control、World 原生模块、Playwright 和 Chromium
node tests/integration/task-runs-browser.test.cjs
```

浏览器测试覆盖未登录深链接跳转、错误密码、登录后返回、刷新与新标签复用、实时观察、事件流、归档回放、退出撤销和外站返回地址拦截。
