# 3DBox Agent

JS 运行时和 LLM 适配在 `src/`，Python 策略、协调器和 runner 在 `python/`。
Python 运行脚本使用 `sdk/python` 提供的 `box_agent` 客户端。部署到独立环境时先安装 SDK：

```sh
python3 -m pip install ./sdk/python
python3 packages/agent/python/multi_agent_demo.py --help
```

开发仓库保留 `sdk/python/*.py` 的旧脚本路径。

规则、规划器和 LLM 策略运行时。通过 Control 客户端获取局部观察并提交语义动作，不直接访问 World 内部状态。
