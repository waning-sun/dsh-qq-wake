// dsh-qq-wake —— 让 QQ 绑定的会话「一叫就醒」
//
// 为什么要它：
//   dsh-qq-link 落地一条 QQ 消息前，只用 ctx.agents.get(id) 找「活着的 agent」
//   （node_modules/dsh-qq-link/lib/host.js:1645-1658 的 找agent，2381-2382 的失败分支）。
//   拿不到就每 2 秒重试，同时往运行日志里刷：
//     qq-bridge: 这条先没转进去（ff1818ac：那间会话现在没活着（ff1818ac），先把它打开），下一跳再试
//   而 DSH 里的会话是「用才装载」的 —— GUI 没打开过就没有活 agent，
//   于是 QQ 消息要等有人把那个会话打开（实测 29 秒：20:23:42 发 → 20:24:12 才落进去）。
//
// 这一层做的事（v0.2.0：事件驱动，不轮询）：
//   盯着 ~/.dsh/logs/desktop-next* —— 一旦日志里冒出「那间会话现在没活着（xxxx）」，立刻
//   ctx.agents.resume({ resumeSessionId }) 把那一间提起来（dsh-agent 的 README「创建或恢复 agent」；
//   实现见 dsh-agent-loop/lib/index.js:1963 的 resume）。qq-link 下一跳就能 get 到，消息落地。
//
// 为什么不做定时巡检：
//   定时器每 20 秒醒来一次，打游戏的时候也是白烧 CPU。这里改成 fs.watch（内核事件，闲着零开销），
//   而且只读日志的**新增字节**（记住每个文件的 offset），不做全文件扫描。
//
// 注意：
//   · 只唤日志点名的那个会话；活着的绝不去碰（resume 会抢 sessionPersistence 的写句柄 → session/writer-held）。
//   · 同一间会话 冷却秒 内只试着唤一次，防止日志每 2 秒一条把 resume 刷成风暴。
//   · resume 出来的 handle 归本插件所有，插件销毁时 cordis 会 abort 它 —— 重载后下一次日志出现会再唤。
//   · 会话列表默认直接读 dsh-qq-link 的配置（~/.dsh/qq-bridge-config.json 的 绑定[].会话）。
//
// v0.5.2（2026-11-04）：修「插件显示异常 / 1 entry did not activate」。
//   根因：apply 被写成了 `export async function apply` 并且 `return { status, 扫日志, ... }`。
//   cordis 的 safeCollect 只接受「undefined」或「清理函数」，Promise 和普通对象都会被判成
//   `TypeError: Invalid effect`，于是整个 entry 激活失败 —— 定时器和路由虽然已经挂上了，
//   但宿主认为这个插件没起来，已安装插件页里就是异常态；顺带每次 resume 还会在
//   agent-registry 里冒出 `agent/disposed listener threw`。
//   改法：apply 改同步、不返回值（启动巡检改成发出去不等），清理改回 ctx.effect，
//   用代际号保证旧实例的 cleanup 不会掐掉新一代的定时器。

import { existsSync, openSync, readSync, closeSync, statSync, watch, watchFile, unwatchFile, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'dsh-qq-wake'
export const version = '0.5.2'
export const inject = ['agents', 'webServer']

const STATE_KEY = Symbol.for('dsh.qq-wake.state')

/** 热重载会重新 import 这个模块，状态得挂在 globalThis 上，否则 watcher / 定时器会叠起来。
 *  旧版本留下的 state 可能缺字段（0.1.0 → 0.2.0 就是这样炸的：state.watchers is not iterable），
 *  所以这里按「新默认值补缺、老的留着」合并一次。 */
const state = (() => {
  const 空 = {
    watchers: [],
    timer: null,
    handles: new Map(),
    offsets: new Map(),
    pending: new Map(),
    recent: new Map(),
    busy: false,
    woke: 0,
    failed: 0,
    seen: 0,
    lastAt: 0,
    lastNote: '',
    logDir: '',
    cfg: null,
    ctx: null,
    最近: [],
    gen: 0,
    说过: new Set(),
  }
  const 旧 = globalThis[STATE_KEY]
  const s = 旧 && typeof 旧 === 'object' ? 旧 : 空
  for (const k of Object.keys(空)) {
    if (s[k] === undefined || s[k] === null) s[k] = 空[k]
  }
  if (!Array.isArray(s.watchers)) s.watchers = []
  if (!(s.说过 instanceof Set)) s.说过 = new Set()
  if (!(s.offsets instanceof Map)) s.offsets = new Map()
  if (!(s.pending instanceof Map)) s.pending = new Map()
  if (!(s.recent instanceof Map)) s.recent = new Map()
  if (!(s.handles instanceof Map)) s.handles = new Map()
  globalThis[STATE_KEY] = s
  return s
})()

const DEFAULTS = {
  开: true,
  看日志: true,
  跟随QQ绑定: true,
  会话: [],
  冷却秒: 10,
  检查毫秒: 1200,
  兜底秒: 0, // 0 = 不做定期巡检；给个 >0 才开一个很慢的兜底
  provider: '', // 空 = 去 profile 的 agent-default-model 里读，读不到用 deepseek-account
  model: '', // 空 = 同上
  思考强度: '', // 比如 max；空 = 不传，用模型自己的默认
  自定义: false, // true = 用下面自己填的 provider/URL/密钥，而不是「跟随 DSH」
  providerURL: '', // 自定义 route 的 endpoint（http(s)://…）
  密钥密文: '', // 面板里填的密钥，AES-256-GCM 加密后只存这个字段；明文永不落盘
}

/** 「那间会话现在没活着（ff1818ac）」——qq-link 的失败行；括号里是会话 id 的尾巴。 */
const 没活着正则 = /那间会话现在没活着[（(]([0-9A-Za-z_-]{4,64})[）)]/g

function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env : path.join(homedir(), '.dsh')
}

