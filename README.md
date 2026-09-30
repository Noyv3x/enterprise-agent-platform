# Agent Platform

基于原生 Pi 的个人 AI、共享频道与标准聊天平台。产品范围、使用边界和维护入口见[文档导航](docs/README.md)。

## 部署

Pi-native R2 必须先安装 Manager M1。确认[部署前提与安装步骤](docs/operations/deployment.md)，再执行：

```sh
curl -fsSL https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/install.sh | bash -s -- --yes
agent-platform-manager status
```

安装器部署已验证的发布物；源码 checkout 只用于开发。既有部署通过 Manager 更新，不重新运行安装器；升级顺序、备份和真实模型验收见部署指南。

## 开发与维护

- [按任务找文档](docs/README.md)
- [找代码与修改入口](docs/development/repository.md)
- [构建、测试和交付验证](docs/development/testing.md)
