# chat-room 项目 Agent 约定（AGENTS.md）

> 本文件供 AI Agent 在本仓库工作时使用。全局约定见 `~/.config/opencode/AGENTS.md`，此处只放本项目特有的规则与踩坑记录。

## 技术栈

- **Bun 1.3.x**（运行时/打包/测试/YAML/S3 全用内置能力）+ ElysiaJS + bun:sqlite + TypeScript
- 客户端为原生 TS（无框架），构建产物 `static/js/room.client.js`（gitignored，勿手改勿提交）
- **优先使用 Bun 内置功能**。Markdown 手写解析、YAML 用 `Bun.YAML.parse`、S3 用 `Bun.s3`，尽量不引包

## 常用命令

```shell
bun run dev         # 开发（watch 构建 + watch 服务）
bun run build       # 构建客户端 bundle → static/js/room.client.js
bun run start       # 启动服务
bun run typecheck   # bunx tsc --noEmit
bun test            # 全量测试（已排除 reference/**）
```

## 安全基线（Must NOT，违反即打回）

1. 用户数据渲染**零 innerHTML**——一律 `createElement` / `textContent`
2. 所有链接统一 `rel="nofollow noreferrer noopener"` + `target="_blank"`（linkify 与 markdown 链接两处都要）
3. 进入样式上下文的用户输入必须服务端白名单校验：颜色走 `REGEX_HEX_COLOR`（`sanitizeColor`），meta 字段走字段白名单+值域校验（`sanitizeMeta`）
4. 不支持用户 HTML 输入——`<b>hi</b>` 必须原样显示为文本
5. 上传链路：魔数校验（非扩展名）、≤5MB、拒绝 SVG/HTML、随机文件名、单 IP 日配额

## 冻结契约（改动需极端谨慎）

- **DOM 契约 ID**（src/views/room.ts）：`#room-header #online-count #user-list #msg-list #name-input #msg-input #name-color #msg-color #send-btn #toast` 及事件名 `init/online/sys/msg/rename/message/change-name/leave`
- **DB schema**：现有列不可改删；唯一允许的变更是幂等 `ALTER TABLE ... ADD COLUMN` 且必须 try/catch 包裹
- 真实 `db/msg.db` 的 demo 房间 14 条种子数据不可变动

## 测试约定

- 测试隔离：注入 `process.env.DB_PATH = tmpDbPath()`（test/setup.ts），测试**绝不写真实 db/msg.db**（只读打开可以）
- DOM 测试用 `test/dom-stub.ts` 提供的全局 document，**禁止安装 happy-dom/jsdom/linkedom**
- `reference/**`（waline 参考资料）已被 bunfig.toml `pathIgnorePatterns` 排除，不要在其中新增可被扫描到的测试文件

## 本项目踩坑记录（Bun/Elysia 特有，实测）

| 坑 | 结论 |
|---|---|
| Bun 测试环境无内置 DOM | `bun test --dom` 当前版本不存在；需要 DOM 就 import dom-stub |
| `bun test` 所有文件共享同一进程/globalThis | 模块顶层注册的全局会泄漏到其他测试文件；dom-stub 因此带 `readyState:'loading'` 等"无害化"表面 |
| `bun:sqlite` 不支持 shared-cache 内存库 | `file::memory:?cache=shared` 被当作字面文件名在 cwd 落盘；要二次连接检查 schema 就用 `tmpDbPath()` 落盘后 readonly 重开 |
| `Bun.YAML.parse` 类型 | 数字值返回 JS number 而非 string（端口类字段解析需兼容双类型） |
| Elysia 泛型逆变 | 类型化 router 不能赋给裸 `Elysia` 类型，需 `Elysia<any,...>` 显式泛型（见 src/router/upload.ts 注释） |
| 服务端 xss 转义实体 | `processInput(msg,true)` 把 `>`→`&gt;` 等；客户端 markdown 渲染前必须先过 `unescapeEntities`（textContent 渲染保证安全） |
| WAL 迁移不落主文件 | 服务器运行产生的 schema 变更先存在 gitignored 的 -wal 里；断言真实库 schema 时 meta 列按"可选"处理 |
