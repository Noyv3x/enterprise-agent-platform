# Agent Platform

面向团队的个人 AI 与公共频道 Agent 平台。产品范围、使用边界和维护入口见[文档导航](docs/README.md)。

## 部署

先确认[部署前提与安装步骤](docs/operations/deployment.md)，再执行：

```sh
curl -fsSL https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/install.sh | bash -s -- --yes
agent-platform-manager status
```

安装器部署已验证的发布物；源码 checkout 只用于开发。访问地址、首次登录和故障处理见部署指南。

## 开发与维护

- [按任务找文档](docs/README.md)
- [找代码与修改入口](docs/development/repository.md)
- [构建、测试和交付验证](docs/development/testing.md)
