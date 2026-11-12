# 3DBox World

世界真值和无头仿真层。World Core 以及它直接使用的导航、传感器、高程、
地表、热控、电力、梯队、耗材、中继、建设、救援、回放、记录、差量、
任务图、场景诊断、场景格式和流协议模块都已迁入这里。

单体服务、Supervisor、Worker、物理适配和事件日志位于 `server/`。
场景资源位于 `scenes/`，原生 Rust/Rapier 源码位于 `native/physics/`，
实验目录工具位于 `scripts/`。根目录保留同名入口供旧调用方使用。

在仓库根目录运行 `npm ci` 后，从本目录执行：

~~~sh
npm start              # Supervisor
npm run start:single   # 单进程调试
npm run build:native   # 构建可选原生模块
~~~

本地控制台页面由 Console 构建。需要浏览器界面时，先在仓库根目录运行 `npm run build`。
设置 `BOX_WORLD_API_ONLY=1` 可只启动 World API 和实时流，供独立的 Console 与 Control 访问。
