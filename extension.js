// t('...') 的三种辅助：悬停看中英文、Cmd+点击跳到中文词条、内联回显中文（手动开关）。
// 解析规则与 scripts/i18n-jump.mjs 一致（见 packages/shared/src/common/locale.ts 的 mergeLocaleFile）：
// 带点文件名与 shared modules 存完整键，单段文件名去掉第一段。
const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')

const LANGS = ['zh-CN', 'en-US']
const BASES = (lang) => [
  `apps/web/src/locales/${lang}`,
  `packages/shared/src/i18n/${lang}`,
  `packages/shared/src/i18n/${lang}/modules`,
  `apps/server/src/i18n/${lang}`,
]
const KEY_RE = /(?:\$t|tx?|i18n(?:\.global)?\.t)\(\s*(['"`])([\w.-]+)\1/g
/** 内联提示保留的字符数，超出用省略号。 */
const INLINE_MAX = 15
const cache = new Map()

const rootOf = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

/** 光标所在位置对应的键；不在 t('...') 范围内返回 null。 */
function keyAt(document, position) {
  const line = document.lineAt(position.line).text
  KEY_RE.lastIndex = 0
  let m
  while ((m = KEY_RE.exec(line))) {
    const start = m.index
    const end = start + m[0].length
    if (position.character >= start && position.character <= end) {
      return { key: m[2], range: new vscode.Range(position.line, start, position.line, end) }
    }
  }
  return null
}

function* localeFiles(root) {
  const seen = new Set()
  for (const lang of LANGS)
    for (const base of BASES(lang)) {
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

const label = (rel) => (rel.includes('/zh-CN/') ? 'zh-CN' : rel.includes('/en-US/') ? 'en-US' : '')
const zhOf = (key) => lookup(key).find((e) => e.rel.includes('/zh-CN/'))

function activate(context) {
  const selector = [
    { language: 'typescript' },
    { language: 'javascript' },
    { language: 'vue' },
    { language: 'typescriptreact' },
    { language: 'javascriptreact' },
  ]

  // 内联提示默认关闭，按工作区记住状态；状态栏可点
  let inline = context.workspaceState.get('i18nJump.inline', false)
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
      void context.workspaceState.update('i18nJump.inline', inline)
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
        const target = zhOf(hit.key) ?? lookup(hit.key)[0]
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
        const hints = []
        for (let line = range.start.line; line <= range.end.line; line++) {
          const text = document.lineAt(line).text
          KEY_RE.lastIndex = 0
          let m
          while ((m = KEY_RE.exec(text))) {
            const entry = zhOf(m[2])
            if (!entry || typeof entry.value !== 'string') continue
            const value =
              entry.value.length > INLINE_MAX ? `${entry.value.slice(0, INLINE_MAX)}…` : entry.value
            const hint = new vscode.InlayHint(
              new vscode.Position(line, m.index + m[0].length),
              value,
            )
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
  )
}

module.exports = { activate }
