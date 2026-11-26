/**
 * 维基目录。原料只增不改，索引由页面头重建，日志只追加。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { KINDS, readPages, writePage } from './pages.js'

export const SCHEMA_TEXT = `# 图式

原料在 raw/，只读。维基由插件按校验过的补丁写入 pages/。index.md 和 log.md 由插件生成，不要直接修改。

页面分四类：source 是一份材料的摘要，entity 是人、组织、地点或作品，concept 是概念，query 是被明确要求留下的提问。

已有页面只能在补丁里写 update: true 后修改。sources 只增加，不删除。互相矛盾的主张写进 contradicts，两面都留在正文里。aliases 是读者会拿来查找的词，包括正文没写但读者会用的常见叫法。claims 是可以单独被检索的原子主张。更新已有页时，原来的 aliases 和 claims 必须保留。材料若标明未完整交给模型，不要把它写成已经读完。

正文用 [[种类/slug]] 指向别的页。
`

/** 维基根目录。LLM_WIKI_ROOT 优先，否则放在 DSH 主目录下。 */
export function wikiRoot(env = process.env) {
  const chosen = env.LLM_WIKI_ROOT?.trim()
  if (chosen) return path.resolve(chosen)
  const home = env.DSH_HOME?.trim() ? path.resolve(env.DSH_HOME.trim()) : path.join(homedir(), '.dsh')
  return path.join(home, 'llm-wiki')
}

/** 准备目录和图式。图式已存在就不覆盖。 */
export function ensureWiki(root) {
  mkdirSync(path.join(root, 'raw'), { recursive: true })
  for (const kind of KINDS) mkdirSync(path.join(root, 'pages', kind), { recursive: true })
  const schema = path.join(root, 'schema.md')
  if (!existsSync(schema)) writeFileSync(schema, SCHEMA_TEXT)
  if (!existsSync(path.join(root, 'index.md'))) rebuildIndex(root)
  if (!existsSync(path.join(root, 'log.md'))) writeFileSync(path.join(root, 'log.md'), '# 日志\n')
}

/** 按内容哈希保存原料。相同内容不重写。 */
export function writeRaw(root, bytes, meta) {
  const buffer = Buffer.from(bytes)
  const hash = createHash('sha256').update(buffer).digest('hex')
  const ext = safeExt(meta.ext)
  const file = path.join(root, 'raw', `${hash}${ext}`)
  if (!existsSync(file)) writeFileSync(file, buffer)
  const side = path.join(root, 'raw', `${hash}.meta.json`)
  if (!existsSync(side)) {
    writeFileSync(side, `${JSON.stringify({ hash, file: `${hash}${ext}`, ...meta }, null, 2)}\n`)
  }
  return { hash, file: `${hash}${ext}` }
}

/** 用当前页面重建索引。坏页也记一笔，避免看起来像没有这页。 */
export function rebuildIndex(root) {
  const { pages, broken } = readPages(root)
  const lines = ['# 索引', '']
  for (const kind of KINDS) {
    lines.push(`## ${kindLabel(kind)}`, '')
    const group = pages.filter((page) => page.kind === kind)
    if (group.length === 0) lines.push('（空）', '')
    for (const page of group) {
      const mark = page.partial ? '，材料不完整' : ''
      const aliases = (page.aliases ?? []).join('、')
      const claim = (page.claims ?? [])[0] ?? ''
      const links = linksIn(page.body).join(' ')
      lines.push(`- [[${page.kind}/${page.slug}]] ${page.title} — ${page.summary}${mark}`)
      if (aliases) lines.push(`  别名：${aliases}`)
      if (claim) lines.push(`  主张：${claim}`)
      if (links) lines.push(`  链接：${links}`)
    }
    lines.push('')
  }
  if (broken.length > 0) {
    lines.push('## 无法读取', '')
    for (const item of broken) lines.push(`- ${item.id}`)
    lines.push('')
  }
  writeFileSync(path.join(root, 'index.md'), `${lines.join('\n')}`)
  writeContradictions(root, pages)
  return { pages, broken }
}

/** 把互相矛盾的页和各自的第一条主张写成一份清单。 */
function writeContradictions(root, pages) {
  const byId = new Map(pages.map((page) => [`${page.kind}/${page.slug}`, page]))
  const lines = ['# 矛盾', '']
  const seen = new Set()
  for (const page of pages) {
    const id = `${page.kind}/${page.slug}`
    for (const otherId of page.contradicts ?? []) {
      const key = [id, otherId].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      const other = byId.get(otherId)
      lines.push(`- [[${id}]] ${firstClaim(page)}`)
      lines.push(`  相对 [[${otherId}]] ${other ? firstClaim(other) : ''}`)
    }
  }
  if (seen.size === 0) lines.push('（无）', '')
  writeFileSync(path.join(root, 'contradictions.md'), `${lines.join('\n')}\n`)
}

function firstClaim(page) {
  return (page.claims ?? [])[0] || page.summary || page.title
}

function linksIn(body) {
  return [...String(body ?? '').matchAll(/\[\[(source|entity|concept|query)\/([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g)]
    .map((match) => `${match[1]}/${match[2]}`)
}

/** 追加一条可被 grep "^## \\[" 认出的日志。 */
export function appendLog(root, entry) {
  const file = path.join(root, 'log.md')
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : '# 日志\n'
  const body = previous.endsWith('\n') ? previous : `${previous}\n`
  writeFileSync(file, `${body}\n## [${entry.date}] ${entry.op} | ${entry.title}\n${entry.detail}\n`)
}

/** 给模型看的目录，只含标识和一句摘要。 */
export function catalogOf(root, limit = 100) {
  const { pages, broken } = readPages(root)
  const shown = pages.slice(0, limit).map((page) => ({
    id: `${page.kind}/${page.slug}`,
    title: page.title,
    summary: page.summary,
    aliases: page.aliases,
    claims: page.claims,
    sources: page.sources,
    cites: page.cites,
    contradicts: page.contradicts,
    partial: page.partial,
  }))
  return { entries: shown, total: pages.length, truncated: pages.length > limit, broken, pages }
}

function kindLabel(kind) {
  return { source: '来源', entity: '实体', concept: '概念', query: '提问' }[kind]
}

function safeExt(ext) {
  const text = String(ext ?? '').toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(text) ? text : '.bin'
}

export { writePage }
