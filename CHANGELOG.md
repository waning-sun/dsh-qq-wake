# Changelog

## 0.5.5 — 补市场索引两项 + 服务读取全部兜住

- **改**：`package.json` 的 `engines` 里加上 `"dsh": ">=0.2.1-rc.2"`（与 `dshTarget` 对齐），dsh-market 索引不再报 `engines.dsh is missing`。
- **改**：README 增加 `## Requirements` 段（宿主版本 / Node / 需要的宿主服务 / 搭配插件 / 操作系统，表格里注明对应清单字段），市场校验的 `README.md has no Requirements section` 随之消掉。
- **改**：`scripts/check-manifest.mjs`、`scripts/probe-apply-ctx.mjs` 纳入本仓库，`npm test` 变成 `check:manifest → check:apply → selftest` 三道；前者查清单/Requirements/版本号一致，后者用 Proxy 造一份「除核心 API 外一律抛 `without inject`」的 ctx 去调 `apply()`。
- **改**：所有宿主服务读取统一走 `取服务(ctx, 名)` —— 先试直接读、再试 `ctx.get(名)`、都没有就返回 `null`。市场审计那句 `apply() throws when a service it never declared is read` 就是直接读 `ctx.<服务>` 抛出来的；现在探针上下文里只是「拿不到服务」，真宿主里行为不变（`inject` 仍是 `['agents','webServer']`）。
- **改**：`agents` 的用法全部加固（`找活` / `resume` 拿不到就当这间救不了、记一行、不抛）；`ctx.effect(...)` 外面包 try，探针 ctx 不给 effect 也不会让整行判红。
- **改（热重载实测补充）**：真宿主里 `webServer` 偶尔比 `apply` 晚一步就绪（同一份代码，一次挂得上、一次挂不上）。`注册路由` 改成返回布尔结果，`apply` 走 `补挂面板(ctx)`：没挂上就每秒补挂一次、最多 30 次，唤醒本身不等它；`停()` 会清掉这些补挂定时器。
- **测过**：`check:manifest` / `check:apply` / `selftest`（43 项）全绿。
- 版本号：`lib/index.js` 的 `version` 与 `package.json` 同步到 0.5.5。

## 0.5.4 — 启动即唤醒 + 日志兜底

- `apply` 改成同步、不返回值（cordis 的 `safeCollect` 只认 `undefined` 或清理函数，返回 Promise / 对象会被判 `TypeError: Invalid effect`，整个 entry 不激活）。
- 热重载用代际号（`state.gen`）挡住旧实例的 cleanup，避免把新一代的定时器掐掉。
- 启动时把所有绑定会话挨个叫一遍（活着的跳过，不会打断正在跑的对话），之后的失败行由日志增量兜底。
