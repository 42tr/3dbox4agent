# 3DBox Console

React 面板、Three.js 渲染器和浏览器入口位于 `src/`，模型、纹理和许可证位于 `assets/`。浏览器仿真和实时流编解码通过 World 包复用。

在仓库根目录运行 `npm ci` 安装工作区依赖。从本目录运行：

```sh
npm run typecheck
npm run build
```

构建产物为 `dist/index.html`。可以直接打开它进行离线仿真，World 的本地服务也从此处加载控制台。在线页面通过同源 `/control` 发送 HTTP 请求，通过 `/stream` 订阅 World。

从本目录执行 `npm start` 可单独启动 Console，默认监听 `127.0.0.1:8780`。
通过 `BOX_CONTROL_URL` 和 `BOX_WORLD_URL` 配置上游，通过 `CONSOLE_BIND` 和 `CONSOLE_PORT` 配置监听地址。
