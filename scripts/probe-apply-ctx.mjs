// 复现 dsh-market 的 host apply 审计：拿一份「没声明 inject 的 ctx」去调 apply()，
// 看插件会不会把 `cannot get property "X" without inject` 抛出来（抛了整行判红：
// apply() throws when a service it never declared is read）。
//
// 用法（默认体检本插件）：
//   node scripts/probe-apply-ctx.mjs
//   node scripts/probe-apply-ctx.mjs ../别的插件/lib/index.js
//
// 退出码：0 = 没抛；1 = 抛了（该修代码，别去改 inject 糊过去）。
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const CORE = new Set([
  'effect', 'on', 'off', 'once', 'get', 'set', 'provide', 'inject', 'isolate',
  'emit', 'parallel', 'waterfall', 'bail', 'serial', 'logger', 'log', 'emit_sync',
  'runtime', 'root', 'scope', 'fiber', 'plugin', 'accessor', 'registry', 'reflect',
  'extend', 'intersect', 'name', 'config', 'baseDir', 'dispose', 'start', 'stop',
  'then', 'toJSON', 'inspect', 'constructor',
])

function 探针ctx() {
  const banned = []
  const handler = {
    get(_t, key) {
      if (typeof key === 'symbol') return undefined
      if (CORE.has(key)) {
        return (...args) => (key === 'get' ? null : undefined)
      }
      banned.push(key)
      throw new Error(`cannot get property "${key}" without inject`)
    },
    has() {
      return true
    },
  }
  return { ctx: new Proxy({}, handler), banned }
}

const target = process.argv[2] || './lib/index.js'
const abs = path.resolve(target)
const mod = await import(pathToFileURL(abs).href)
const { ctx, banned } = 探针ctx()
const apply = mod.apply || (mod.default && mod.default.apply)

console.log(`host apply 审计：${abs}`)
if (typeof apply !== 'function') {
  console.log('  ✗ 没有导出 apply()')
  process.exit(1)
}
console.log(`  inject 声明：${JSON.stringify(mod.inject || null)}`)

let threw = null
try {
  const r = apply(ctx, undefined)
  // apply 必须是同步起作用的；万一有人又写成 async，这里等它落地再判
  if (r && typeof r.then === 'function') await Promise.resolve(r).catch(() => {})
} catch (e) {
  threw = e
}

if (banned.length) console.log(`  摸过的服务：${[...new Set(banned)].join(', ')}`)
if (threw) {
  console.log(`  ✗ apply 抛了：${threw.message}`)
  process.exit(1)
}
console.log('  ✓ 没有 inject 的 ctx 下 apply 不抛（市场那行能过）')
process.exit(0)
