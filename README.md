<p align="center"><img src="https://count.nanoka.top/@chat-room.github" alt="chat-room"></p>

# chat-room

一个普通的聊天室

## 技术栈

- **Bun** — 运行时与打包工具
- **ElysiaJS** — HTTP 路由与 WebSocket
- **bun:sqlite** — 内置 SQLite 存储
- **TypeScript** — 全栈类型安全
- **原生 JS 客户端** — 无框架依赖

## 安装与运行

```shell
$ git clone https://github.com/asadahimeka/chat-room.git
$ cd chat-room
$ bun install

$ bun run dev    # 开发模式（热重载）
$ bun run build  # 构建客户端 bundle → static/js/room.client.js
$ bun run start  # 启动服务
$ bun test       # 运行测试
```

## 配置

复制 `config.example.yml` 为 `config.yml` 进行配置（该文件已被 gitignore，不会入库）：

```shell
$ cp config.example.yml config.yml
```

| 配置项 | 默认值 | 说明 |
| ------ | ------ | ---- |
| `port` | `3000` | 服务监听端口 |
| `dbPath` | `./db/msg.db` | SQLite 数据库文件路径 |
| `trustCloudflare` | `false` | 是否信任 Cloudflare 传入的 `cf-connecting-ip`（仅在 CF 之后部署时开启） |
| `emoji` | — | 表情包源列表，兼容 Waline 格式 |

部分配置也可用环境变量覆盖：`PORT`、`DB_PATH`、`TRUST_CLOUDFLARE`。

## 使用

聊天室 URL 形如：

```
https://chat.nanoka.top/room/@:name?title=the title whatever
```

使用你自己的房间名和标题，例如：

[https://chat.nanoka.top/room/@test?title=a simple title](https://chat.nanoka.top/room/@test?title=a%20simple%20title)

### HTTP API

| 路由 | 说明 |
| ---- | ---- |
| `/` | 302 重定向到 `/room/@demo` |
| `/room/@:roomId` | 聊天室页面 |
| `/room/@:roomId/record?limit&offset` | 获取聊天记录（JSON） |
| `/room/@:roomId/svg?width&height&limit&theme&title&fontSize` | 生成可嵌入的实时 SVG 图表 |
| `/filter?q=` | 敏感词过滤 |
| `/heart-beat` | 心跳检测 |

### SVG 图表

借助 SVG `<foreignObject>` 的特性，我们可以让一个 SVG 元素包含一个标准的 HTML 页面。

示例：[![SVG Charts](https://chat.nanoka.top/room/@test/svg?width=750&height=360&limit=20&theme=light&fontSize=13&title=jad@github.com:%20%7E)](https://chat.nanoka.top/room/@test)

### WebSocket 协议

服务端 → 客户端事件：

| 事件 | 数据 | 说明 |
| ---- | ---- | ---- |
| `init` | `JoinedUser` | 加入房间时返回当前用户 |
| `online` | `JoinedUser[]` | 房间内所有在线用户 |
| `sys` | `string` | 系统消息文本 |
| `msg` | `MsgItem` | 一条聊天消息 |
| `rename` | `{ uid, name }` | 用户改名 |

客户端 → 服务端事件：

| 事件 | 数据 | 说明 |
| ---- | ---- | ---- |
| `message` | `ClientMessage` | 发送聊天消息 |
| `change-name` | `string` | 修改昵称 |
| `leave` | — | 离开房间 |

### 双主题

界面跟随系统的 `prefers-color-scheme` 自动切换浅色 / 深色主题。

### 数据说明

- 聊天记录持久化存储在 `msg.db`（SQLite），升级重写后数据完整保留。
- 演示房间 `/room/@demo` 不持久化，仅用于在线演示。

## Credits

*   [chat-room](https://github.com/journey-ad/chat-room)
*   [Bun](https://bun.sh)
*   [ElysiaJS](https://elysiajs.com)

## License

MIT
