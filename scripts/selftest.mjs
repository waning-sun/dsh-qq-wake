// 离线自测：不连 DSH，只验「日志里点名没活着 → 认会话 → 调 resume」这条链
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(path.join(tmpdir(), 'qq-wake-'))
const logs = path.join(tmp, 'logs')
mkdirSync(logs, { recursive: true })

// 配置：两间绑定会话（私聊 + 群）
const 私聊 = 'session-3294bd0b-6477-47ce-876c-e3a1ff1818ac'
const 群 = 'session-33e54525-eee5-4c92-b757-20ca6ad2bd2b'
writeFileSync(
  path.join(tmp, 'qq-bridge-config.json'),
  JSON.stringify({
    绑定: [
      { 类型: '私聊', 号码: '1780860463', 会话: 私聊, 开: true },
      { 类型: '群', 号码: '337868603', 会话: 群, 开: true },
      { 类型: '群', 号码: '999999', 会话: 'session-deadbeef-0000-0000-0000-000000000000', 开: false },
    ],
  }),
  'utf8',
)

// 历史错误行：不应该被回放
const logFile = path.join(logs, 'desktop-next.log')
writeFileSync(logFile, '2026-11-03T12:00:00.000Z [info] qq-bridge: 这条先没转进去（ff1818ac：那间会话现在没活着（ff1818ac），先把它打开），下一跳再试\n', 'utf8')

process.env.DSH_HOME = tmp

const { apply, 状态, 尾八, 认会话, 读绑定会话, 归一, 读配置, 存配置, 测试, 配置路径, ROUTE, 拼模型, 读默认模型, 加密, 解密, llm快照, __internals } = await import('../lib/index.js')

const 记录 = []
const 日志 = []
const 活着的 = new Map()
let effect次数 = 0
const ctx = {
  agents: {
    get: (id) => 活着的.get(id),
    resume: async ({ resumeSessionId }) => {
      记录.push(resumeSessionId)
      活着的.set(resumeSessionId, { id: resumeSessionId })
      return { id: resumeSessionId }
    },
  },
  logger: { info: (s) => 日志.push(s) },
  effect: (fn) => {
    effect次数 += 1
    // 模拟 cordis：effect 回调必须立刻返回清理函数（返回别的就 Invalid effect）
    const 清理 = fn()
    assert.equal(typeof 清理, 'function', 'effect 回调必须返回清理函数')
    return 清理
  },
}

let pass = 0
let fail = 0
function 测(名, fn) {
  try {
    fn()
    pass += 1
    console.log(`  [ok] ${名}`)
  } catch (error) {
    fail += 1
    console.log(`  [FAIL] ${名} —— ${error && error.message ? error.message : error}`)
  }
}

console.log('基础：')
测('尾八 私聊', () => assert.equal(尾八(私聊), 'ff1818ac'))
测('尾八 群', () => assert.equal(尾八(群), '6ad2bd2b'))
测('读绑定会话 跳过 开:false', () => {
  const 清单 = 读绑定会话()
  assert.equal(清单.length, 2)
  assert.ok(清单.includes(私聊) && 清单.includes(群))
})
测('认会话 按尾巴', () => {
  assert.equal(认会话('6ad2bd2b', [私聊, 群]), 群)
  assert.equal(认会话('ff1818ac', [私聊, 群]), 私聊)
})
测('认会话 认不出就空', () => assert.equal(认会话('deadbeef', [私聊, 群]), ''))

// apply 必须是**同步**函数、而且**不能有返回值** —— cordis 的 safeCollect 只认
// undefined 或清理函数，async apply（返回 Promise）或 return 一个对象都会判成
// `TypeError: Invalid effect`，整个 entry 不激活（2026-11-04 线上就是这个问题）。
测('apply 是同步函数（不是 async）', () => {
  assert.notEqual(apply.constructor.name, 'AsyncFunction', 'apply 被写成了 async')
})
const 句柄 = apply(ctx, { 开: true, 看日志: true, 跟随QQ绑定: true })
测('apply 不返回值（不能让 cordis 判成 Invalid effect）', () => {
  assert.equal(句柄, undefined)
})
测('apply 挂了 ctx.effect 做清理', () => assert.equal(effect次数, 1))
// 启动巡检是「发出去就不等」的，给它一拍时间跑完再清痕迹。
await new Promise((r) => setTimeout(r, 60))
测('启动巡检把绑定会话都叫过一遍', () => {
  assert.deepEqual([...记录].sort(), [私聊, 群].sort())
})
// 启动巡检已经把两间会话都叫活过一次；把痕迹清掉，后面只测「扫日志」这一条链。
记录.length = 0
活着的.clear()
__internals.state.recent.clear()
__internals.state.handles.clear()

