/**
 * 校验模型交回的补丁。通过之后才允许写盘。
 */
import { appendLog, rebuildIndex } from './store.js'
import { parseRelation } from './graph.js'
import { PAGE_ID, pageId, validKind, writePage } from './pages.js'
import { resolveSlug, SLUG_RULE, uniqueSlug } from './slug.js'

const HASH = /^[a-f0-9]{64}$/
const CITE = PAGE_ID

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
    if (page.kind === 'query') return badPatch('query', page.kind, '摄入不能创建 query 页')
    const sources = unique(page.sources)
    const badSource = sources.find((item) => !HASH.test(item))
    if (badSource !== undefined) return badPatch('sources', badSource, '64位小写十六进制')
    if (!sources.includes(options.hash)) return badPatch('hash', sources.join(','), '必须包含本次原料哈希')
    if (previous && !previous.sources.every((item) => sources.includes(item))) {
      return { ok: false, code: 'SOURCE_DROPPED', id }
    }
    if (previous && !covered(previous.aliases, page.aliases)) return { ok: false, code: 'INDEX_DROPPED', id }
    if (previous && !covered(previous.claims, page.claims)) return { ok: false, code: 'INDEX_DROPPED', id }
    if (previous && !covered(previous.relations, page.relations)) return { ok: false, code: 'INDEX_DROPPED', id }
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
    if (!covered(previous.aliases, page.aliases) || !covered(previous.claims, page.claims) || !covered(previous.relations, page.relations)) {
      return { ok: false, code: 'INDEX_DROPPED', id }
    }
    checked.push({
      ...page,
      sources,
      cites,
      ...(page.locator || previous.locator ? { locator: page.locator || previous.locator } : {}),
      partial: page.partial === true || previous.partial === true,
    })
  }
  return { ok: true, pages: checked, summary: limitText(patch.summary, 200) }
}

/**
 * 归档的提问只能引用这次真正读过的页。
 */
export function validateQuery(page, options) {
  const checked = checkPage(page ?? {})
  if (checked.code) return checked
  if (checked.kind !== 'query') return badPatch('query', checked.kind, '归档提问必须是 query 页')
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
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return badPatch('pages', '', 'JSON 对象，含 pages 数组')
  if (!Array.isArray(patch.pages) || patch.pages.length === 0 || patch.pages.length > maxPages) {
    return badPatch('pages', Array.isArray(patch.pages) ? String(patch.pages.length) : '', '1到12页')
  }
  const seen = new Set()
  const pages = []
  for (const item of patch.pages) {
    const page = checkPage(item, seen)
    if (page.code) return page
    const id = pageId(page.kind, page.slug)
    if (seen.has(id)) return badPatch('slug', id, '同一补丁里 slug 不能重复')
    seen.add(id)
    pages.push(page)
  }
  return pages
}

function checkPage(page, seen = new Set()) {
  if (!page || typeof page !== 'object') return badPatch('page', '', '对象')
  if (!validKind(page.kind)) return badPatch('kind', page.kind, 'source|entity|event|concept|query')
  const slug = uniqueSlug(page.kind, resolveSlug(page.slug, page.title), seen)
  if (!slug) return badPatch('slug', page.slug, SLUG_RULE)
  if (typeof page.title !== 'string' || page.title.length < 1 || page.title.length > 120) return badPatch('title', page.title, '1到120字')
  if (typeof page.summary !== 'string' || page.summary.length < 1 || page.summary.length > 200) return badPatch('summary', page.summary, '1到200字')
  if (typeof page.body !== 'string' || page.body.length < 1 || page.body.length > 8000) return badPatch('body', page.body, '1到8000字')
  const contradicts = unique(page.contradicts)
  if (contradicts.some((item) => !CITE.test(item))) return badPatch('contradicts', contradicts.find((item) => !CITE.test(item)), '种类/slug')
  const cites = unique(page.cites)
  if (cites.some((item) => !CITE.test(item))) return badPatch('cites', cites.find((item) => !CITE.test(item)), '种类/slug')
  const aliases = textList(page.aliases, 8, 40, 'aliases')
  if (aliases.code) return aliases
  const claims = textList(page.claims, 8, 160, 'claims')
  if (claims.code) return claims
  const relations = relationList(page, slug)
  if (relations.code) return relations
  return {
    kind: page.kind,
    slug,
    title: page.title,
    summary: page.summary,
    body: page.body,
    sources: unique(page.sources),
    cites,
    contradicts,
    aliases,
    claims,
    relations,
    update: page.update === true,
    ...(typeof page.locator === 'string' && page.locator.trim() ? { locator: page.locator.trim().slice(0, 180) } : {}),
    ...(page.partial === true ? { partial: true } : {}),
  }
}

/** 关系最多 16 条，每条是「谓语 目标页」，不能指向自己或提问页。 */
function relationList(page, slug) {
  if (page.relations == null) return []
  if (!Array.isArray(page.relations)) return badPatch('relations', '', '谓语 种类/slug，最多 16 条')
  const self = pageId(page.kind, slug)
  const items = []
  for (const item of page.relations) {
    if (typeof item !== 'string') return badPatch('relations', item, '谓语 种类/slug')
    const parsed = parseRelation(item.trim())
    if (!parsed || parsed.to === self) return badPatch('relations', item, '谓语 种类/slug，不能指向自己或提问页')
    items.push(`${parsed.type} ${parsed.to}`)
  }
  const deduped = [...new Set(items)]
  if (deduped.length > 16) return badPatch('relations', String(deduped.length), '最多 16 条')
  return deduped
}

function unique(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => typeof item === 'string'))]
}

/** 短索引项。空缺当作没有，超长或不是字符串则拒绝。 */
function textList(value, maxItems, maxLen, code) {
  if (value == null) return []
  if (!Array.isArray(value)) return badPatch(code, '', `字符串数组，最多 ${maxItems} 项，每项不超过 ${maxLen} 字`)
  const items = []
  for (const item of value) {
    if (typeof item !== 'string') return badPatch(code, item, `字符串，不超过 ${maxLen} 字`)
    const text = item.trim()
    if (!text || text.length > maxLen || /[\n\r]/.test(text)) return badPatch(code, text, `1到${maxLen}字，不能换行`)
    items.push(text)
  }
  const deduped = [...new Set(items)]
  if (deduped.length > maxItems) return badPatch(code, String(deduped.length), `最多 ${maxItems} 项`)
  return deduped
}

/** 校验失败时带回字段、非法值和规则。message 仍是字段名，旧的修复提示还能对上。 */
function badPatch(field, value, rule) {
  const shown = typeof value === 'string' ? value.slice(0, 180) : JSON.stringify(value ?? '').slice(0, 180)
  return { ok: false, code: 'BAD_PATCH', field, value: shown, rule, message: field }
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
