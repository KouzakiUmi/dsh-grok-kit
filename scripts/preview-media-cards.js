/* Development-only browser preview. Set __GROK_MEDIA_PREVIEW_INPUTS__ before running.
 * Uses the built client and workspace React 18; never installs/replaces host modules.
 * Session writes are stubbed. Video reads use the existing done task's safe route.
 */
(async () => {
  const input = window.__GROK_MEDIA_PREVIEW_INPUTS__
  if (!input?.workspace || !input?.imagePath || !input?.task) throw new Error('Preview inputs missing')
  const old = window.__GROK_MEDIA_PREVIEW__
  old?.close()
  const fileUrl = path => '/api/file?path=' + encodeURIComponent(path)
  const textFile = async path => {
    const r = await fetch(fileUrl(path), { cache: 'no-store' })
    if (!r.ok) throw new Error('Preview asset HTTP ' + r.status)
    return r.text()
  }
  const workspacePath = suffix => input.workspace.replace(/[\\/]$/, '') + '/' + suffix
  const originalReact = window.React
  const originalDom = window.ReactDOM
  let React, ReactDOM
  try {
    new Function(await textFile(workspacePath('node_modules/react/umd/react.production.min.js')))()
    new Function(await textFile(workspacePath('node_modules/react-dom/umd/react-dom.production.min.js')))()
    React = window.React
    ReactDOM = window.ReactDOM
  } finally {
    if (originalReact === undefined) delete window.React
    else window.React = originalReact
    if (originalDom === undefined) delete window.ReactDOM
    else window.ReactDOM = originalDom
  }
  if (React?.version !== '18.3.1') throw new Error('Unexpected preview React version')
  const runtime = { exports: {} }
  new Function('require', 'module', 'exports', 'process', await textFile(workspacePath('node_modules/react/cjs/react-jsx-runtime.production.min.js')))(name => {
    if (name === 'react') return React
    throw new Error('Unexpected JSX dependency: ' + name)
  }, runtime, runtime.exports, { env: { NODE_ENV: 'production' } })
  const client = { exports: {} }
  new Function('require', 'module', 'exports', await textFile(workspacePath('lib/client.cjs')))(name => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return runtime.exports
    throw new Error('Unexpected client dependency: ' + name)
  }, client, client.exports)
  const registrations = []
  const copies = {}
  let language = 'zh'
  const translate = key => copies[language]?.[key] ?? copies.en?.[key] ?? key
  let imageBytes
  const sessions = { binding: () => ({ session: {
    async readAttachment(id) {
      if (id !== input.image.attachmentId) return { ok: false }
      imageBytes ??= fetch(fileUrl(input.imagePath)).then(async r => {
        if (!r.ok) throw new Error('Preview image HTTP ' + r.status)
        return new Uint8Array(await r.arrayBuffer())
      })
      return { ok: true, value: { attachment: input.image, data: await imageBytes } }
    },
    async prompt() { return { ok: false } },
    async cancel() { return { ok: true } },
  } }) }
  const context = {
    sessions,
    locale: {
      register(_namespace, definitions) { Object.assign(copies, definitions); return () => {} },
      bind() { return translate },
    },
    effect(setup, label) { return label === 'dsh-grok-kit: settings copy' ? setup() : undefined },
    inject(_deps, setup) { setup(context) },
    slots: {
      inject(_name, setup) { setup() },
      entries() { return [] },
      register(spec, component) { registrations.push({ spec, component }); return () => {} },
    },
  }
  client.exports.apply(context)
  const view = key => {
    const entry = registrations.find(x => x.spec.name === 'tool.call.toolview' && x.spec.key === key)
    if (!entry) throw new Error('Missing card registration: ' + key)
    return entry.component
  }
  const overlay = document.createElement('aside')
  overlay.dataset.grokMediaPreview = 'true'
  Object.assign(overlay.style, { position: 'fixed', zIndex: '100000', top: '12px', right: '12px', bottom: '12px', width: 'min(820px, calc(100vw - 24px))', overflow: 'auto', padding: '18px', boxSizing: 'border-box', borderRadius: '16px', background: 'var(--dsw-alias-bg-base, #f4f4f5)', color: 'var(--dsw-alias-label-primary, #18181b)', boxShadow: '0 12px 40px #0004' })
  const themeSource = document.querySelector('button[aria-label="设置"]') ?? document.body
  const theme = getComputedStyle(themeSource)
  for (const name of ['--dsw-alias-bg-base', '--dsw-alias-bg-module-platform', '--dsw-alias-bg-secondary', '--dsw-alias-border-l2', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary']) {
    const value = theme.getPropertyValue(name)
    if (value.trim()) overlay.style.setProperty(name, value)
  }
  document.body.append(overlay)
  const toolbar = document.createElement('nav')
  Object.assign(toolbar.style, { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '16px', font: 'inherit', fontSize: '12px' })
  const label = document.createElement('strong')
  label.textContent = '工作区卡片预览 · 不更新生产插件'
  toolbar.append(label)
  overlay.append(toolbar)
  const target = document.createElement('div')
  Object.assign(target.style, { display: 'grid', gap: '16px' })
  overlay.append(target)
  const root = ReactDOM.createRoot(target)
  let scenario = 'done'
  const block = (name, args, content, meta) => ({ kind: 'tool-call', phase: 'end', call: { name, argsRaw: JSON.stringify(args) }, content, ...(meta ? { meta } : {}) })
  function render() {
    const common = { sessionId: 'media-card-preview', sessions, t: translate }
    const task = { ...input.task, ...(scenario === 'done' ? {} : { state: scenario, attachment: undefined, error: scenario === 'failed' ? 'Synthetic validation failure' : undefined }) }
    const imageBlock = scenario === 'done'
      ? block('grok_imagine', { prompt: 'A teal toy robot in a clean studio.' }, [{ type: 'image', attachment: input.image }, { type: 'image', attachment: input.image }])
      : scenario === 'failed'
        ? { ...block('grok_imagine', { prompt: 'A teal toy robot.' }, [{ type: 'text', text: 'Synthetic validation failure' }]), isError: true }
        : { phase: 'start', call: { name: 'grok_imagine', argsRaw: JSON.stringify({ prompt: 'A teal toy robot.' }) } }
    const videoBlock = block('grok_video_status', {}, scenario === 'done' ? [{ type: 'file', attachment: input.task.attachment }] : [], task)
    root.render(React.createElement(React.Fragment, null,
      React.createElement(view('grok_imagine'), { ...common, block: imageBlock }),
      React.createElement(view('grok_video_status'), { ...common, block: videoBlock }),
    ))
  }
  const hiddenBackground = []
  const restoreBackground = () => {
    for (const item of hiddenBackground.splice(0)) {
      item.element.style.visibility = item.visibility
      if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden')
      else item.element.setAttribute('aria-hidden', item.ariaHidden)
    }
  }
  const hideBackground = () => {
    if (hiddenBackground.length) return
    overlay.tabIndex = -1
    overlay.focus()
    for (const element of document.body.children) {
      if (element === overlay || !(element instanceof HTMLElement)) continue
      hiddenBackground.push({ element, visibility: element.style.visibility, ariaHidden: element.getAttribute('aria-hidden') })
      element.style.visibility = 'hidden'
      element.setAttribute('aria-hidden', 'true')
    }
  }
  const close = () => { root.unmount(); overlay.remove(); restoreBackground(); delete window.__GROK_MEDIA_PREVIEW__ }
  const button = (text, action) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    Object.assign(b.style, { font: 'inherit', cursor: 'pointer', padding: '5px 9px', border: '1px solid var(--dsw-alias-border-l2, #ccc)', borderRadius: '6px', color: 'inherit', background: 'transparent' })
    b.onclick = action
    toolbar.append(b)
  }
  button('已完成', () => { scenario = 'done'; render() })
  button('等待中', () => { scenario = 'pending'; render() })
  button('失败', () => { scenario = 'failed'; render() })
  button('中断', () => { scenario = 'interrupted'; render() })
  button('EN / 中文', () => { language = language === 'zh' ? 'en' : 'zh'; render() })
  button('关闭预览', close)
  window.__GROK_MEDIA_PREVIEW__ = { close, hideBackground, restoreBackground, setScenario(value) { scenario = value; render() }, get language() { return language } }
  render()
})()
