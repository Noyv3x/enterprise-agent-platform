# ubitech agent

ubitech agent 的设计、架构、运维与开发规范统一收录在 [canonical 文档层](docs/README.md)。README 仅作为仓库入口；当 README、代码与 `docs/` 不一致时，以 `docs/` 为唯一设计真相源。

## 快速开始

```bash
curl -fsSL https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/install.sh | bash
ubitech-manager status
```

安装器校验并启动用户级 `ubitech-manager`；默认访问地址由 `~/.config/ubitech-agent/manager.toml` 的 `listen` 决定。源码 checkout 只用于开发，不参与生产运行。

- [安装、配置与服务管理](docs/operations/deployment.md)
- [系统架构](docs/design/system-architecture.md)
- [仓库结构与开发入口](docs/development/repository.md)
- [文档先行的变更流程](docs/development/documentation-workflow.md)
