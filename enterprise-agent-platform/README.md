# ubitech agent platform

这是 ubitech agent 的 Python Web 平台包入口。完整设计、配置和运维说明均以仓库顶层的 [canonical 文档层](../docs/README.md) 为准；本文件仅保留包入口和快速验证命令。

## 本地运行

```bash
ENTERPRISE_ADMIN_PASSWORD='change-me' python3 -m enterprise_agent_platform serve
```

## 验证

```bash
python3 -m unittest discover -s tests
python3 -m compileall enterprise_agent_platform tests
```

- [部署与运维](../docs/operations/deployment.md)
- [配置参考](../docs/reference/configuration.md)
- [开发与测试](../docs/development/testing.md)