/** 从 profile 的 patch 层里抠 agent-default-model 的 provider/model —— 本机最权威的一处。
 *  抠不到就回空，调用处再退到硬默认。 */
export function 读默认模型() {
  const 候选 = [
    path.join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml'),
    path.join(dshHome(), 'profiles', 'desktop', 'cordis.yml'),
  ]
  for (const file of 候选) {
    try {
      if (!existsSync(file)) continue
      const 文 = readFileSync(file, 'utf8')
      const 位 = 文.indexOf('agent-default-model')
      if (位 < 0) continue
      const 块 = 文.slice(位, 位 + 800)
      const p = /(?:^|\n)\s*provider:\s*['"]?([A-Za-z0-9_.:-]+)/.exec(块)
      const m = /(?:^|\n)\s*model:\s*['"]?([A-Za-z0-9_.:-]+)/.exec(块)
      const r = /(?:^|\n)\s*reasoningEffort:\s*['"]?([A-Za-z0-9_-]+)/.exec(块)
      if (p && m) return { provider: p[1], model: m[1], 思考强度: r ? r[1] : '', 来源: file }
    } catch {
      /* 换下一个候选 */
    }
  }
  return { provider: '', model: '', 思考强度: '', 来源: '' }
}

/** resume 必须带 provider/model —— 不带的话 agent 能建起来，但第一句就报
 *  `agent "…" has no provider/model: set AgentOptions.provider and AgentOptions.model`。
 *
 *  两档：
 *   · 自定义（自定义:true）= provider / model / 思考强度 全听面板的；
 *   · DSH 设置（自定义:false）= provider 永远跟 profile 的 agent-default-model，
 *     面板上挑的模型 / 思考强度盖在上面（没挑就用 profile 的）。
 *  再往下兜硬默认 deepseek-account / deepseek-flash。 */
export function 拼模型(cfg) {
  const 实 = { ...DEFAULTS, ...(cfg || {}) }
  const 跟DSH = 实.自定义 !== true
  const 盘 = 读默认模型()
  const 手p = String(实.provider || '').trim()
  const 手m = String(实.model || '').trim()
  const out = {
    provider: 跟DSH ? 盘.provider || 手p || 'deepseek-account' : 手p || 盘.provider || 'deepseek-account',
    model: 手m || 盘.model || 'deepseek-flash',
  }
  const 强度 = String(实.思考强度 || '').trim() || 盘.思考强度 || ''
  if (强度 !== '') out.reasoningEffort = 强度
  return out
}

/** 存密钥文件（AES-256-GCM 的钥匙）—— 只在第一次生成，之后复用。 */
function 密钥() {
  const f = path.join(dshHome(), '.qq-wake-secret')
  try {
    if (existsSync(f)) {
      const s = readFileSync(f, 'utf8').trim()
      if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex')
    }
  } catch {
    /* 读不到就当没生成过 */
  }
  const 新 = randomBytes(32)
  try {
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f, 新.toString('hex'), { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* 写不进去也能用内存里的这把，只是重启后解不开旧密文 */
  }
  return 新
}

/** 加密一段字符串（面板里填的 URL / 密钥），落盘只存密文。格式 v1:iv:tag:密文（都是 base64）。 */
export function 加密(明文) {
  const 文 = String(明文 == null ? '' : 明文)
  if (文 === '') return ''
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', 密钥(), iv)
  const 密 = Buffer.concat([c.update(文, 'utf8'), c.final()])
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${密.toString('base64')}`
}

/** 解密密文；解不开回空串（换过钥匙、手改坏了都算）。 */
export function 解密(密文) {
  const s = String(密文 == null ? '' : 密文)
  if (!s.startsWith('v1:')) return ''
  const 段 = s.split(':')
  if (段.length !== 4) return ''
  try {
    const d = createDecipheriv('aes-256-gcm', 密钥(), Buffer.from(段[1], 'base64'))
    d.setAuthTag(Buffer.from(段[2], 'base64'))
    return Buffer.concat([d.update(Buffer.from(段[3], 'base64')), d.final()]).toString('utf8')
  } catch {
    return ''
  }
}

/** 问宿主要「这台机器上到底注册了哪些 provider / 每个 provider 有哪些模型 / 每个模型支持哪些思考强度」。
 *  全部走 ctx.llm 的公开面：listProviders() 与 listModels()。宿主没装 llm、或者适配器没实现
 *  listModels（基类默认返回空数组），就老老实实回空列表 —— 面板那边会退化成手填。 */
export async function llm快照(ctx) {
  const llm = ctx && (ctx.llm || (typeof ctx.get === 'function' ? ctx.get('llm') : null))
  if (!llm) return { ok: false, 说: '这个宿主没装 llm 服务（ctx.llm 拿不到）', providers: [] }

  let 原始 = []
  try {
    原始 = typeof llm.listProviders === 'function' ? await llm.listProviders() : []
  } catch (error) {
    return { ok: false, 说: `listProviders 炸了：${error && error.message ? error.message : error}`, providers: [] }
  }
  if (!Array.isArray(原始)) 原始 = []

  const providers = []
  for (const 一个 of 原始) {
    const id = typeof 一个 === 'string' ? 一个 : String((一个 && (一个.id || 一个.name || 一个.provider)) || '')
    if (id === '') continue
    let 模型 = []
    try {
      模型 = await llm.listModels({ provider: id })
    } catch {
      try {
        模型 = await llm.listModels(id)
      } catch {
        模型 = []
      }
    }
    const 清 = (Array.isArray(模型) ? 模型 : [])
      .map((m) => {
        if (!m) return null
        if (typeof m === 'string') return { id: m, 强度: [] }
        const mid = String(m.id || m.name || m.model || '')
        if (mid === '') return null
        const 们 = Array.isArray(m.reasoning && m.reasoning.efforts) ? m.reasoning.efforts : []
        return {
          id: mid,
          名: String(m.label || m.displayName || mid),
          强度: 们.map((e) => (typeof e === 'string' ? e : String((e && (e.id || e.name)) || ''))).filter(Boolean),
        }
      })
      .filter(Boolean)
    providers.push({ id, models: 清 })
  }
  return { ok: true, 说: '', providers }
}

/** 从 dsh-qq-link 的配置里读「哪些会话被绑了」。读不到就当空的，不影响手工配的 会话。 */
export function 读绑定会话() {
  const file = path.join(dshHome(), 'qq-bridge-config.json')
  try {
    if (!existsSync(file)) return []
    const 配置 = JSON.parse(readFileSync(file, 'utf8'))
    const 清单 = Array.isArray(配置 && 配置.绑定) ? 配置.绑定 : []
    const out = []
    for (const 条 of 清单) {
      if (!条 || 条.开 === false) continue
      const id = String(条.会话 || '').trim()
      if (id !== '' && !out.includes(id)) out.push(id)
    }
    return out
  } catch {
    return []
  }
}

function 短(id) {
  const s = String(id == null ? '' : id)
  return s.length <= 12 ? s : s.slice(-12)
}

/** 会话 id 的「尾巴」：去掉 session- 前缀后取后 8 位，正好对上 qq-link 日志里的短 id。 */
export function 尾八(id) {
  const s = String(id == null ? '' : id).trim().replace(/^session-/, '')
  return s.slice(-8)
}

/** 照 qq-link 的写法：带 / 不带 `session-` 前缀两个方向都试。 */
function 找活(ctx, id) {
  const 原 = String(id == null ? '' : id).trim()
  if (原 === '') return undefined
  const 候选 = [原]
  if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
  else 候选.push('session-' + 原)
  for (const 一个 of 候选) {
    try {
      const a = ctx.agents.get(一个)
      if (a !== undefined) return a
    } catch {
      /* 有的实现会抛，当成没有 */
    }
  }
  return undefined
}

function 说(ctx, msg) {
  const line = `[qq-wake] ${msg}`
  state.lastNote = msg
  try {
    if (ctx && ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info(line)
      return
    }
    if (ctx && typeof ctx.logger === 'function') {
      ctx.logger(line)
      return
    }
  } catch {
    /* 落到 console */
  }
  console.log(line)
}

function 目标(ctx, cfg) {
  const 手 = Array.isArray(cfg.会话) ? cfg.会话.map((x) => String(x || '').trim()).filter(Boolean) : []
  const 绑 = cfg.跟随QQ绑定 ? 读绑定会话() : []
  return [...new Set([...手, ...绑])]
}

/** 短 id → 完整会话 id。先按尾巴对绑定列表，再退化到直接把短 id 当 id 试。 */
export function 认会话(短id, 清单) {
  const 尾巴 = String(短id || '').trim()
  if (尾巴 === '') return ''
  for (const id of 清单) {
    if (尾八(id) === 尾巴 || String(id).endsWith(尾巴) || String(id) === 尾巴) return id
  }
  return 尾巴.startsWith('session-') ? 尾巴 : ''
}

/** 叫醒一间会话。活着就不碰。 */
export async function 唤醒(ctx, id, 来源) {
  if (找活(ctx, id) !== undefined) {
    state.handles.delete(id)
    return { 会话: id, 状态: '活着' }
  }
  try {
    const 模型 = 拼模型(state.cfg)
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: 模型 })
    state.handles.set(id, handle)
    state.woke += 1
    state.最近.unshift({ at: new Date().toISOString(), 会话: id, 尾: 尾八(id), 来源 })
    if (state.最近.length > 20) state.最近.length = 20
    说(ctx, `唤醒成功 ${短(id)}（${来源}｜${模型.provider}/${模型.model}）`)
    return { 会话: id, 状态: '已唤醒' }
  } catch (error) {
    state.failed += 1
    const 因 = error && error.message ? error.message : String(error)
    说(ctx, `唤醒失败 ${短(id)}：${因}`)
    return { 会话: id, 状态: '唤醒失败', 原因: 因 }
  }
}

/** 手动/兜底用的整轮巡检（默认不挂定时器，只给工具和兜底秒用）。 */
export async function 巡检(ctx, cfg, 来源) {
  if (state.busy) return { ok: true, 跳过: '上一轮还没跑完' }
  state.busy = true
  const 结果 = []
  try {
    for (const id of 目标(ctx, cfg)) 结果.push(await 唤醒(ctx, id, 来源))
    state.lastAt = Date.now()
    return { ok: true, 结果 }
  } finally {
    state.busy = false
  }
}

/** 读一个文件的**新增**部分。新文件或轮转（size 变小）时直接跳到尾部，不回放历史错误。 */
function 读增量(file) {
  try {
    const st = statSync(file)
    let from = state.offsets.get(file)
    if (from === undefined || st.size < from) {
      state.offsets.set(file, st.size)
      state.pending.set(file, '')
      return []
    }
    if (st.size === from) return []
    const len = Math.min(st.size - from, 512 * 1024)
    const buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, len, from)
    } finally {
      closeSync(fd)
    }
    state.offsets.set(file, from + len)
    const 余 = state.pending.get(file) || ''
    const 全 = 余 + buf.toString('utf8')
    const 行们 = 全.split(/\r?\n/)
    const 尾 = 行们.pop() || ''
    state.pending.set(file, 尾.length > 16384 ? '' : 尾)
    return 行们
  } catch {
    return []
  }
}

/** 扫一轮新增日志：有什么会话被点名「没活着」，就叫醒它。 */
export function 扫日志(ctx, cfg) {
  const 清单 = 目标(ctx, cfg)
  const 冷却 = Math.max(0, Number(cfg.冷却秒) || 0) * 1000
  const now = Date.now()
  const 出事 = new Set()
  for (const [file] of state.offsets) {
    for (const 行 of 读增量(file)) {
      没活着正则.lastIndex = 0
      let m
      while ((m = 没活着正则.exec(行)) !== null) {
        const 短id = m[1]
        state.seen += 1
        const 全id = 认会话(短id, 清单)
        if (全id === '') {
          // 同一条「绑定里没有它」只报一次：改绑定之前那一批旧会话的失败行会刷几百条
          const 键 = '没:' + 短id
          if (!state.说过.has(键)) {
            state.说过.add(键)
            说(ctx, `日志里点了 ${短id}，但绑定里没有它（跳过；改过绑定就正常了）`)
          }
          continue
        }
        出事.add(全id)
      }
    }
  }
  if (出事.size === 0) return { ok: true, 触发: 0 }
  const 待办 = []
  for (const id of 出事) {
    const 上次 = state.recent.get(id) || 0
    if (now - 上次 < 冷却) continue
    state.recent.set(id, now)
    待办.push(id)
  }
  if (待办.length === 0) return { ok: true, 触发: 出事.size, 跳过: '冷却中' }
  说(ctx, `日志说要唤 ${待办.map(短).join('、')}`)
  // 不 await：watcher 回调里跑，交给事件循环，避免堵住日志读取
  for (const id of 待办) {
    唤醒(ctx, id, '日志').catch((error) => {
      说(ctx, `唤醒出错：${error && error.message ? error.message : error}`)
    })
  }
  state.lastAt = now
  return { ok: true, 触发: 出事.size, 唤醒: 待办 }
}

// ── 配置：面板里保存的那份，落在 ~/.dsh/dsh-qq-wake.json ──────────────────────

export const ROUTE = '/dsh-qq-wake'

export function 配置路径() {
  return path.join(dshHome(), 'dsh-qq-wake.json')
}

function 夹紧(n, lo, hi, 缺) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 缺
  return Math.min(hi, Math.max(lo, x))
}

/** 白名单合并：只认 DEFAULTS 里那几项，数字夹紧，会话列表去空去重。 */
export function 归一(patch) {
  const 源 = patch && typeof patch === 'object' ? patch : {}
  const 真 = (v) => v !== false && v !== 'false' && v !== 0 && v !== '0'
  return {
    开: 源.开 === undefined ? DEFAULTS.开 : 真(源.开),
    看日志: 源.看日志 === undefined ? DEFAULTS.看日志 : 真(源.看日志),
    跟随QQ绑定: 源.跟随QQ绑定 === undefined ? DEFAULTS.跟随QQ绑定 : 真(源.跟随QQ绑定),
    会话: Array.isArray(源.会话)
      ? [...new Set(源.会话.map((x) => String(x || '').trim()).filter(Boolean))]
      : [],
    冷却秒: 夹紧(源.冷却秒, 0, 600, DEFAULTS.冷却秒),
    检查毫秒: 夹紧(源.检查毫秒, 300, 60000, DEFAULTS.检查毫秒),
    兜底秒: 夹紧(源.兜底秒, 0, 3600, DEFAULTS.兜底秒),
    provider: String(源.provider || '').trim(),
    model: String(源.model || '').trim(),
    思考强度: String(源.思考强度 || '').trim(),
    自定义: 真(源.自定义),
    providerURL: String(源.providerURL || '').trim(),
    // 面板送来的明文密钥在这里就地加密，落盘只留密文；已成密文的原样保留
    密钥密文: 源.密钥 ? 加密(String(源.密钥)) : String(源.密钥密文 || ''),
  }
}

/** 文件里的配置 → 跟 DEFAULTS 合一次。文件坏了就当没配过。 */
export function 读配置() {
  const file = 配置路径()
  try {
    if (!existsSync(file)) return { ...DEFAULTS }
    return 归一({ ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) })
  } catch {
    return { ...DEFAULTS }
  }
}

/** 存一份；传 patch 就只改里面那几个键。返回存完之后的完整配置。 */
export function 存配置(patch) {
  const 旧 = state.cfg || 读配置()
  const 送 = patch && typeof patch === 'object' ? patch : {}
  const 合 = { ...旧, ...送 }
  // 面板只拿得到「密钥已设」，拿不到密文；没送新密钥就沿用盘上那份，别把它抹掉
  if (!送.密钥 && !送.密钥密文) 合.密钥密文 = 旧.密钥密文 || ''
  const 新 = 归一(合)
  const file = 配置路径()
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(新, null, 2) + '\n', 'utf8')
  } catch (error) {
    return { ok: false, 说: `存不下：${error && error.message ? error.message : error}`, 配置: 新 }
  }
  state.cfg = 新
  return { ok: true, 说: '存好了', 配置: 新, 文件: file }
}

/** 面板上那个「测一下」：逐间看是活的还是睡的，睡着的真叫醒，回一份明细。 */
export async function 测试(ctx, cfg) {
  const 清单 = 目标(ctx, cfg)
  const 明细 = []
  for (const id of 清单) {
    if (找活(ctx, id) !== undefined) {
      明细.push({ 会话: id, 尾: 尾八(id), 状态: '活着', 原因: '' })
      continue
    }
    const r = await 唤醒(ctx, id, '面板测试')
    明细.push({ 会话: id, 尾: 尾八(id), 状态: r.状态, 原因: r.原因 || '' })
  }
  const 活数 = 明细.filter((x) => x.状态 === '活着').length
  const 醒数 = 明细.filter((x) => x.状态 === '已唤醒').length
  const 败数 = 明细.filter((x) => x.状态 === '唤醒失败').length
  return {
    ok: 清单.length > 0 && 败数 === 0,
    at: new Date().toISOString(),
    会话数: 清单.length,
    活着: 活数,
    唤醒成功: 醒数,
    唤醒失败: 败数,
    明细,
    说:
      清单.length === 0
        ? '一间会话都没配：先在 dsh-qq-link 里绑一个，或者在下面手填会话 id'
        : 败数 === 0
          ? `通了：${活数} 间本来就活着，${醒数} 间被我叫醒`
          : `${败数} 间叫不醒，看下面的原因`,
  }
}

// ── 给网页那半边用的三条路由（只有 DSH 自己的页面打得通，外部浏览器一律 403） ──

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload === undefined ? null : payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let buf = ''
    let over = false
    req.on('data', (c) => {
      if (over) return
      buf += c
      if (buf.length > limit) {
        over = true
        buf = ''
      }
    })
    req.on('end', () => {
      if (over) return resolve(null)
      if (buf.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(buf))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** 给面板看的配置：密钥只回「设没设」，密文和明文都不出宿主。 */
function 脱敏(盘) {
  const 源 = 盘 && typeof 盘 === 'object' ? 盘 : {}
  const { 密钥密文, ...其余 } = 源
  return { ...其余, 密钥已设: !!(密钥密文 && 密钥密文 !== '') }
}

function 注册路由(ctx) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') return
  // ⚠ 不能写 ctx.effect(() => ctx.webServer.register({...}))：
  // register 返回的可能不是函数（而这台机器上它返回的不是函数），
  // cordis 看到 effect 回调返回非函数就抛 `TypeError: Invalid effect`（16:37:19 的日志里就是它）。
  // 所以手动收集 unsubscribe，再交给一个「确定返回函数」的 effect。
  const 卸 = []
  const 收 = (r) => {
    if (typeof r === 'function') 卸.push(r)
    else if (r && typeof r.then === 'function') {
      r.then((f) => {
        if (typeof f === 'function') 卸.push(f)
      }).catch(() => {})
    }
  }
  const route = (子, handler) => {
    try {
      收(
        ctx.webServer.register({
          kind: 'exact',
          path: ROUTE + 子,
          handler: (req, res) => {
            Promise.resolve(handler(req, res)).catch((error) => {
              try {
                sendJson(res, 500, { ok: false, 说: String(error && error.message ? error.message : error) })
              } catch {
                /* 已经回过了 */
              }
            })
          },
        }),
      )
    } catch (error) {
      说(ctx, `路由 ${子} 挂不上：${error && error.message ? error.message : error}`)
    }
  }
  ctx.effect(() => () => {
    for (const f of 卸.splice(0)) {
      try {
        f()
      } catch {
        /* 已经不在 webServer 里了 */
      }
    }
  })

  route('/state', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, 说: '只认 GET' })
    const 盘 = 读配置()
    sendJson(res, 200, { ...状态(盘), 配置: 脱敏(盘), 文件: 配置路径(), 模型: 拼模型(盘), 在跑: state.cfg || null })
  })

  // 让面板自己问宿主：这台机器上有哪些 provider、各自有哪些模型、各自支持哪些思考强度
  route('/llm', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, 说: '只认 GET' })
    const 快照 = await llm快照(state.ctx || ctx)
    sendJson(res, 200, { ...快照, 跟随DSH: 读默认模型(), 现在用的: 拼模型(state.cfg || 读配置()) })
  })

  route('/save', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, 说: '只认 POST' })
    const body = await readBody(req)
    if (!body) return sendJson(res, 400, { ok: false, 说: 'body 不是合法 JSON' })
    const r = 存配置(body)
    if (r.ok && state.ctx) {
      try {
        装配(state.ctx, r.配置)
      } catch (error) {
        r.说 = `存好了，但重装失败：${error && error.message ? error.message : error}`
      }
    }
    sendJson(res, r.ok ? 200 : 500, { ...r, 配置: 脱敏(r.配置), 状态: 状态(r.配置) })
  })

  route('/test', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, 说: '只认 POST' })
    const body = (await readBody(req)) || {}
    const cfg = body && body.使用文件 === true ? 读配置() : state.cfg || 读配置()
    sendJson(res, 200, await 测试(state.ctx, cfg))
  })
}

/** 装配一轮：清干净上一轮、起 watcher、按需要挂兜底。apply 和面板保存都走这里。 */
function 装配(ctx, cfg) {
  // 记住上一轮的读取位置：重载/保存面板都会重新装配，如果这里把 offset 重置成
  // 「文件当前末尾」，那两次装配之间到达的失败行就被静默跳过了
  // （实测 16:10:18–16:10:26 那一批「没活着（b48db196）」就是这么丢的）。
  const 旧偏移 = new Map(state.offsets)
  停()
  state.handles.clear()
  state.offsets.clear()
  state.pending.clear()
  state.recent.clear()
  state.说过.clear()
  state.cfg = cfg
  state.ctx = ctx

  if (cfg.开 === false) {
    说(ctx, '没开（开: false），什么都不做')
    return
  }

  const 清单 = 目标(ctx, cfg)

  if (cfg.看日志 !== false) {
    const ok = 起Watcher(ctx, cfg, 旧偏移)
    说(
      ctx,
      ok
        ? `已起（看日志）：盯着 ~/.dsh/logs/desktop-next*，只有日志里出现「那间会话现在没活着」才动手；涉及 ${清单.length} 间会话（${清单.map(短).join('、') || '还没有绑定'}）`
        : '看日志没起来',
    )
  }

  const 兜底秒 = Math.max(0, Number(cfg.兜底秒) || 0)
  if (兜底秒 > 0) {
    state.timer = setInterval(() => {
      巡检(ctx, cfg, '兜底').catch(() => {})
    }, 兜底秒 * 1000)
    if (typeof state.timer.unref === 'function') state.timer.unref()
    说(ctx, `兜底巡检：每 ${兜底秒} 秒一次`)
  }
}

function 停() {
  const 们 = Array.isArray(state.watchers) ? state.watchers : []
  for (const w of 们) {
    try {
      w.close()
    } catch {
      /* 已经关了 */
    }
  }
  state.watchers = []
  const 记 = Array.isArray(state.watchFiles) ? state.watchFiles : []
  for (const f of 记) {
    try {
      unwatchFile(f)
    } catch {
      /* 没挂上 */
    }
  }
  state.watchFiles = []
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  if (state.bootTimer) {
    clearTimeout(state.bootTimer)
    state.bootTimer = null
  }
}

/** 盯住日志目录：只关心 desktop-next*，事件来了才读新增字节。 */
function 起Watcher(ctx, cfg, 旧偏移) {
  const dir = path.join(dshHome(), 'logs')
  state.logDir = dir
  if (!existsSync(dir)) {
    说(ctx, `没找到日志目录 ${dir}，这次先不盯日志`)
    return false
  }
  try {
    const w = watch(dir, { persistent: false }, (_evt, filename) => {
      const 名 = filename ? String(filename) : ''
      if (名 !== '' && !/^desktop-next.*\.(log|jsonl)$/i.test(名)) return
      try {
        扫日志(ctx, cfg)
      } catch (error) {
        说(ctx, `读日志出错：${error && error.message ? error.message : error}`)
      }
    })
    if (typeof w.unref === 'function') w.unref()
    state.watchers.push(w)
  } catch (error) {
    说(ctx, `盯日志失败：${error && error.message ? error.message : error}`)
    return false
  }
  // 先记下各文件的 offset（不读历史，别把陈年错误当新事件）；
  // 但如果上一轮已经在读这个文件，就接着上次的位置 —— 两次装配之间到达的行不能漏。
  for (const 一个 of ['desktop-next.log']) {
    const f = path.join(dir, 一个)
    try {
      if (!existsSync(f)) continue
      const 尺 = statSync(f).size
      const 上次 = 旧偏移 instanceof Map ? 旧偏移.get(f) : undefined
      state.offsets.set(f, Number.isFinite(上次) && 上次 <= 尺 ? 上次 : 尺)
    } catch {
      /* 忽略 */
    }
  }
  // fs.watch 在部分 Windows 文件系统上压根不报事件（实测 14:48:18–14:49:19 那一整分钟
  // 日志刷了几十条，watcher 一次都没醒）。于是挂了 stat 兜底 —— 但那个 setInterval
  // 15:47:09–15:47:48 那一批「没活着（b48db196）」一条也没接住，说明连定时器本身都没在跑。
  // 所以现在做成两条互相独立的腿：
  //   · setInterval 每 1.2 秒看一眼文件大小；
  //   · fs.watchFile（libuv 的 uv_fs_poll，句柄不归我们的 setInterval 管）同样盯着。
  // 任一条活着就够用。再留一条 2 分钟一次的心跳日志，以后不用猜它死没死。
  const 看一变 = () => {
    let 变了 = false
    for (const [f, off] of state.offsets) {
      try {
        if (statSync(f).size !== off) {
          变了 = true
          break
        }
      } catch {
        /* 文件没了就算了 */
      }
    }
    state.ticks = (Number(state.ticks) || 0) + 1
    if (!变了) {
      if (state.ticks % 100 === 0) {
        const 头 = [...state.offsets.keys()].map((f) => path.basename(f)).join(',')
        const 尺 = [...state.offsets.values()].join(',')
        if (state.ticks % 25 === 0) 说(ctx, `心跳：第 ${state.ticks} 次，盯着 ${头 || '（空）'}，offset=${尺 || '-'}`)
      }
      return
    }
    try {
      扫日志(ctx, cfg)
    } catch (error) {
      说(ctx, `读日志出错：${error && error.message ? error.message : error}`)
    }
  }
  if (state.timer) clearInterval(state.timer)
  const 每 = Math.max(500, Number(cfg.检查毫秒) || 1200)
  state.timer = setInterval(看一变, 每)
  if (typeof state.timer.unref === 'function') state.timer.unref()
  try {
    for (const f of state.offsets.keys()) watchFile(f, { interval: 每 }, () => 看一变())
    state.watchFiles = [...state.offsets.keys()]
  } catch (error) {
    说(ctx, `watchFile 挂不上：${error && error.message ? error.message : error}`)
  }
  // 装配完立刻自检一句：以后不用再靠猜「到底是没起来、还是起来了但没看」。
  说(
    ctx,
    `自检：dir=${dir} 文件=${[...state.offsets].map(([f, o]) => `${path.basename(f)}=${o}`).join(' ') || '（空）'} 轮询=${state.timer ? '在' : '没挂上'} watchFile=${state.watchFiles.length} 间隔=${每}ms`,
  )
  return true
}

export function apply(ctx, config) {
  // 优先级：DEFAULTS < 文件里的 < 插件配置（patch 里直接写的 config）
  const cfg = 归一({ ...读配置(), ...(config || {}) })
  // 热重载时 DSH 的顺序是「新实例先 apply、旧实例后 cleanup」，而 state 挂在同一份
  // globalThis 上 —— 旧 cleanup 里的 停() 会把新实例刚起的 stat 兜底定时器一起清掉，
  // 于是 fs.watch 不报事件的那台机器上就彻底不干活了（实测 15:40 那批失败行一条都没被接住）。
  // 用代际号挡一下：只有最新那一代才有资格停。
  const 我这一代 = (state.gen = (Number(state.gen) || 0) + 1)
  装配(ctx, cfg)
  注册路由(ctx)
  // 清理必须挂 effect，而且只在「我还是最新那一代」时才真停 —— 否则旧实例的 cleanup
  // 会把新一代刚建好的定时器/轮询一起掐掉。
  ctx.effect(() => () => {
    if (state.gen === 我这一代) 停()
  })
  // 2026-11-04 的结论：别再指望「日志一响就去叫醒」那条链在宿主里稳稳跑起来 ——
  // 定时器、watchFile、fs.watch 全试过，总有一段是哑的。
  // 换成最土也最不会出错的一条：插件一加载，就把所有绑定会话挨个叫一遍（活着的跳过）。
  // 会话活着时 唤醒 里先用 找活 拦住、不 resume，所以重复叫不会打断正在跑的对话。
  //
  // ⚠ apply **必须同步**、而且**不能 return 任何值**：cordis 的 safeCollect 只认
  // 「undefined」或「清理函数」，apply 写成 async 时返回的 Promise、或者像 0.5.1 那样
  // return 一个对象，都会被判成 `TypeError: Invalid effect`，整个 entry 直接不激活
  // （日志里那句 `dsh: warning: 1 entry did not activate` 就是它）。
  // 所以启动巡检改成「发出去就不等」，出错自己记一行。
  if (cfg.开 !== false) {
    巡检(ctx, cfg, '启动')
      .then((r) => {
        const 名单 = Array.isArray(r && r.结果) ? r.结果 : []
        const 叫过 = 名单.filter((x) => x && x.状态 !== '活着')
        说(
          ctx,
          `启动巡检：${名单.length} 间会话，${叫过.length ? `叫醒 ${叫过.map((x) => 短(x.会话)).join('、')}` : '都还活着'}`,
        )
      })
      .catch((error) => {
        说(ctx, `启动巡检失败：${error && error.message ? error.message : error}`)
      })
  }
}

export function 状态(cfg) {
  const 实 = 归一({ ...DEFAULTS, ...(cfg || {}) })
  return {
    ok: true,
    版本: version,
    开: 实.开 !== false,
    看日志: 实.看日志 !== false,
    跟随QQ绑定: 实.跟随QQ绑定 !== false,
    盯的目录: state.logDir,
    盯的文件: [...state.offsets.keys()],
    冷却秒: Number(实.冷却秒) || 0,
    兜底秒: Number(实.兜底秒) || 0,
    会话: 目标(state.ctx || {}, 实),
    看到次数: state.seen,
    唤醒成功: state.woke,
    唤醒失败: state.failed,
    最近一次: state.lastAt ? new Date(state.lastAt).toISOString() : '',
    最近一句: state.lastNote,
    最近唤醒: state.最近.slice(0, 10),
    正在跑: Boolean(state.busy),
  }
}

export const __internals = {
  读绑定会话,
  找活,
  目标,
  短,
  尾八,
  认会话,
  扫日志,
  读增量,
  归一,
  读配置,
  存配置,
  读默认模型,
  拼模型,
  测试,
  配置路径,
  ROUTE,
  state,
  DEFAULTS,
  没活着正则,
}
