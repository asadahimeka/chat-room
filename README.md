<p align="center"><img src="https://count.getloli.com/get/@chat-room.github" alt="chat-room"></p>

# chat-room

一个现代化的聊天室（Bun 原生重写版）

![Snipaste_2020-08-12_18-42-17.png](https://i.loli.net/2020/08/12/mxQph9ToEzufgPt.png)

[Demo](https://chat.getloli.com/room/@demo)

## 技术栈

- **Bun** — 运行时与打包工具
- **ElysiaJS** — HTTP 路由与 WebSocket
- **bun:sqlite** — 内置 SQLite 存储
- **TypeScript** — 全栈类型安全
- **原生 JS 客户端** — 无框架依赖

## 安装与运行

```shell
$ git clone https://github.com/journey-ad/chat-room.git
$ cd chat-room
$ bun install

$ bun run dev    # 开发模式（热重载）
$ bun run build  # 构建客户端 bundle → static/js/room.client.js
$ bun run start  # 启动服务
$ bun test       # 运行测试
```

## 配置

通过环境变量配置，默认值如下：

| 环境变量 | 默认值 | 说明 |
| -------- | ------ | ---- |
| `PORT`   | `3000` | 服务监听端口 |
| `DB_PATH`| `./msg.db` | SQLite 数据库文件路径 |

```shell
# 例如：
$ PORT=8080 DB_PATH=./data.db bun run start
```

## 使用

聊天室 URL 形如：

```
https://chat.getloli.com/room/@:name?title=the title whatever
```

使用你自己的房间名和标题，例如：

[https://chat.getloli.com/room/@test?title=a simple title](https://chat.getloli.com/room/@test?title=a%20simple%20title)

可以在新标签页打开，也可以嵌入 iframe，[示例](https://count.getloli.com/)。

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

众所周知，SVG 可以作为图片被引用。

然后……

[![SVG Charts](https://chat.getloli.com/room/@test/svg?width=750&height=360&limit=20&theme=light&fontSize=13&title=jad@github.com:%20%7E)](https://chat.getloli.com/room/@test)

**神奇！** 一个可以插入到任何支持图片的文档中的**实时**图表。

就像这位老哥的[个人主页](https://github.com/journey-ad)一样。

这是全部参数，自己动手试试：
```
https://chat.getloli.com/room/@test/svg?width=750&height=360&limit=20&theme=light&fontSize=13&title=jad@github.com: ~
```

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

界面跟随系统的 `prefers-color-scheme` 自动切换浅色 / 深色主题，无需手动配置。

### 数据说明

- 聊天记录持久化存储在 `msg.db`（SQLite），升级重写后数据完整保留。
- 演示房间 `/room/@demo` 不持久化，仅用于在线演示。

## Credits

*   [repl.it](https://repl.it/)
*   [Node.js 與 Socket.io – 即時聊天室實作](https://single9.net/2017/12/node-js-%e8%88%87-socket-io-%e5%8d%b3%e6%99%82%e8%81%8a%e5%a4%a9%e5%ae%a4%e5%af%a6%e4%bd%9c/)
*   [SVG <foreignObject>简介与截图等应用](https://www.zhangxinxu.com/wordpress/2017/08/svg-foreignobject/)
*   [Icons8](https://icons8.com/icons/set/star)

## License

[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2Fjourney-ad%2Fchat-room.svg?type=large)](https://app.fossa.com/projects/git%2Bgithub.com%2Fjourney-ad%2Fchat-room?ref=badge_large)