测('起后会报「已起（看日志）」', () => {
  assert.ok(日志.some((s) => s.includes('已起（看日志）')))
})
测('历史错误行没被回放（记录仍空）', () => assert.equal(记录.length, 0))
测('盯的文件包含 desktop-next.log', () => {
  const st = 状态()
  assert.ok(st.盯的文件.some((f) => f.endsWith('desktop-next.log')))
})

// 等 watcher 就位
await new Promise((r) => setTimeout(r, 120))

console.log('事件：')
appendFileSync(logFile, '2026-11-03T12:24:02.887Z [info] qq-bridge: 这条先没转进去（6ad2bd2b：那间会话现在没活着（6ad2bd2b），先把它打开），下一跳再试\n', 'utf8')
await new Promise((r) => setTimeout(r, 400))

测('群会话被唤醒且用的是完整 id', () => {
  assert.deepEqual(记录, [群])
})

// 冷却：同一间再点一次，不该重复 resume
appendFileSync(logFile, '2026-11-03T12:24:04.891Z [info] qq-bridge: 这条先没转进去（6ad2bd2b：那间会话现在没活着（6ad2bd2b），先把它打开），下一跳再试\n', 'utf8')
await new Promise((r) => setTimeout(r, 400))
测('冷却期内不重复唤醒', () => assert.equal(记录.length, 1))

// 半行写入：先写半截，再补齐，整行才生效
appendFileSync(logFile, '2026-11-03T12:24:06.926Z [info] qq-bridge: 这条先没转进去（ff1818ac：那间会话现在没活着（ff18', 'utf8')
await new Promise((r) => setTimeout(r, 300))
测('半行不触发', () => assert.equal(记录.length, 1))
appendFileSync(logFile, '18ac），先把它打开），下一跳再试\n', 'utf8')
await new Promise((r) => setTimeout(r, 400))
测('补齐后触发私聊唤醒', () => assert.deepEqual(记录, [群, 私聊]))

// 已经活着的会话：不重复 resume
appendFileSync(logFile, '2026-11-03T12:24:08.900Z [info] qq-bridge: 这条先没转进去（ff1818ac：那间会话现在没活着（ff1818ac），先把它打开），下一跳再试\n', 'utf8')
await new Promise((r) => setTimeout(r, 400))
测('活着的会话不再 resume', () => assert.equal(记录.length, 2))

测('状态统计有看到次数', () => assert.ok(状态().看到次数 >= 3))

// ── 0.3.0：面板那半边用到的东西（配置归一 / 存取 / 测一下 / 路由前缀） ─────────
console.log('面板：')

测('版本跟 package.json 对得上', () => {
  const 包 = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(状态().版本, 包.version)
})
测('路由前缀对得上', () => assert.equal(ROUTE, '/dsh-qq-wake'))

测('归一把数字夹紧', () => {
  const a = 归一({ 冷却秒: 9999, 兜底秒: -5 })
  assert.equal(a.冷却秒, 600)
  assert.equal(a.兜底秒, 0)
  const b = 归一({ 冷却秒: 'abc' })
  assert.equal(b.冷却秒, 10) // 认不出就用默认
})

测('归一会话：去空白、去空、去重', () => {
  const a = 归一({ 会话: [' ' + 私聊 + ' ', 私聊, '', '   ', 群] })
  assert.deepEqual(a.会话, [私聊, 群])
})

