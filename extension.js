// 在 t('...') 上悬停显示中英文词条，Cmd+点击跳到词条文件。
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

function activate(context) {
  const selector = [
    { language: 'typescript' },
    { language: 'javascript' },
    { language: 'vue' },
    { language: 'typescriptreact' },
    { language: 'javascriptreact' },
  ]

  context.subscriptions.push(
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
        const entries = lookup(hit.key)
        if (!entries.length) return
        // 默认跳中文词条（没有时退回第一条），避免多结果弹选择框
        const target = entries.find((e) => e.rel.includes('/zh-CN/')) ?? entries[0]
        return new vscode.Location(vscode.Uri.file(target.file), new vscode.Position(target.line - 1, 0))
      },
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (/\/locales\/|\/i18n\//.test(doc.uri.fsPath)) cache.clear()
    }),
  )
}

module.exports = { activate }
