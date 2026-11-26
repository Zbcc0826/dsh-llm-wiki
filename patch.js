/**
 * 校验模型交回的补丁。通过之后才允许写盘。
 */
import { appendLog, rebuildIndex } from './store.js'
import { pageId, validKind, validSlug, writePage } from './pages.js'

const HASH = /^[a-f0-9]{64}$/
const CITE = /^(source|entity|concept|query)\/[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 检查摄入补丁。已有页必须声明 update，并且保留原来的来源哈希。
 */
export function validateIngest(patch, options) {
  const pages = checkCommon(patch, 12)
  if (pages.code) return pages
  const existing = options.existing ?? new Map()
  const checked = []
  for (const page of pages) {
    const id = pageId(page.kind, page.slug)
    const previous = existing.get(id)
    if (previous && page.update !== true) return { ok: false, code: 'EXISTS', id }
    if (!previous && page.update === true) return { ok: false, code: 'MISSING', id }
    if (page.kind === 'query') return { ok: false, code: 'BAD_PATCH', message: 'query' }
    const sources = unique(page.sources)
    if (!sources.every((item) => HASH.test(item))) return { ok: false, code: 'BAD_PATCH', message: 'sources' }
    if (!sources.includes(options.hash)) return { ok: false, code: 'BAD_PATCH', message: 'hash' }
    if (previous && !previous.sources.every((item) => sources.includes(item))) {
      return { ok: false, code: 'SOURCE_DROPPED', id }
    }
    if (previous && !covered(previous.aliases, page.aliases)) return { ok: false, code: 'INDEX_DROPPED', id }
    if (previous && !covered(previous.claims, page.claims)) return { ok: false, code: 'INDEX_DROPPED', id }
    checked.push({ ...page, sources, cites: [] })
  }
  return { ok: true, pages: checked, summary: limitText(patch.summary, 200) }
}

/**
 * 体检只能改已有页，不能新建，也不能减少依据。
 */
export function validateLint(patch, options) {
  const pages = checkCommon(patch, 12)
  if (pages.code) return pages
  const existing = options.existing ?? new Map()
  const checked = []
  for (const page of pages) {
    const id = pageId(page.kind, page.slug)
    const previous = existing.get(id)
    if (!previous) return { ok: false, code: 'LINT_CREATE', id }
    const sources = unique(page.sources)
    const cites = unique(page.cites)
    if (!sameSet(sources, previous.sources) || !sameSet(cites, previous.cites)) {
      return { ok: false, code: 'SOURCE_DROPPED', id }
    }
    if (!covered(previous.aliases, page.aliases) || !covered(previous.claims, page.claims)) {
      return { ok: false, code: 'INDEX_DROPPED', id }
    }
    checked.push({ ...page, sources, cites })
  }
  return { ok: true, pages: checked, summary: limitText(patch.summary, 200) }
}

/**
 * 归档的提问只能引用这次真正读过的页。
 */
export function validateQuery(page, options) {
  const checked = checkPage(page ?? {})
  if (checked.code) return checked
  if (checked.kind !== 'query') return { ok: false, code: 'BAD_PATCH', message: 'query' }
  const cites = unique(checked.cites)
  const read = options.read ?? new Set()
  if (cites.length === 0 || cites.some((item) => !read.has(item))) return { ok: false, code: 'UNCITED' }
  const id = pageId(checked.kind, checked.slug)
  if ((options.existing ?? new Map()).has(id)) return { ok: false, code: 'EXISTS', id }
  return { ok: true, page: { ...checked, sources: [], cites } }
}

/** 全部校验通过后写页面、重建索引、追加日志。 */
export function applyPatch(root, result, entry) {
  const updated = entry.updated
  for (const page of result.pages) {
    writePage(root, { ...page, partial: entry.partial === true || page.partial === true, updated })
  }
  rebuildIndex(root)
  appendLog(root, {
    date: entry.date,
    op: entry.op,
    title: entry.title,
    detail: `${result.summary}\npages: ${result.pages.map((page) => pageId(page.kind, page.slug)).join(', ')}`,
  })
}

function checkCommon(patch, maxPages) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, code: 'BAD_PATCH' }
  if (!Array.isArray(patch.pages) || patch.pages.length === 0 || patch.pages.length > maxPages) {
    return { ok: false, code: 'BAD_PATCH' }
  }
  const seen = new Set()
  const pages = []
  for (const item of patch.pages) {
    const page = checkPage(item)
    if (page.code) return page
    const id = pageId(page.kind, page.slug)
    if (seen.has(id)) return { ok: false, code: 'BAD_PATCH', message: 'duplicate' }
    seen.add(id)
    pages.push(page)
  }
  return pages
}

function checkPage(page) {
  if (!page || typeof page !== 'object') return { ok: false, code: 'BAD_PATCH' }
  if (!validKind(page.kind) || !validSlug(page.slug)) return { ok: false, code: 'BAD_PATCH', message: 'slug' }
  if (typeof page.title !== 'string' || page.title.length < 1 || page.title.length > 120) return { ok: false, code: 'BAD_PATCH', message: 'title' }
  if (typeof page.summary !== 'string' || page.summary.length < 1 || page.summary.length > 200) return { ok: false, code: 'BAD_PATCH', message: 'summary' }
  if (typeof page.body !== 'string' || page.body.length < 1 || page.body.length > 8000) return { ok: false, code: 'BAD_PATCH', message: 'body' }
  const contradicts = unique(page.contradicts)
  if (contradicts.some((item) => !CITE.test(item))) return { ok: false, code: 'BAD_PATCH', message: 'contradicts' }
  const cites = unique(page.cites)
  if (cites.some((item) => !CITE.test(item))) return { ok: false, code: 'BAD_PATCH', message: 'cites' }
  const aliases = textList(page.aliases, 8, 40, 'aliases')
  if (aliases.code) return aliases
  const claims = textList(page.claims, 8, 160, 'claims')
  if (claims.code) return claims
  return {
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    summary: page.summary,
    body: page.body,
    sources: unique(page.sources),
    cites,
    contradicts,
    aliases,
    claims,
    update: page.update === true,
  }
}

function unique(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => typeof item === 'string'))]
}

/** 短索引项。空缺当作没有，超长或不是字符串则拒绝。 */
function textList(value, maxItems, maxLen, code) {
  if (value == null) return []
  if (!Array.isArray(value)) return { ok: false, code: 'BAD_PATCH', message: code }
  const items = []
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, code: 'BAD_PATCH', message: code }
    const text = item.trim()
    if (!text || text.length > maxLen || /[\n\r]/.test(text)) return { ok: false, code: 'BAD_PATCH', message: code }
    items.push(text)
  }
  const deduped = [...new Set(items)]
  if (deduped.length > maxItems) return { ok: false, code: 'BAD_PATCH', message: code }
  return deduped
}

function covered(previous, next) {
  return (previous ?? []).every((item) => next.includes(item))
}

function sameSet(left, right) {
  const a = [...left].sort()
  const b = [...(right ?? [])].sort()
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function limitText(value, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.slice(0, max) || '已更新'
}
