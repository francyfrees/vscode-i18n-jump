/* eslint-disable @typescript-eslint/no-require-imports -- VS Code 扩展宿主只加载 CommonJS */
// t('...') 的三种辅助：悬停看中英文、Cmd+点击跳到词条、内联回显（手动开关）。
// 词条目录、语言、截断长度与「键在哪个调用里」都由设置决定，默认值对应本仓库的布局。
const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = {
  languages: ['zh-CN', 'en-US'],
  localePaths: [
    'apps/web/src/locales/{lang}',
    'packages/shared/src/i18n/{lang}',
    'packages/shared/src/i18n/{lang}/modules',
    'apps/server/src/i18n/{lang}',
  ],
  inlineMaxLength: 15,
  // 键所在的调用：函数名 + 键是第几个参数（从 0 开始）。写成字符串等同于 arg 0。
  keyCalls: [
    { call: 't', arg: 0 },
    { call: '$t', arg: 0 },
    { call: 'i18n.t', arg: 0 },
    { call: 'i18n.global.t', arg: 0 },
  ],
}
// 键的形状：至少一段点分，排除 'createdAt'、'A0400' 这类普通字符串
const KEY_SHAPE = /^[\w-]+(?:\.[\w-]+)+$/
const cache = new Map()

const rootOf = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

/** 当前设置；未配置时用 DEFAULTS。 */
function settings() {
  const cfg = vscode.workspace.getConfiguration('i18nJump')
  return {
    languages: cfg.get('languages', DEFAULTS.languages),
    localePaths: cfg.get('localePaths', DEFAULTS.localePaths),
    inlineMaxLength: cfg.get('inlineMaxLength', DEFAULTS.inlineMaxLength),
    keyCalls: normalizeCalls(cfg.get('keyCalls', DEFAULTS.keyCalls)),
  }
}

/** 过滤掉写坏的条目（缺 call、arg 不是非负整数），全空时退回默认，避免设置写错后扩展静默失效。 */
function normalizeCalls(raw) {
  const calls = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const call = typeof item === 'string' ? item : item?.call
    const arg = Number.isInteger(item?.arg) && item.arg >= 0 ? item.arg : 0
    if (typeof call === 'string' && call) calls.push({ call, arg })
  }
  return calls.length ? calls : DEFAULTS.keyCalls
}

/**
 * 一行里命中的键，按位置排序。每条 keyCalls 给出函数名与参数序号：
 * 在该参数里按源码顺序找第一个字符串字面量，键必须是点分形式。
 * 只做单行解析，跨行书写的调用不认（与旧版一致）。
 */
function findKeysInLine(text, keyCalls) {
  const hits = []
  for (const { call, arg } of keyCalls) {
    let from = 0
    for (;;) {
      const at = text.indexOf(call, from)
      if (at < 0) break
      from = at + call.length
      if (!isCallAt(text, at)) continue
      let i = at + call.length
      while (i < text.length && /\s/.test(text[i])) i++
      if (text[i] !== '(') continue
      const hit = literalInArg(text, i + 1, arg)
      if (hit && !hits.some((h) => h.start === hit.start)) hits.push(hit)
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}

/** 名字前面是标识符字符说明只是更长名字的一部分（submit('x') 里的 t）；点号允许，兼容 this.$t、n.global.t。 */
function isCallAt(text, at) {
  const prev = at > 0 ? text[at - 1] : ''
  return !prev || !/[\w$]/.test(prev)
}

/**
 * 第 index 个参数里的第一个字符串字面量，返回它在行内的起止列。
 * 逗号只在调用参数这一层计数，所以参数里的对象、嵌套调用、字符串内的逗号都不会打断定位。
 */
function literalInArg(text, start, index) {
  let depth = 0
  let arg = 0
  let i = start
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const close = skipString(text, i)
      if (close < 0) return null
      if (arg === index) {
        const value = text.slice(i + 1, close)
        // 模板串带插值（t(`a.${x}`)）不是字面量键
        if (ch === '`' && value.includes('${')) return null
        return KEY_SHAPE.test(value) ? { key: value, start: i, end: close + 1 } : null
      }
      i = close + 1
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (!depth) return null
      depth--
    } else if (ch === ',' && !depth) {
      if (++arg > index) return null
    }
    i++
  }
  return null
}

/** 右引号所在列；字符串在本行没结束时返回 -1。转义字符整对跳过。 */
function skipString(text, start) {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i
    i++
  }
  return -1
}

/**
 * 光标所在位置对应的键；不在某个配置调用的键字面量上返回 null。
 * 范围只到右引号，所以内联提示落在键后面：t('key' 文案)。
 */
function keyAt(document, position) {
  const line = document.lineAt(position.line).text
  for (const hit of findKeysInLine(line, settings().keyCalls)) {
    if (position.character >= hit.start && position.character <= hit.end) {
      return { key: hit.key, range: new vscode.Range(position.line, hit.start, position.line, hit.end) }
    }
  }
  return null
}

