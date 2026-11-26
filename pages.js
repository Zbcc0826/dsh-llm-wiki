/**
 * 页面的读写。路径只由种类和 slug 决定，不接受模型给出的文件名。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const KINDS = ['source', 'entity', 'event', 'concept', 'query']
const KIND_SET = new Set(KINDS)
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const KIND_PATTERN = KINDS.join('|')

/** 页标识，例如 entity/acme 或 event/claim。 */
export const PAGE_ID = new RegExp(`^(${KIND_PATTERN})/[a-z0-9]+(?:-[a-z0-9]+)*$`)

/** 正文里的 [[种类/slug]]。 */
export function linksIn(body) {
  const pattern = new RegExp(`\\[\\[(${KIND_PATTERN})/([a-z0-9]+(?:-[a-z0-9]+)*)\\]\\]`, 'g')
  return [...String(body ?? '').matchAll(pattern)].map((match) => `${match[1]}/${match[2]}`)
}

/** slug 只能是小写、数字和单个连字符。 */
export function validSlug(slug) {
  return typeof slug === 'string' && slug.length >= 1 && slug.length <= 60 && SLUG.test(slug)
}

/** 种类必须是来源、实体、事件、概念或提问。 */
export function validKind(kind) {
  return KIND_SET.has(kind)
}

/** 页的相对标识，例如 entity/li。 */
export function pageId(kind, slug) {
  return `${kind}/${slug}`
}

/** 把一页写成带页面头的 markdown。 */
export function serializePage(page) {
  const lines = [
    '---',
    `kind: ${JSON.stringify(page.kind)}`,
    `slug: ${JSON.stringify(page.slug)}`,
    `title: ${JSON.stringify(page.title ?? '')}`,
    `summary: ${JSON.stringify(page.summary ?? '')}`,
    `partial: ${page.partial === true ? 'true' : 'false'}`,
    ...(page.locator ? [`locator: ${JSON.stringify(page.locator)}`] : []),
    `updated: ${JSON.stringify(page.updated ?? '')}`,
    listField('sources', page.sources),
    listField('cites', page.cites),
    listField('contradicts', page.contradicts),
    listField('relations', page.relations),
    listField('aliases', page.aliases),
    listField('claims', page.claims),
    '---',
    '',
    String(page.body ?? '').replace(/^\n+/, ''),
    '',
  ]
  return `${lines.join('\n')}`
}

/** 读回插件自己写出的页面头。格式不对就失败，不猜测。 */
export function parsePage(markdown) {
  const match = String(markdown ?? '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { ok: false, code: 'BAD_PAGE' }
  const meta = {}
  let listKey = ''
  for (const line of match[1].split('\n')) {
    if (line.startsWith('  - ') && listKey) {
      meta[listKey].push(JSON.parse(line.slice(4)))
      continue
    }
    listKey = ''
    if (line.endsWith(':') && !line.includes(': ')) {
      meta[line.slice(0, -1)] = []
      listKey = line.slice(0, -1)
      continue
    }
    const cut = line.indexOf(': ')
    if (cut < 0) return { ok: false, code: 'BAD_PAGE' }
    const key = line.slice(0, cut)
    const value = line.slice(cut + 2)
    if (value === '[]') meta[key] = []
    else if (value === 'true') meta[key] = true
    else if (value === 'false') meta[key] = false
    else if (value.startsWith('"')) meta[key] = JSON.parse(value)
    else if (value === '') {
      meta[key] = []
      listKey = key
    } else return { ok: false, code: 'BAD_PAGE' }
  }
  if (!validKind(meta.kind) || !validSlug(meta.slug)) return { ok: false, code: 'BAD_PAGE' }
  return {
    ok: true,
    kind: meta.kind,
    slug: meta.slug,
    title: String(meta.title ?? ''),
    summary: String(meta.summary ?? ''),
    partial: meta.partial === true,
    locator: meta.locator ? String(meta.locator) : '',
    updated: String(meta.updated ?? ''),
    sources: asList(meta.sources),
    cites: asList(meta.cites),
    contradicts: asList(meta.contradicts),
    relations: asList(meta.relations),
    aliases: asList(meta.aliases),
    claims: asList(meta.claims),
    body: match[2].replace(/^\n/, '').replace(/\n$/, ''),
  }
}

/** 读出某一类目录下的全部页面。坏页单独列出。 */
export function readPages(root) {
  const pages = []
  const broken = []
  for (const kind of KINDS) {
    const dir = path.join(root, 'pages', kind)
    let names = []
    try { names = readdirSync(dir) } catch { names = [] }
    for (const name of names.filter((item) => item.endsWith('.md')).sort()) {
      const slug = name.slice(0, -3)
      let text = ''
      try { text = readFileSync(path.join(dir, name), 'utf8') } catch {
        broken.push({ id: pageId(kind, slug), code: 'BAD_PAGE' })
        continue
      }
      const page = parsePage(text)
      if (!page.ok || page.kind !== kind || page.slug !== slug) broken.push({ id: pageId(kind, slug), code: 'BAD_PAGE' })
      else pages.push(page)
    }
  }
  return { pages, broken }
}

/** 写入一页。目录不存在时创建。 */
export function writePage(root, page) {
  const dir = path.join(root, 'pages', page.kind)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${page.slug}.md`), serializePage(page))
}

function listField(name, values) {
  const items = asList(values)
  if (items.length === 0) return `${name}: []`
  return `${name}:\n${items.map((item) => `  - ${JSON.stringify(item)}`).join('\n')}`
}

function asList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}
