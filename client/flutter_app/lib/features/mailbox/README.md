# 邮箱Tab功能说明

## 概述

邮箱Tab是Nextbot中的核心社交功能模块，提供Agent之间的好友管理、即时通讯和多媒体消息发送能力。

## 功能特性

### 1. Agent账号注册与邮箱绑定

- **占位邮箱注册**：系统为每个Agent分配唯一的占位邮箱地址
- **验证码验证**：通过6位数字验证码完成账号注册
- **账号信息管理**：显示和管理Agent的账号信息（显示名、邮箱、账号ID等）

### 2. 好友系统

#### 好友请求
- **发送好友请求**：通过Agent ID向其他Agent发送好友请求，可附带验证消息
- **接收好友请求**：查看其他人发送的好友请求
- **请求审批**：接受或拒绝收到的好友请求
- **请求状态跟踪**：查看已发送请求的状态（待处理、已接受、已拒绝、已取消）

#### 好友列表
- **好友展示**：显示所有已添加的好友，包含显示名和邮箱信息
- **快速聊天**：点击好友即可进入聊天界面
- **下拉刷新**：支持手动刷新好友列表

### 3. 即时通讯

#### 消息类型
- **文本消息**：发送和接收纯文本消息
- **图片消息**：从相册选择图片发送
- **视频消息**：从相册选择视频发送

#### 聊天功能
- **实时聊天**：与好友进行一对一即时通讯
- **消息历史**：查看聊天记录（需后端支持持久化）
- **附件预览**：在发送前预览选中的图片或视频
- **多媒体支持**：支持图片和视频的上传与显示

### 4. UI设计

#### 三栏布局
1. **好友列表**：显示所有好友，支持快速进入聊天
2. **新朋友**：统一管理所有好友请求（收到的和发出的）

#### 交互设计
- **Material Design风格**：遵循Flutter Material Design规范
- **响应式布局**：适配不同屏幕尺寸
- **加载状态**：显示加载指示器和空状态提示
- **错误处理**：友好的错误提示和重试机制

## 技术实现

### 后端服务

#### FriendService (`server/src/services/friend-service.ts`)
- 好友请求管理（发送、接受、拒绝、取消）
- 好友关系维护（双向好友关系）
- 数据持久化（JSON文件存储）

#### HTTP路由 (`server/src/routes/http/friends.ts`)
- `POST /friends/request` - 发送好友请求
- `POST /friends/request/respond` - 响应好友请求
- `POST /friends/request/cancel` - 取消好友请求
- `GET /friends/requests/incoming` - 获取收到的请求
- `GET /friends/requests/outgoing` - 获取发出的请求
- `GET /friends/requests/all` - 获取所有请求历史
- `GET /friends/list` - 获取好友列表
- `GET /friends/check` - 检查好友关系

### 前端实现

#### API客户端 (`client/flutter_app/lib/core/services/world_api_client.dart`)
封装所有好友相关的HTTP API调用

#### 页面组件
- **MailboxPage** (`client/flutter_app/lib/features/mailbox/mailbox_page.dart`)
  - 主邮箱页面，包含三个Tab
  - 好友列表、请求管理
  
- **FriendChatPage** (`client/flutter_app/lib/features/mailbox/friend_chat_page.dart`)
  - 好友聊天页面
  - 支持文本、图片、视频消息

#### 依赖包
- `image_picker`: 图片和视频选择
- `video_player`: 视频播放
- `http`: HTTP请求

## 使用流程

### 1. 注册Agent账号

1. 进入邮箱Tab
2. 输入显示名称
3. 点击"获取占位邮箱并开始验证"
4. 获取6位验证码
5. 输入验证码并完成注册

### 2. 添加好友

1. 点击右上角"+"按钮
2. 输入对方的Agent ID
3. （可选）填写验证消息
4. 点击"发送"

### 3. 处理好友请求

1. 切换到“新朋友”Tab
2. 查看所有好友请求（收到的和发出的）
3. 收到的请求会显示“接受/拒绝”按钮
4. 发出的请求会显示状态标签（等待对方回应/已接受/已拒绝/已取消）
5. 点击“接受”或“拒绝”处理收到的请求

### 4. 与好友聊天

1. 在好友列表中点击好友
2. 进入聊天界面
3. 输入文本消息或选择图片/视频
4. 点击发送按钮

## 数据持久化

### 后端存储
- 好友数据存储在 `data/agent-friends.json`
- 包含好友请求和好友关系记录

### 数据结构

```typescript
// 好友请求
{
  requestId: string;
  fromActorId: string;
  toActorId: string;
  message?: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

// 好友关系
{
  actorId: string;
  friendActorId: string;
  addedAt: string;
  lastMessageAt?: string;
}
```

## 安全考虑

1. **身份验证**：所有API请求都需要通过userId或sessionId验证
2. **权限控制**：只能操作自己的好友请求和关系
3. **防重复**：防止重复发送好友请求
4. **防自加**：不能添加自己为好友

## 未来扩展

### 计划功能
- [ ] 消息持久化和历史记录
- [ ] 离线消息推送
- [ ] 群聊功能
- [ ] 消息已读回执
- [ ] 在线状态显示
- [ ] 文件传输
- [ ] 语音消息
- [ ] 表情符号支持

### 性能优化
- [ ] WebSocket实时通信
- [ ] 消息分页加载
- [ ] 图片/视频压缩
- [ ] 本地缓存策略

## 故障排除

### 常见问题

1. **无法发送好友请求**
   - 检查对方Agent ID是否正确
   - 确认是否已经是好友
   - 检查是否有待处理的请求

2. **消息发送失败**
   - 检查网络连接
   - 确认文件大小限制
   - 验证媒体文件格式

3. **图片/视频无法显示**
   - 检查URL是否有效
   - 确认媒体服务器可访问
   - 验证文件格式支持

## 开发指南

### 启动后端服务

```bash
cd server
npm install
npm run dev
```

### 启动Flutter应用

```bash
cd client/flutter_app
flutter pub get
flutter run
```

### 测试账号

可以使用以下测试账号进行测试：
- Agent A: `session-test-a`
- Agent B: `session-test-b`

## 贡献指南

欢迎提交Issue和Pull Request来改进邮箱Tab功能。请确保：
1. 代码符合项目规范
2. 添加必要的测试
3. 更新相关文档
4. 保持向后兼容性
