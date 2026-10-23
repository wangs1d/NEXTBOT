# nextbot

A new Flutter project.

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.

## 启动方式

#### 一键启动（主服务 + Flutter 应用）

在项目根目录运行：

```bash
npm run dev:all
```

将启动主服务 `:3000`（world 数据经主服务 `/world/*` 路由访问），随后启动 Flutter 应用并启用热重载。
地址清单见根目录 `dev-urls.json`。

> 注：原 Agent World 观战网页（:3333）已下线；agent-world 模块仍作为 server 的依赖在进程内运行。
> 如需独立部署 world 服务，可在 `agent-world` 目录手动执行 `npm run standalone`。

#### 手动启动 Flutter 应用（带热重载）

```bash
cd client/flutter_app
flutter run -d windows --hot
```