/** 按设置展开的 (语言, 相对目录) 列表。 */
function* localeFiles(root) {
  const { languages, localePaths } = settings()
  const seen = new Set()
  for (const lang of languages)
    for (const template of localePaths) {
      const base = template.replaceAll('{lang}', lang)
      let names
      try {
        names = fs.readdirSync(path.join(root, base))
      } catch {
        continue
      }
      for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
        const rel = `${base}/${name}`
        if (!seen.has(rel)) {
          seen.add(rel)
          yield rel
        }
      }
    }
}

/** 逐行维护键栈，返回 path 指向的叶子行号与值。 */
function locate(text, target) {
  const wanted = target.join('.')
  const stack = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const indent = line.length - line.trimStart().length
    if (/^\s*[}\]]/.test(line)) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      continue
    }
    const m = /^\s*"((?:[^"\\]|\\.)*)"\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const name = JSON.parse(`"${m[1]}"`)
    const rest = m[2].trim()
    if (rest.startsWith('{') || rest.startsWith('[')) {
      stack.push({ name, indent })
      continue
    }
    if ([...stack.map((s) => s.name), name].join('.') === wanted) {
      let value = rest.replace(/,\s*$/, '')
      try {
        value = JSON.parse(value)
      } catch {
        /* 非字符串值按原文显示 */
      }
      return { line: i + 1, value }
    }
  }
  return null
}

function lookup(key) {
  const root = rootOf()
  if (!root) return []
  const hit = cache.get(key)
  if (hit) return hit
  const segments = key.split('.')
  const entries = []
  for (const rel of localeFiles(root)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const target of [segments, segments.slice(1)]) {
      if (!target.length) continue
      const found = locate(text, target)
      if (found) {
        entries.push({ file: path.join(root, rel), line: found.line, value: found.value, rel })
        break
      }
    }
  }
  cache.set(key, entries)
  return entries
}

/** 路径属于哪种语言（按设置的顺序匹配）。 */
function label(rel) {
  return settings().languages.find((l) => rel.includes(`/${l}/`)) ?? ''
}

/** 按设置的语言顺序取第一条：默认语言（第一个）优先。 */
function preferred(key) {
  const entries = lookup(key)
  const first = settings().languages[0]
  return entries.find((e) => e.rel.includes(`/${first}/`)) ?? entries[0]
}

function activate(context) {
  const selector = [
    { language: 'typescript' },
    { language: 'javascript' },
    { language: 'vue' },
    { language: 'typescriptreact' },
    { language: 'javascriptreact' },
  ]

  // 内联提示默认开启，按工作区记住状态；状态栏可点
  let inline = context.workspaceState.get('i18nJump.inlineOn', true)
  const changed = new vscode.EventEmitter()
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  status.command = 'i18nJump.toggleInline'
  const refreshStatus = () => {
    status.text = inline ? '$(eye) i18n 中文' : '$(eye-closed) i18n 中文'
    status.tooltip = inline ? '翻译内联提示：已开启（点击关闭）' : '翻译内联提示：已关闭（点击开启）'
    status.show()
  }
  refreshStatus()

  context.subscriptions.push(
    status,
    changed,
    vscode.commands.registerCommand('i18nJump.toggleInline', () => {
      inline = !inline
      void context.workspaceState.update('i18nJump.inlineOn', inline)
      refreshStatus()
      changed.fire()
    }),

    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        const hit = keyAt(document, position)
        if (!hit) return
        const entries = lookup(hit.key)
        const md = new vscode.MarkdownString()
        md.appendMarkdown(`**${hit.key}**\n\n`)
        if (!entries.length) md.appendMarkdown('_没有找到对应词条_')
        for (const e of entries) md.appendMarkdown(`\`${label(e.rel)}\` ${e.value}\n\n`)
        return new vscode.Hover(md, hit.range)
      },
    }),

    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(document, position) {
        const hit = keyAt(document, position)
        if (!hit) return
        const target = preferred(hit.key)
        if (!target) return
        return new vscode.Location(
          vscode.Uri.file(target.file),
          new vscode.Position(target.line - 1, 0),
        )
      },
    }),

    vscode.languages.registerInlayHintsProvider(selector, {
      onDidChangeInlayHints: changed.event,
      provideInlayHints(document, range) {
        if (!inline) return []
        const { inlineMaxLength: max, keyCalls } = settings()
        const hints = []
        for (let line = range.start.line; line <= range.end.line; line++) {
          const text = document.lineAt(line).text
          for (const hit of findKeysInLine(text, keyCalls)) {
            const entry = preferred(hit.key)
            if (!entry || typeof entry.value !== 'string') continue
            const value = entry.value.length > max ? `${entry.value.slice(0, max)}…` : entry.value
            const hint = new vscode.InlayHint(new vscode.Position(line, hit.end), value)
            hint.paddingLeft = true
            hints.push(hint)
          }
        }
        return hints
      },
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (/\/locales\/|\/i18n\//.test(doc.uri.fsPath)) {
        cache.clear()
        changed.fire()
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('i18nJump')) return
      cache.clear()
      changed.fire()
    }),
  )
}

module.exports = { activate }
