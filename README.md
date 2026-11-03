# dsh-qq-wake

让 QQ 绑定的会话**一叫就醒**。

## 0.5.2 修了什么（2026-11-04）

插件在「已安装插件」页里显示异常，日志里是：

```
TypeError: Invalid effect
dsh: warning: 1 entry did not activate
```

原因：`lib/index.js` 的 `apply` 被写成了 `export async function apply`，末尾还 `return { 状态, 扫日志, ... }`。
DSH 的 cordis 用 `safeCollect` 收 effect，**只认 `undefined` 或清理函数** —— Promise 和普通对象都会判成
`Invalid effect`，整个 entry 直接不激活（定时器其实已经挂上了，但宿主认为这个插件没起来）。
现在 `apply` 是同步函数、不返回值，启动巡检改成「发出去就不等」，清理统一走 `ctx.effect`，
并用代际号保证旧实例的 cleanup 不会掐掉新一代的定时器。

顺手补了测试：`npm test` 会断言 `apply` 不是 async、不返回值、挂上了 `ctx.effect`。

## 它解决什么

`dsh-qq-link` 在把一条 QQ 消息落进会话之前，只用 `ctx.agents.get(id)` 找「已经活着的 agent」
（`node_modules/dsh-qq-link/lib/host.js` 的 `找agent`，拿不到就走失败分支）。而 DSH 里的会话是
「用才装载」的 —— GUI 没打开过就没有活 agent，于是 QQ 消息要等有人把那间会话点开才落得进去。

实测过一次：20:23:42 发消息 → 每 2 秒刷一条
`qq-bridge: 这条先没转进去（ff1818ac：那间会话现在没活着（ff1818ac），先把它打开），下一跳再试`
→ 20:24:12 才落进去。**29 秒全耗在等会话醒**。

这个插件盯的就是那行字：一出现，就用 `ctx.agents.resume({ resumeSessionId })` 把那一间提起来，
下一跳 qq-link 就能 `get` 到，消息立刻落地。

## 为什么不轮询

第一版是每 20 秒巡检一遍，被否了 —— 打游戏的时候白烧 CPU。
现在改成 `fs.watch`（内核事件，闲着零开销）+ **只读日志的新增字节**（每个文件记住 offset），
默认一个定时器都不挂（`兜底秒: 0`）。

## 设置面板

**设置 → QQ 唤醒**（这一段就是 `lib/client.js`）：

| 控件 | 干什么 |
| --- | --- |
| 总开关 | 关掉就彻底不管，日志里那句话也不理 |
| 盯运行日志 | 唯一的触发源；关掉基本等于停用 |
| 跟着 QQ 绑定走 | 从 `~/.dsh/qq-bridge-config.json` 的 `绑定[].会话` 读绑了哪几间 |
| 同一间冷却（秒） | 防日志每 2 秒一条把叫醒刷成风暴，默认 10 |
| 兜底巡检（秒） | 0 = 不巡检（推荐）；填了才会挂一个很慢的定时器 |
| 额外会话 id | 一行一个完整 id，绑不定的时候拿来兜底 |
| **模型选项卡** | 「DSH 设置」= 用 profile 里 `agent-default-model` 那套（provider 由 profile 定，模型 / 思考强度可以在下面盖上去）；其余每个芯片是宿主真正注册了的 provider（`ctx.llm.listProviders()`），最后一个「自定义」可以手填 route 名 |
| 模型 / 思考强度 | 选完 provider 自动拉这一家的模型（`ctx.llm.listModels({ provider })`），模型定下来再列它支持的思考强度（`reasoning.efforts`）；宿主报不出来就退化成手填框。「DSH 设置」这一档也会列 |
| URL / 密钥-cookie | 只有非「DSH 设置」时才出现；密钥用 AES-256-GCM 加密后才写进 `~/.dsh/dsh-qq-wake.json`，钥匙在 `~/.dsh/.qq-wake-secret`（0600），接口只回「设没设」，明文不回前端 |
| **测一下** | 把每间会话挨个查：活着的只报告，睡着的**真的 resume** 一次，然后摊出明细 |

配置存在 `~/.dsh/dsh-qq-wake.json`（面板保存时写；手改也行，刷新就生效）。

> 自定义 provider 的边界：面板只能把 route 名 / URL / 密钥记下来，**真让 DSH 认得那个名字**
> 得在 profile 的 `cordis.patch.yml` 里挂 `@deepseek-ai/dsh-llm-pi-ai` 的 `providers`（`baseURL` + `apiKeyEnv`），
> 再重启一次。DSH 的凭证是 `apiKeyEnv` → credentials / 环境变量那一套，不是浏览器 cookie；
> 面板里写 cookie 只当「一串密钥」存，能用到它的适配器得自己去读。

## 宿主侧

| 路由 | 作用 |
| --- | --- |
| `GET /dsh-qq-wake/state` | 状态 + 当前配置（密钥已脱敏） |
| `GET /dsh-qq-wake/llm` | 宿主注册的 provider / 各自模型 / 各自思考强度 + 「DSH 设置」那一档的当前值 |
| `POST /dsh-qq-wake/save` | 存配置并重建 watcher |
| `POST /dsh-qq-wake/test` | 探一遍 + 真叫醒，回明细 |

> 注意：DSH 自己的 `ctx.webServer` 对外部浏览器一律 403 `Browser access is disabled`，
> 所以这三条只有 DSH 页面自己（同源 fetch）打得通。想用浏览器直接看，得另起小端口。

## 自测

```bash
npm test     # scripts/selftest.mjs：尾八认会话、日志增量、冷却、半行、配置归一/存取、测一下
npm run smoke # scripts/smoke-client.mjs：把 client.js 塞进假 React 渲染，确认面板不白屏
```

## 两个踩过的坑

1. **热重载会复用 `globalThis` 上的旧 state**。0.1.0 的 state 没有 `watchers` 字段，
   0.2.0 的 `停()` 一 `for...of` 就 `TypeError: state.watchers is not iterable`，
   整个 profile recompose 失败、`config reload … failed`。
   现在按「新默认值补缺、老的留着」合并，`停()` 里再 `Array.isArray` 兜一下。
2. **改 `lib/index.js` 宿主不会热重载**。日志只会说
   `changed modules keep running their previous code until a restart` ——
   host 侧有改动（比如加路由）得重启 DSH 才会真的跑新代码。
   客户端 `lib/client.js` 相反：刷新页面就好。