测('归一认字符串/数字的 false', () => {
  assert.equal(归一({ 开: 'false' }).开, false)
  assert.equal(归一({ 开: 0 }).开, false)
  assert.equal(归一({ 看日志: '0' }).看日志, false)
  assert.equal(归一({ 开: true }).开, true)
  assert.equal(归一({ 开: undefined }).开, true) // 没给就用默认
})

测('配置落在 DSH_HOME 里', () => assert.equal(配置路径(), path.join(tmp, 'dsh-qq-wake.json')))

测('存一份再读回来一致', () => {
  const r = 存配置({ 开: true, 冷却秒: 7, 兜底秒: 30, 会话: [群] })
  assert.equal(r.ok, true)
  const b = 读配置()
  assert.equal(b.冷却秒, 7)
  assert.equal(b.兜底秒, 30)
  assert.deepEqual(b.会话, [群])
  assert.equal(b.开, true)
})

测('存坏了也不抛：patch 只改给的那几个键', () => {
  const r = 存配置({ 看日志: false })
  assert.equal(r.ok, true)
  assert.equal(读配置().看日志, false)
  assert.equal(读配置().冷却秒, 7) // 上一轮存的还在
})

// 「测一下」用一个干净的假宿主，别污染上面的 记录/活着的
const 假活 = new Map()
const 假记 = []
const 假ctx = {
  agents: {
    get: (id) => 假活.get(id),
    resume: async ({ resumeSessionId }) => {
      假记.push(resumeSessionId)
      假活.set(resumeSessionId, { id: resumeSessionId })
      return { id: resumeSessionId }
    },
  },
  logger: () => {},
  effect: () => {},
}

const 测一 = await 测试(假ctx, 归一({ 跟随QQ绑定: false, 会话: [私聊, 群] }))
测('测一下：两间都睡着 → 两间都被叫醒', () => {
  assert.equal(测一.会话数, 2)
  assert.equal(测一.活着, 0)
  assert.equal(测一.唤醒成功, 2)
  assert.equal(测一.唤醒失败, 0)
  assert.equal(测一.ok, true)
  assert.equal(测一.明细.length, 2)
  assert.ok(测一.明细.every((x) => x.状态 === '已唤醒'))
  assert.deepEqual(假记, [私聊, 群])
})

const 测二 = await 测试(假ctx, 归一({ 跟随QQ绑定: false, 会话: [私聊, 群] }))
测('测一下：第二遍两间都活着 → 不再 resume', () => {
  assert.equal(测二.活着, 2)
  assert.equal(测二.唤醒成功, 0)
  assert.equal(假记.length, 2) // 没多出来
})

const 测三 = await 测试(假ctx, 归一({ 跟随QQ绑定: false, 会话: [] }))
测('测一下：一间都没配时给的是人话', () => {
  assert.equal(测三.会话数, 0)
  assert.equal(测三.ok, false)
  assert.ok(测三.说.includes('先在 dsh-qq-link 里绑一个'))
})

// ── 0.3.1：resume 必须带 provider/model，否则 agent 建起来也跑不了 ──────────
const 收到 = []
const 假ctx2 = {
  agents: {
    get: () => undefined,
    resume: async (opt) => {
      收到.push(opt)
      return { id: opt && opt.resumeSessionId }
    },
  },
  logger: () => {},
  effect: () => {},
}
await 测试(假ctx2, 归一({ 跟随QQ绑定: false, 会话: [群] }))

测('resume 会带上 agentOptions 的 provider/model', () => {
  assert.equal(收到.length, 1)
  assert.equal(收到[0].resumeSessionId, 群)
  assert.ok(收到[0].agentOptions, 'resume 必须带 agentOptions')
  assert.ok(收到[0].agentOptions.provider, 'provider 不能空')
  assert.ok(收到[0].agentOptions.model, 'model 不能空')
})

测('拼模型：读不到 profile 时退到硬默认', () => {
  const r = 拼模型({})
  assert.equal(r.provider, 'deepseek-account')
  assert.equal(r.model, 'deepseek-flash')
})

