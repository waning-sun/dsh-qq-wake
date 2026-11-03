// dsh-qq-wake · 网页半边
//
// 在 **设置 → QQ 唤醒** 里：开/关、改几个参数、点一下「测一下」看它到底有没有用。
// 这里不碰会话、不碰日志 —— 只往宿主那三条 /dsh-qq-wake/* 路由上读写。
//
// 「测一下」做的事：把每间绑定的会话查一遍（活着？睡着？），睡着的那几间真的
// resume 一次，然后把明细摆出来。所以它既是自检，也是一次真实的唤醒。

window.__ModuleLoader__.load({
  id: 'dsh-qq-wake',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']

    const B = '/dsh-qq-wake'
    const get = (p) =>
      fetch(B + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    const h = React.createElement

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, lineHeight: 1.65 },
      card: { border: '1px solid rgba(128,128,128,.28)', borderRadius: 10, padding: '12px 14px' },
      h: { fontSize: 13.5, fontWeight: 600, marginBottom: 6, letterSpacing: '.01em' },
      hint: { opacity: 0.66, fontSize: 12, lineHeight: 1.6 },
      row: { display: 'flex', alignItems: 'center', gap: 10, margin: '7px 0', flexWrap: 'wrap' },
      lab: { width: 132, flex: '0 0 auto', opacity: 0.84 },
      input: {
        flex: '1 1 200px',
        minWidth: 0,
        padding: '5px 8px',
        border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 7,
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        fontFamily: 'inherit',
      },
      area: {
        width: '100%',
        minHeight: 62,
        padding: '6px 8px',
        border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 7,
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        fontFamily: 'ui-monospace,Consolas,monospace',
        resize: 'vertical',
      },
      btn: {
        padding: '6px 14px',
        border: '1px solid rgba(128,128,128,.4)',
        borderRadius: 8,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 13,
        fontFamily: 'inherit',
      },
      btnOn: { borderColor: '#41d392', color: '#41d392' },
      ok: { color: '#41d392' },
      bad: { color: '#f0705f' },
      warn: { color: '#f5c451' },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 14px', fontSize: 12.5 },
      k: { opacity: 0.62 },
      mono: { fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 12 },
      log: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        fontFamily: 'ui-monospace,Consolas,monospace',
        fontSize: 11.5,
        opacity: 0.78,
        maxHeight: 180,
        overflow: 'auto',
      },
      tag: {
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid currentColor',
        fontSize: 11.5,
        lineHeight: 1.5,
      },
      tabs: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0 4px' },
      tab: {
        padding: '4px 11px',
        border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 999,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12.5,
        fontFamily: 'inherit',
      },
      tabOn: {
        padding: '4px 11px',
        border: '1px solid #41d392',
        borderRadius: 999,
        background: 'rgba(65,211,146,.12)',
        color: '#41d392',
        cursor: 'pointer',
        fontSize: 12.5,
        fontFamily: 'inherit',
      },
      select: {
        flex: '1 1 200px',
        minWidth: 0,
        padding: '5px 8px',
        border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 7,
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        fontFamily: 'inherit',
      },
    }

    function 开关(props) {
      return h(
        'label',
        { style: { ...S.row, cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: props.值 === true,
          onChange: (e) => props.改(e.target.checked),
          style: { width: 15, height: 15, cursor: 'pointer' },
        }),
        h('span', null, props.名字),
        props.说明 ? h('span', { style: S.hint }, props.说明) : null,
      )
    }

    function 数字(props) {
      return h(
        'div',
        { style: S.row },
        h('span', { style: S.lab }, props.名字),
        h('input', {
          type: 'number',
          value: props.值 === undefined || props.值 === null ? '' : props.值,
          min: props.最小,
          max: props.最大,
          step: 1,
          onChange: (e) => props.改(e.target.value === '' ? 0 : Number(e.target.value)),
          style: { ...S.input, flex: '0 0 96px' },
        }),
        props.说明 ? h('span', { style: S.hint }, props.说明) : null,
      )
    }

    function 选(props) {
      const 们 = Array.isArray(props.选项) ? props.选项 : []
      return h(
        'div',
        { style: S.row },
        h('span', { style: S.lab }, props.名字),
        h(
          'select',
          {
            value: props.值 === undefined || props.值 === null ? '' : String(props.值),
            onChange: (e) => props.改(e.target.value),
            disabled: props.禁用 === true,
            style: { ...S.select, opacity: props.禁用 === true ? 0.5 : 1 },
          },
          props.允许空 ? h('option', { value: '' }, props.空文案 || '（不指定）') : null,
          们.map((o) => h('option', { value: o, key: o }, o)),
        ),
        props.说明 ? h('span', { style: S.hint }, props.说明) : null,
      )
    }

    function 文本(props) {
      return h(
        'div',
        { style: S.row },
        h('span', { style: S.lab }, props.名字),
        h('input', {
          type: 'text',
          value: props.值 === undefined || props.值 === null ? '' : String(props.值),
          onChange: (e) => props.改(e.target.value),
          placeholder: props.占位 || '',
          spellCheck: false,
          style: S.input,
        }),
        props.说明 ? h('span', { style: S.hint }, props.说明) : null,
      )
    }

    function Section() {
      // ⚠ 所有 hook 都必须排在下面任何一个 return 之前（否则 React #310，整个设置面板白屏）
      const [态, set态] = React.useState(null)
      const [表单, set表单] = React.useState(null)
      const [忙, set忙] = React.useState('')
      const [提示, set提示] = React.useState('')
      const [结果, set结果] = React.useState(null)
      const [llm, setLlm] = React.useState(null)

      const 拉 = React.useCallback(async () => {
        const [s, l] = await Promise.all([get('/state'), get('/llm')])
        if (s) {
          set态(s)
          set表单((旧) => 旧 || s.配置 || null)
        }
        if (l) setLlm(l)
      }, [])

      React.useEffect(() => {
        拉()
        const t = setInterval(拉, 5000)
        return () => clearInterval(t)
      }, [拉])

      const 改 = (k, v) => set表单((旧) => ({ ...(旧 || {}), [k]: v }))

      const 保存 = async () => {
        set忙('保存')
        set提示('')
        const r = await post('/save', 表单 || {})
        if (r && r.ok) {
          set提示('存好了，新的参数已经生效。')
          if (r.配置) set表单(r.配置)
          if (r.状态) set态(r.状态)
          await 拉()
        } else {
          set提示(`没存上：${(r && r.说) || '宿主没回话'}`)
        }
        set忙('')
      }

      const 测 = async () => {
        set忙('测试')
        set提示('')
        set结果(null)
        const r = await post('/test', {})
        set结果(r || { ok: false, 说: '宿主没回话' })
        set忙('')
      }

      const 刷新 = async () => {
        set忙('刷新')
        await 拉()
        set忙('')
      }

      if (态 === null || 表单 === null) {
        return h('div', { style: S.wrap }, h('div', { style: S.hint }, '正在读状态…（读不到就是插件没在跑）'))
      }

      const 在跑 = 态.在跑 || 表单
      const 会话 = Array.isArray(态.会话) ? 态.会话 : []
      const 最近 = Array.isArray(态.最近唤醒) ? 态.最近唤醒 : []
      const 盯文件 = Array.isArray(态.盯的文件) ? 态.盯的文件 : []

      const providers = llm && Array.isArray(llm.providers) ? llm.providers : []
      const 跟DSH = 表单.自定义 !== true
      const 选中 = providers.find((p) => p.id === 表单.provider) || null
      const 模型们 = 选中 && Array.isArray(选中.models) ? 选中.models.map((m) => m.id) : []
      const 选中模型 = 选中 && Array.isArray(选中.models) ? 选中.models.find((m) => m.id === 表单.model) : null
      const 强度们 = 选中模型 && Array.isArray(选中模型.强度) ? 选中模型.强度 : []
      const DSH模型 =
        llm && llm.跟随DSH && llm.跟随DSH.provider
          ? `${llm.跟随DSH.provider} / ${llm.跟随DSH.model}${llm.跟随DSH.思考强度 ? ' · ' + llm.跟随DSH.思考强度 : ''}`
          : 'profile 里没读到 agent-default-model'
      const 选个provider = (p) => set表单((旧) => ({ ...(旧 || {}), 自定义: true, provider: p, model: '', 思考强度: '' }))

      // 「DSH 设置」那一档：provider 由 profile 定，但模型和思考强度也能在这挑
      const DSH盘 = (llm && llm.跟随DSH) || {}
      const DSH名 = String(DSH盘.provider || '')
      const DSH默认模型 = String(DSH盘.model || '')
      const DSH默认强度 = String(DSH盘.思考强度 || '')
      const DSH选中 = providers.find((p) => p.id === DSH名) || null
      const DSH模型们 = DSH选中 ? DSH选中.models.map((m) => m.id) : []
      const DSH这模型id = 表单.model || DSH默认模型
      const DSH这模型 = DSH选中 ? DSH选中.models.find((m) => m.id === DSH这模型id) || null : null
      const DSH强度们 = DSH这模型 ? DSH这模型.强度 : []
      const 现在生效 = 态.模型
        ? `${态.模型.provider} / ${态.模型.model}${态.模型.reasoningEffort ? ' · ' + 态.模型.reasoningEffort : ''}`
        : '—'

      return h(
        'div',
        { style: S.wrap },

        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, 'QQ 唤醒 · 让睡着的会话一叫就醒'),
          h(
            'div',
            { style: S.hint },
            'dsh-qq-link 落地 QQ 消息前只会找「已经活着的会话」，找不到就每 2 秒重试、往运行日志里写一行「那间会话现在没活着」。',
            '这个插件盯的就是那行字：一出现就站起来叫醒它，所以 QQ 消息不用等你把会话点开。平常它一个定时器都不跑。',
          ),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, '现在的样子'),
          h(
            'div',
            { style: S.kv },
            h('span', { style: S.k }, '总开关'),
            h('span', { style: 在跑.开 ? S.ok : S.bad }, 在跑.开 ? '开着的' : '关着的'),
            h('span', { style: S.k }, '盯日志'),
            h('span', { style: 在跑.看日志 ? S.ok : S.bad }, 在跑.看日志 ? '在盯' : '没盯'),
            h('span', { style: S.k }, '绑了几间会话'),
            h('span', null, `${会话.length} 间`),
            h('span', { style: S.k }, '看到几次'),
            h('span', null, String(态.看到次数 || 0)),
            h('span', { style: S.k }, '叫醒成功 / 失败'),
            h(
              'span',
              null,
              h('span', { style: S.ok }, String(态.唤醒成功 || 0)),
              ' / ',
              h('span', { style: 态.唤醒失败 ? S.bad : S.k }, String(态.唤醒失败 || 0)),
            ),
            h('span', { style: S.k }, '最近一次动手'),
            h('span', null, 态.最近一次 ? 态.最近一次 : '还没动过'),
            h('span', { style: S.k }, '最近一句'),
            h('span', { style: S.mono }, 态.最近一句 || '—'),
            h('span', { style: S.k }, '叫醒用的模型'),
            h(
              'span',
              { style: S.mono },
              态.模型
                ? `${态.模型.provider}/${态.模型.model}${态.模型.reasoningEffort ? ' · ' + 态.模型.reasoningEffort : ''}`
                : '—',
            ),
          ),
          会话.length > 0
            ? h(
                'div',
                { style: { marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                会话.map((id) =>
                  h('span', { key: id, style: { ...S.tag, ...S.mono, opacity: 0.8 } }, String(id).slice(-8)),
                ),
              )
            : h('div', { style: { ...S.hint, marginTop: 8 } }, '现在一间会话都没绑 —— 下面可以手填，或者在 dsh-qq-link 里绑一个。'),
          盯文件.length > 0
            ? h('div', { style: { ...S.hint, marginTop: 6 } }, `盯的文件：${盯文件.join('、')}`)
            : h('div', { style: { ...S.hint, marginTop: 6 } }, `盯的目录：${态.盯的目录 || '（没起来）'}`),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, '怎么活'),
          开关({ 名字: '总开关', 值: 表单.开, 改: (v) => 改('开', v), 说明: '关掉就彻底不管，日志里那句话也不会被理' }),
          开关({ 名字: '盯运行日志', 值: 表单.看日志, 改: (v) => 改('看日志', v), 说明: '唯一的触发源；关掉基本等于停用' }),
          开关({ 名字: '跟着 QQ 绑定走', 值: 表单.跟随QQ绑定, 改: (v) => 改('跟随QQ绑定', v), 说明: '从 dsh-qq-link 的配置里读绑了哪几间' }),
          数字({ 名字: '同一间冷却（秒）', 值: 表单.冷却秒, 改: (v) => 改('冷却秒', v), 最小: 0, 最大: 600, 说明: '防日志每 2 秒一条把叫醒刷成风暴' }),
          数字({ 名字: '兜底巡检（秒）', 值: 表单.兜底秒, 改: (v) => 改('兜底秒', v), 最小: 0, 最大: 3600, 说明: '0 = 不巡检（推荐）；填了才会挂一个很慢的定时器' }),
          h(
            'div',
            { style: { ...S.hint, marginTop: 12 } },
            '叫醒时用哪个模型 —— 先挑一家，模型和思考强度会跟着列出来。选「DSH 设置」就用 DSH 自己那套（也能在下面改模型和思考强度），其余要自己填端点和密钥。',
          ),
          h(
            'div',
            { style: S.tabs },
            h(
              'button',
              { style: 跟DSH ? S.tabOn : S.tab, onClick: () => set表单((旧) => ({ ...(旧 || {}), 自定义: false })) },
              'DSH 设置',
            ),
            providers.map((p) =>
              h(
                'button',
                { key: p.id, style: !跟DSH && 表单.provider === p.id ? S.tabOn : S.tab, onClick: () => 选个provider(p.id) },
                p.id,
              ),
            ),
            h(
              'button',
              { style: !跟DSH ? S.tabOn : S.tab, onClick: () => set表单((旧) => ({ ...(旧 || {}), 自定义: true })) },
              '自定义',
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.lab }, '现在生效的'),
            h('span', { style: S.mono }, 现在生效),
          ),
          跟DSH
            ? h(
                'div',
                { style: S.hint },
                `DSH 设置这一档，provider 由 profile 的 agent-default-model 定（现在是 ${DSH名 || '没读到'}）；下面挑的模型和思考强度会盖在它上面。`,
              )
            : null,
          !跟DSH && providers.length === 0
            ? h(
                'div',
                { style: S.hint },
                llm && llm.说 ? `宿主那侧：${llm.说}` : '宿主没报出 provider 列表，这家只能自己填 provider 名。',
              )
            : null,
          !跟DSH && 表单.provider && !providers.some((p) => p.id === 表单.provider)
            ? h(
                'div',
                { style: { ...S.hint, color: '#f5c451' } },
                `「${表单.provider}」这个名字宿主现在不认识。要让它真的能叫起来，得在 profile 的 cordis.patch.yml 里挂 @deepseek-ai/dsh-llm-pi-ai 的 providers（baseURL + apiKeyEnv），重启一次 DSH；这里填的 URL 和密钥是给那一步用的账。`,
              )
            : null,
          跟DSH && DSH模型们.length > 0
            ? 选({
                名字: '模型',
                值: 表单.model,
                选项: DSH模型们,
                改: (v) => 改('model', v),
                允许空: true,
                空文案: `（用 profile 的：${DSH默认模型 || '默认'}）`,
              })
            : 跟DSH
              ? 文本({
                  名字: '模型',
                  值: 表单.model,
                  改: (v) => 改('model', v),
                  占位: DSH默认模型 || 'deepseek-flash',
                  说明: '宿主没报模型列表，手填 id 也行',
                })
              : null,
          跟DSH && DSH强度们.length > 0
            ? 选({
                名字: '思考强度',
                值: 表单.思考强度,
                选项: DSH强度们,
                改: (v) => 改('思考强度', v),
                允许空: true,
                空文案: `（用 profile 的：${DSH默认强度 || '默认'}）`,
              })
            : 跟DSH
              ? 文本({
                  名字: '思考强度',
                  值: 表单.思考强度,
                  改: (v) => 改('思考强度', v),
                  占位: DSH默认强度 || 'high / max',
                  说明: '留空就用 profile 的',
                })
              : null,
          !跟DSH && 模型们.length > 0
            ? 选({
                名字: '模型',
                值: 表单.model,
                选项: 模型们,
                改: (v) => 改('model', v),
                允许空: true,
                空文案: '（用这家的默认）',
              })
            : !跟DSH
              ? 文本({ 名字: 'provider', 值: 表单.provider, 改: (v) => 改('provider', v), 占位: 'route 名，比如 openai' })
              : null,
          !跟DSH && 模型们.length === 0
            ? 文本({ 名字: 'model', 值: 表单.model, 改: (v) => 改('model', v), 占位: '模型 id' })
            : null,
          !跟DSH && 强度们.length > 0
            ? 选({
                名字: '思考强度',
                值: 表单.思考强度,
                选项: 强度们,
                改: (v) => 改('思考强度', v),
                允许空: true,
                空文案: '（不传，用模型默认）',
              })
            : !跟DSH
              ? 文本({ 名字: '思考强度', 值: 表单.思考强度, 改: (v) => 改('思考强度', v), 占位: 'high / max（留空不传）' })
              : null,
          !跟DSH
            ? 文本({
                名字: 'URL',
                值: 表单.providerURL,
                改: (v) => 改('providerURL', v),
                占位: 'https://api.example.com/v1',
                说明: '这家的端点',
              })
            : null,
          !跟DSH
            ? h(
                'div',
                { style: S.row },
                h('span', { style: S.lab }, '密钥 / cookie'),
                h('input', {
                  type: 'password',
                  value: 表单.密钥 || '',
                  onChange: (e) => 改('密钥', e.target.value),
                  placeholder: 表单.密钥已设 ? '已经存过了（留空 = 不改）' : '粘 key 或 cookie',
                  spellCheck: false,
                  autoComplete: 'off',
                  style: S.input,
                }),
                h('span', { style: S.hint }, 'AES-256-GCM 加密后才落盘，宿主只回「设没设」，明文不回前端'),
              )
            : null,
          h('div', { style: { marginTop: 4 } }, h('span', { style: S.lab }, '额外会话 id'),
            h('div', { style: S.hint }, '一行一个，写完整 id（session-xxxx）。绑不定的时候拿来兜底。')),
          h('textarea', {
            value: Array.isArray(表单.会话) ? 表单.会话.join('\n') : '',
            onChange: (e) => 改('会话', e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)),
            style: S.area,
            placeholder: 'session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
            spellCheck: false,
          }),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.h }, '动手'),
          h(
            'div',
            { style: S.row },
            h(
              'button',
              { style: { ...S.btn, ...S.btnOn }, onClick: 保存, disabled: 忙 !== '' },
              忙 === '保存' ? '存…' : '保存',
            ),
            h('button', { style: S.btn, onClick: 测, disabled: 忙 !== '' }, 忙 === '测试' ? '测…' : '测一下（真叫醒一次）'),
            h('button', { style: S.btn, onClick: 刷新, disabled: 忙 !== '' }, 忙 === '刷新' ? '刷…' : '刷新状态'),
            提示 ? h('span', { style: { ...S.hint, ...(提示.startsWith('存好了') ? S.ok : S.warn) } }, 提示) : null,
          ),
          h(
            'div',
            { style: { ...S.hint, marginTop: 2 } },
            '「测一下」会把每间会话挨个查一遍：活着的只报告，睡着的那几间真的 resume 起来 —— 所以测完能直接看到它到底有没有用。',
          ),
          结果
            ? h(
                'div',
                { style: { marginTop: 10 } },
                h('div', { style: { ...S.h, ...(结果.ok ? S.ok : S.bad) } }, 结果.说 || (结果.ok ? '通了' : '没通')),
                h(
                  'div',
                  { style: S.kv },
                  h('span', { style: S.k }, '会话数'),
                  h('span', null, String(结果.会话数 || 0)),
                  h('span', { style: S.k }, '本来活着'),
                  h('span', { style: S.ok }, String(结果.活着 || 0)),
                  h('span', { style: S.k }, '被叫醒'),
                  h('span', { style: S.warn }, String(结果.唤醒成功 || 0)),
                  h('span', { style: S.k }, '叫不醒'),
                  h('span', { style: 结果.唤醒失败 ? S.bad : S.k }, String(结果.唤醒失败 || 0)),
                ),
                (结果.明细 || []).length > 0
                  ? h(
                      'div',
                      { style: { ...S.log, marginTop: 6 } },
                      (结果.明细 || [])
                        .map(
                          (x) =>
                            `${x.尾 || x.会话}  ${x.状态}${x.原因 ? `   ← ${x.原因}` : ''}\n${x.会话}`,
                        )
                        .join('\n'),
                    )
                  : null,
              )
            : null,
        ),

        最近.length > 0
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.h }, '最近叫醒的（最多 10 条）'),
              h(
                'div',
                { style: S.log },
                最近.map((x) => `${x.at}  ${x.尾 || x.会话}  ← ${x.来源}`).join('\n'),
              ),
            )
          : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'qq-wake', order: 54, label: () => 'QQ 唤醒' },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
