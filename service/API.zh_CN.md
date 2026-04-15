# API 接口文档（简版）

当前仓库对外发布时，统一以根目录的 [README.md](../README.md) 作为最新文档入口。

这份文件只保留一个简版索引，避免出现两份接口文档长期分叉。

## 1. 文档入口

- Docker 构建与运行：见 [README.md](../README.md)
- 常用接口调用示例：见 [README.md](../README.md)
- Swagger 调试页面：`http://127.0.0.1:3000/docs`
- Web 管理页：`http://127.0.0.1:3000/admin`

## 2. 当前主要接口

### 系统接口

- `GET /health`

### 管理员接口

- `POST /admin/login`
- `GET /admin/users`
- `DELETE /admin/users/:userId`

### 登录接口

- `POST /auth/login`
- `GET /auth/login/:loginId`
- `DELETE /auth/login/:loginId`

### 用户接口

- `GET /status`
- `POST /send`
- `GET /me`
- `POST /me/apikey/reset`

## 3. 当前行为说明

- 服务是多用户模型，每个扫码登录的微信账号都会生成独立 `apiKey`
- `/send` 当前只支持“给当前登录账号自己发文本消息”
- 已登录账号在服务重启后会自动恢复 monitor
- 当收到文本 `/ping` 时，机器人会自动回复 `pong`

## 4. 脱敏提醒

公开仓库时，不要提交这些内容：

- `data/`
- `.env`
- `.env.*`
- 日志文件
- 真实 `apiKey`
- 真实 bot token
- 真实微信 `userId`
- 消息历史和二维码截图