测('拼模型：手填优先，思考强度一起带', () => {
  const r = 拼模型({ provider: 'p1', model: 'm1', 思考强度: 'high' })
  assert.equal(r.provider, 'p1')
  assert.equal(r.model, 'm1')
  assert.equal(r.reasoningEffort, 'high')
})

测('拼模型：留空就不塞 reasoningEffort', () => {
  const r = 拼模型({ provider: 'p2', model: 'm2', 思考强度: '' })
  assert.equal(r.reasoningEffort, undefined)
})

测('读默认模型：tmp 里没有 patch 文件时回空', () => {
  const r = 读默认模型()
  assert.equal(r.provider, '')
  assert.equal(r.model, '')
})

测('状态里有最近唤醒列表', () => {
  const st = 状态()
  assert.ok(Array.isArray(st.最近唤醒))
  assert.ok(st.最近唤醒.every((x) => x && typeof x.来源 === 'string'))
})

测('归一后状态不再乱串：会话数跟配置走', () => {
  const st = 状态(归一({ 跟随QQ绑定: false, 会话: [群] }))
  assert.deepEqual(st.会话, [群])
})

if (typeof 句柄?.扫日志 === 'function') 测('暴露了 扫日志 入口', () => assert.ok(true))

console.log('\n模型与密钥：')

测('密钥加密后解回原样', () => {
  const 密 = 加密('sk-test-123')
  assert.ok(密.startsWith('v1:'))
  assert.equal(解密(密), 'sk-test-123')
})

测('密文里看不见明文', () => {
  const 密 = 加密('sk-very-secret-中文也行')
  assert.ok(!密.includes('sk-very-secret'))
  assert.equal(解密(密), 'sk-very-secret-中文也行')
})

测('解不开时回空串、不抛', () => {
  assert.equal(解密('v1:AAAA:BBBB:CCCC'), '')
  assert.equal(解密('乱七八糟'), '')
  assert.equal(解密(''), '')
  assert.equal(解密(null), '')
})

测('归一：明文密钥就地加密，配置里不留明文', () => {
  const 新 = 归一({ 密钥: 'sk-plain-xyz' })
  assert.ok(String(新.密钥密文).startsWith('v1:'))
  assert.ok(!JSON.stringify(新).includes('sk-plain-xyz'))
  assert.equal(解密(新.密钥密文), 'sk-plain-xyz')
})

测('归一：没送新密钥时密文不被抹掉（存配置走同一份）', () => {
  const 旧 = 归一({ 密钥: 'sk-keep-me' })
  const 合 = { ...旧, ...归一({ ...旧, 思考强度: 'high' }) }
  assert.equal(解密(合.密钥密文), 'sk-keep-me')
})

await (async () => {
  try {
    const 快照 = await llm快照({})
    assert.equal(快照.ok, false)
    assert.deepEqual(快照.providers, [])
    assert.ok(typeof 快照.说 === 'string' && 快照.说 !== '')
    pass += 1
    console.log('  [ok] llm快照：宿主没 llm 时老实回 ok:false')
  } catch (error) {
    fail += 1
    console.log(`  [FAIL] llm快照：宿主没 llm 时老实回 ok:false —— ${error && error.message ? error.message : error}`)
  }
})()

await (async () => {
  try {
    // 假宿主：两个 provider，一个有模型一个有强度
    const 假llm = {
      listProviders: () => ['alpha', 'beta'],
      listModels: async ({ provider }) =>
        provider === 'alpha'
          ? [{ id: 'a-1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }]
          : [],
    }
    const 快照 = await llm快照({ llm: 假llm })
    assert.equal(快照.ok, true)
    assert.equal(快照.providers.length, 2)
    assert.deepEqual(快照.providers[0].models[0].强度, ['low', 'high'])
    assert.deepEqual(快照.providers[1].models, [])
    pass += 1
    console.log('  [ok] llm快照：能列出 provider / 模型 / 思考强度')
  } catch (error) {
    fail += 1
    console.log(`  [FAIL] llm快照：能列出 provider / 模型 / 思考强度 —— ${error && error.message ? error.message : error}`)
  }
})()

try {
  rmSync(tmp, { recursive: true, force: true })
} catch {}

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail === 0 ? 0 : 1)
