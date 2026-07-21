# ubitech agent

ubitech agent 的设计、架构、运维与开发规范统一收录在 [canonical 文档层](docs/README.md)。README 仅作为仓库入口；当 README、代码与 `docs/` 不一致时，以 `docs/` 为唯一设计真相源。

## 快速开始

```bash
git clone --recurse-submodules https://github.com/Noyv3x/enterprise-agent-platform.git
cd enterprise-agent-platform
./deploy.sh
```

启动后访问 `http://127.0.0.1:8765`。

- [安装、配置与服务管理](docs/operations/deployment.md)
- [系统架构](docs/design/system-architecture.md)
- [仓库结构与开发入口](docs/development/repository.md)
- [文档先行的变更流程](docs/development/documentation-workflow.md)
