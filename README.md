# wechat_ilink_api_docker

基于 [`wechat-ilink-client`](https://github.com/photon-hq/wechat-ilink-client) 封装的本地 / Docker 可运行 API 服务，提供：

- 微信二维码登录
- 多用户 `apiKey` 管理
- 自动保活监控
- 给当前登录微信账号自己发送消息
- `/ping -> pong` 自动回复
- Swagger 调试页面

本文档只聚焦两件事：

1. Docker 镜像编译和运行
2. 最常用的 API 调用方式

## 0. 来源说明

- 原作者仓库：[`photon-hq/wechat-ilink-client`](https://github.com/photon-hq/wechat-ilink-client)
- 本项目是在原作者仓库基础上的本地 API / Docker 封装，保留对原始实现与许可证的归属说明

## 1. 快速开始

### 1.1 本地运行

要求：

- Node.js 20+
- pnpm

启动：

```bash
cp .env.example .env
pnpm install
ADMIN_PASSWORD=your_admin_password pnpm api-server
```

默认地址：

- API: `http://127.0.0.1:3000`
- Swagger: `http://127.0.0.1:3000/docs`
- Web 管理页: `http://127.0.0.1:3000/admin`

### 1.2 Docker 构建

在项目根目录执行：

```bash
docker build -t wechat_ilink_api_docker:latest .
```

### 1.3 Docker 运行

建议把 `data/` 挂载出来，保留扫码登录状态和消息历史：

```bash
docker run -d \
  --name wechat_ilink_api_docker \
  -p 3000:3000 \
  -e ADMIN_PASSWORD=your_admin_password \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e DATA_DIR=/app/data \
  -e AUTO_START_MONITOR=true \
  -v "$(pwd)/data:/app/data" \
  wechat_ilink_api_docker:latest
```

启动后访问：

- `http://127.0.0.1:3000/docs`
- `http://127.0.0.1:3000/admin`

### 1.4 查看容器日志

```bash
docker logs -f wechat_ilink_api_docker
```

### 1.5 停止和删除容器

```bash
docker stop wechat_ilink_api_docker
docker rm wechat_ilink_api_docker
```

## 2. 环境变量

| 变量名 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | 是 | 无 | 管理员密码，不设置服务会直接退出 |
| `HOST` | 否 | `0.0.0.0` | 服务监听地址 |
| `PORT` | 否 | `3000` | 服务端口 |
| `DATA_DIR` | 否 | `./data` | 数据目录 |
| `MAX_HISTORY` | 否 | `200` | 每个用户保留的历史消息条数 |
| `AUTO_START_MONITOR` | 否 | `true` | 已登录用户在服务启动后自动恢复消息监控 |

## 3. 数据目录说明

服务会把运行态数据写到 `DATA_DIR`：

- `users.json`
- `users/<userId>/session.json`
- `users/<userId>/sync-buf.json`
- `users/<userId>/messages.json`

这部分数据包含登录会话、用户 ID、`apiKey`、消息历史和上下文信息：

- 不要提交到 GitHub
- Docker 场景一定要挂载卷

## 4. 典型调用流程

### 4.1 健康检查

```bash
curl http://127.0.0.1:3000/health
```

示例返回：

```json
{
  "ok": true,
  "totalUsers": 0,
  "activeUsers": 0
}
```

### 4.2 管理员登录

```bash
curl -X POST http://127.0.0.1:3000/admin/login \
  -H 'Content-Type: application/json' \
  -d '{
    "password": "your_admin_password"
  }'
```

示例返回：

```json
{
  "ok": true,
  "message": "Admin login successful.",
  "token": "<BASE64_ADMIN_PASSWORD>"
}
```

说明：

- 后续管理员接口最简单的做法是直接使用 `X-Admin-Password`
- 不一定非要使用这个 `token`

### 4.3 发起扫码登录

```bash
curl -X POST http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json'
```

示例返回：

```json
{
  "loginId": "login:1776000000000-abcdef12",
  "status": "starting",
  "message": "Login started. Poll /auth/login/:loginId for QR code and status."
}
```

### 4.4 轮询二维码和登录状态

把上一步返回的 `loginId` 带进去：

```bash
curl http://127.0.0.1:3000/auth/login/login:1776000000000-abcdef12
```

扫码等待中示例：

```json
{
  "loginId": "login:1776000000000-abcdef12",
  "status": "wait",
  "qrcodeUrl": "<QR_CODE_URL>"
}
```

登录成功示例：

```json
{
  "loginId": "login:1776000000000-abcdef12",
  "status": "confirmed",
  "qrcodeUrl": "<QR_CODE_URL>",
  "userId": "<WECHAT_USER_ID>",
  "apiKey": "<API_KEY>"
}
```

拿到 `apiKey` 后，后面的用户接口都用它调用。

### 4.5 查看当前账号状态

```bash
curl http://127.0.0.1:3000/status \
  -H 'X-API-Key: <API_KEY>'
```

示例返回：

```json
{
  "ok": true,
  "online": true,
  "userId": "<WECHAT_USER_ID>",
  "monitoring": true,
  "lastError": null
}
```

说明：

- `online=true` 表示当前账号已登录且 monitor 正在运行
- 这个接口按 `apiKey` 限速：每分钟 60 次

### 4.6 发送消息

当前服务只支持“给当前登录账号自己发消息”，所以接口不再需要传 `toUserId`。

```bash
curl -X POST http://127.0.0.1:3000/send \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <API_KEY>' \
  -d '{
    "text": "hello from api"
  }'
```

示例返回：

```json
{
  "ok": true,
  "clientId": "wechat-ilink:1776000000000-abcd1234"
}
```

说明：

- `/send` 按 `apiKey` 限速：每分钟 30 次
- 首次发送前，建议先用该微信号主动给 bot 发一条消息，建立上下文
- 如果本地没有上下文，服务会先自动补拉最近消息再尝试发送

### 4.7 获取当前账号详情

```bash
curl http://127.0.0.1:3000/me \
  -H 'X-API-Key: <API_KEY>'
```

示例返回：

```json
{
  "userId": "<WECHAT_USER_ID>",
  "apiKey": "<API_KEY>",
  "createdAt": "2026-04-15T10:00:00.000Z",
  "lastLoginAt": "2026-04-15T10:00:00.000Z",
  "online": true,
  "monitoring": true,
  "lastError": null
}
```

### 4.8 重置当前账号的 API Key

```bash
curl -X POST http://127.0.0.1:3000/me/apikey/reset \
  -H 'X-API-Key: <API_KEY>'
```

示例返回：

```json
{
  "ok": true,
  "userId": "<WECHAT_USER_ID>",
  "apiKey": "<NEW_API_KEY>",
  "message": "API key has been regenerated. Old key is now invalid."
}
```

### 4.9 查看所有已登录用户

```bash
curl http://127.0.0.1:3000/admin/users \
  -H 'X-Admin-Password: your_admin_password'
```

示例返回：

```json
{
  "users": [
    {
      "userId": "<WECHAT_USER_ID>",
      "apiKey": "<API_KEY>",
      "createdAt": "2026-04-15T10:00:00.000Z",
      "lastLoginAt": "2026-04-15T10:00:00.000Z",
      "connected": true,
      "monitoring": true
    }
  ]
}
```

### 4.10 删除一个用户

```bash
curl -X DELETE 'http://127.0.0.1:3000/admin/users/%3CWECHAT_USER_ID%3E' \
  -H 'X-Admin-Password: your_admin_password'
```

## 5. 自动回复

如果监听到用户发送文本：

```text
/ping
```

机器人会自动回复：

```text
pong
```

前提：

- 当前账号已经登录成功
- monitor 正在运行

## 6. 调试入口

- Swagger UI: `GET /docs`
- Web 管理页: `GET /admin`
- 主页面: `GET /`

## 7. 常见问题

### 7.1 为什么 `/send` 返回 400？

最常见原因是当前账号还没有可用的 `contextToken`。

处理方式：

1. 先用该微信账号给 bot 发一条消息
2. 等几秒
3. 再调用 `/send`

### 7.2 为什么 `/status` 显示 `online=false`？

通常表示下面两种情况之一：

- 会话没有恢复成功，需要重新扫码
- monitor 没有运行，或者运行中出现了错误

可以同时看：

- `/status`
- `/me`
- `docker logs -f wechat_ilink_api_docker`

### 7.3 提交到 GitHub 前要注意什么？

不要提交这些内容：

- `data/`
- `.env`
- `.env.*`
- 日志文件
- 真实的 `apiKey`
- 真实的 bot token
- 真实微信 `userId`
- 消息历史和二维码截图

## 8. 开发相关

本地测试：

```bash
pnpm test:service
pnpm typecheck
```

## 9. 接口总览

当前最常用的接口如下：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `POST` | `/admin/login` | 管理员登录 |
| `GET` | `/admin/users` | 查看已登录用户 |
| `DELETE` | `/admin/users/:userId` | 删除用户 |
| `POST` | `/auth/login` | 发起二维码登录 |
| `GET` | `/auth/login/:loginId` | 查询扫码状态 |
| `DELETE` | `/auth/login/:loginId` | 取消登录任务 |
| `POST` | `/send` | 给当前账号自己发送文本 |
| `GET` | `/status` | 查看当前账号在线状态 |
| `GET` | `/me` | 查看当前账号详情 |
| `POST` | `/me/apikey/reset` | 重置当前账号 API Key |

## 10. 许可证

本项目及其衍生封装遵循 MIT License 进行说明与分发。使用、复制、修改和分发本项目代码时，请保留原作者署名、原项目链接以及相关许可证声明。

原始项目仓库：

- [`photon-hq/wechat-ilink-client`](https://github.com/photon-hq/wechat-ilink-client)

## 11. 法律免责声明

- 本项目仅供技术研究、学习交流、接口调试与合法合规的开发测试使用。
- 使用者应自行确认其使用行为符合所在地法律法规、监管要求、平台规则，以及腾讯/微信相关服务协议。
- 因使用、误用、滥用或基于本项目进行二次开发、部署、传播所产生的账号封禁、数据泄露、业务中断、财产损失或其他直接、间接责任，项目作者与贡献者不承担任何责任。
- 若你不同意上述条款，请勿使用、复制或分发本项目。
