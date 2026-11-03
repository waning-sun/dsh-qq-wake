// 一次性 smoke test：把 lib/client.js 塞进假 React 里渲染，确认不崩、该有的按钮和开关都在。
//
// 为什么要这一步：客户端组件只要有一个 hook 排在 return 后面，React 就会抛 #310，
// 而那个错在浏览器里只表现为「整个设置面板白屏」—— 日志里一个字都没有。
// 所以这里不联网、不碰真宿主，纯静态渲染一遍。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const code = readFileSync(SRC, 'utf8')

let states = []
let idx = 0
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity), __el: true }),
  useState: (init) => {
    const i = idx++
    if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
    return [
      states[i],
      (v) => {
        states[i] = typeof v === 'function' ? v(states[i]) : v
      },
    ]
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}

let factory = null
const 假态 = {
  ok: true,
  版本: '0.3.0',
  开: true,
  看日志: true,
  跟随QQ绑定: true,
  盯的目录: 'C:/Users/x/.dsh/logs',
  盯的文件: ['C:/Users/x/.dsh/logs/desktop-next.log'],
  冷却秒: 10,
  兜底秒: 0,
  会话: ['session-3294bd0b-6477-47ce-876c-e3a1ff1818ac', 'session-33e54525-eee5-4c92-b757-20ca6ad2bd2b'],
  看到次数: 3,
  唤醒成功: 2,
  唤醒失败: 1,
  最近一次: '2026-11-03T12:38:07.699Z',
  最近一句: '唤醒成功 20ca6ad2bd2b（日志）',
  最近唤醒: [{ at: '2026-11-03T12:38:07.699Z', 会话: 'session-33e54525-eee5-4c92-b757-20ca6ad2bd2b', 尾: '20ca6ad2bd2b', 来源: '日志' }],
  正在跑: false,
  模型: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  在跑: { 开: true, 看日志: true, 跟随QQ绑定: true, 会话: [], 冷却秒: 10, 兜底秒: 0 },
  配置: { 开: true, 看日志: true, 跟随QQ绑定: true, 会话: [], 冷却秒: 10, 兜底秒: 0 },
  文件: 'C:/Users/x/.dsh/dsh-qq-wake.json',
}
const 假测试 = {
  ok: true,
  说: '通了：1 间本来就活着，1 间被我叫醒',
  会话数: 2,
  活着: 1,
  唤醒成功: 1,
  唤醒失败: 0,
  明细: [
    { 会话: 'session-3294bd0b-6477-47ce-876c-e3a1ff1818ac', 尾: 'e3a1ff1818ac', 状态: '活着', 原因: '' },
    { 会话: 'session-33e54525-eee5-4c92-b757-20ca6ad2bd2b', 尾: '20ca6ad2bd2b', 状态: '已唤醒', 原因: '' },
  ],
}

const 假llm = {
  ok: true,
  说: '',
  providers: [
    { id: 'deepseek-account', models: [{ id: 'deepseek-flash', 名: 'deepseek-flash', 强度: ['low', 'high', 'max'] }] },
    { id: 'openai', models: [{ id: 'gpt-4o', 名: 'gpt-4o', 强度: [] }] },
  ],
  跟随DSH: { provider: 'deepseek-account', model: 'deepseek-flash', 思考强度: 'max' },
  现在用的: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
}

globalThis.window = {
  __ModuleLoader__: {
    load: (def) => {
      factory = def.factory
    },
  },
}
globalThis.fetch = (url) => {
  const p = String(url)
  const body = p.endsWith('/state')
    ? 假态
    : p.endsWith('/llm')
      ? 假llm
      : p.endsWith('/test')
        ? 假测试
        : p.endsWith('/save')
          ? { ok: true, 配置: 假态.配置, 状态: 假态 }
          : null
  return Promise.resolve({ json: () => Promise.resolve(body) })
}
new Function('window', 'fetch', code)(globalThis.window, globalThis.fetch)

const mod = factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

let Section = null
let 注册 = null
mod.apply({
  get: (k) =>
    k === 'slots'
      ? {
          inject: (n, fn) => fn(),
          register: (m, c) => {
            注册 = m
            Section = c
            return c
          },
        }
      : undefined,
})
if (!Section) throw new Error('Section 没拿到')

function render() {
  idx = 0
  return Section({})
}

function collect(tree) {
  const buttons = []
  const boxes = []
  const nums = []
  const areas = []
  const texts = []
  ;(function walk(n) {
    if (n === null || n === undefined || n === false) return
    if (typeof n === 'string' || typeof n === 'number') {
      texts.push(String(n))
      return
    }
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    if (n.__el) {
      if (n.type === 'button') buttons.push(n.children.filter((c) => typeof c === 'string').join(''))
      if (n.type === 'input' && n.props) {
        if (n.props.type === 'checkbox') boxes.push({ checked: Boolean(n.props.checked) })
        if (n.props.type === 'number') nums.push({ value: n.props.value })
      }
      if (n.type === 'textarea') areas.push({ value: String(n.props.value || '') })
      n.children.forEach(walk)
    }
  })(tree)
  return { buttons, boxes, nums, areas, text: texts.join(' ') }
}

let 过 = 0
let 挂 = 0
function 查(名, 条件) {
  if (条件) {
    过 += 1
    console.log(`  [ok] ${名}`)
  } else {
    挂 += 1
    console.log(`  [FAIL] ${名}`)
  }
}

// 第一遍：态还是 null → 只该渲染「正在读状态…」，不能炸
const 空 = collect(render())
查('没数据时不崩，给的是加载提示', 空.text.includes('正在读状态'))
查('没数据时没有按钮', 空.buttons.length === 0)

// 第二遍：塞进一份状态，走正式分支
states[0] = 假态
states[1] = { ...假态.配置 }
states[5] = 假llm // 第 6 个 useState 是 llm
const 满 = collect(render())
查('标题在', 满.text.includes('QQ 唤醒'))
查('说明在', 满.text.includes('那间会话现在没活着'))
查('三个开关都在', 满.boxes.length === 3)
查('三个开关都勾着', 满.boxes.every((b) => b.checked === true))
查('两个数字框（冷却/兜底）', 满.nums.length === 2)
查('会话 id 文本框在', 满.areas.length === 1)
查(
  '按钮：4 个选项卡 + 保存 / 测一下 / 刷新状态',
  满.buttons.length === 7 &&
    满.buttons[0] === 'DSH 设置' &&
    满.buttons.slice(1, 3).join(',') === 'deepseek-account,openai' &&
    满.buttons[3] === '自定义' &&
    满.buttons[4] === '保存' &&
    满.buttons[5].includes('测一下') &&
    满.buttons[6] === '刷新状态',
)
查('默认「DSH 设置」时不显示 URL / 密钥框', !满.text.includes('密钥 / cookie') && !满.text.includes('AES-256-GCM'))
查('默认显示现在生效的模型', 满.text.includes('deepseek-account / deepseek-flash · max'))
查('DSH 设置这一档也给了模型/思考强度控件', 满.text.includes('DSH 设置这一档') && 满.text.includes('用 profile 的'))
查('状态区显示成功/失败计数', 满.text.includes('叫醒成功 / 失败'))
查('绑了几间会话', 满.text.includes('2 间'))
查('最近叫醒列表也画了', 满.text.includes('最近叫醒的'))
查('挂到 settings.section 且 id 是 qq-wake', 注册 && 注册.name === 'settings.section' && 注册.id === 'qq-wake')

// 第三遍：关掉总开关 → 状态区该显示「关着的」
states[0] = { ...假态, 开: false, 在跑: { ...假态.在跑, 开: false } }
const 关 = collect(render())
查('关掉时显示『关着的』', 关.text.includes('关着的'))

// 第四遍：有测试结果时该把明细摊出来
states[4] = 假测试
const 结果 = collect(render())
查('测试结果说『通了』', 结果.text.includes('通了：1 间本来就活着，1 间被我叫醒'))

console.log(`\n${过} 过 / ${挂} 挂`)
process.exit(挂 === 0 ? 0 : 1)
