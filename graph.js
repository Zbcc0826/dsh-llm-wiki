/**
 * 实体、事件、关系的图。边来自页面头里的 relations，再补上正文链接和矛盾。
 * 查询只读，不调用模型。
 */
import { PAGE_ID, linksIn } from './pages.js'

const PREDICATE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_NODES = 40
const MAX_EDGES = 80

/** 一条关系是「谓语 目标页」。对不上格式就返回空。 */
export function parseRelation(text) {
  const match = String(text ?? '').trim().match(/^(\S+) (\S+)$/)
  if (!match) return null
  const type = match[1]
  const to = match[2]
  if (!PREDICATE.test(type) || type.length > 32) return null
  if (!PAGE_ID.test(to) || to.startsWith('query/')) return null
  return { type, to }
}

/** 读出一页声明的关系。坏行跳过，校验阶段已经拒绝过它们。 */
export function relationsOf(page) {
  return (Array.isArray(page?.relations) ? page.relations : [])
    .map((item) => parseRelation(item))
    .filter(Boolean)
}

/**
 * 从一个页或一个名字出发，沿关系走若干跳。
 * 名字对上标题或别名。predicate 为空时，链接和矛盾也算边。
 */
export function queryGraph(pages, options = {}) {
  const start = String(options.start ?? '').trim()
  if (!start) return { ok: false, code: 'NEED_START' }
  const hops = clampHops(options.hops)
  if (hops === null) return { ok: false, code: 'BAD_HOPS' }
  const predicate = String(options.predicate ?? '').trim()
  if (predicate && !PREDICATE.test(predicate)) return { ok: false, code: 'BAD_PREDICATE' }
  const list = Array.isArray(pages) ? pages : []
  const resolved = resolveStart(list, start)
  if (resolved.ids.length === 0) return { ok: false, code: 'NOT_FOUND', start }
  const byId = new Map(list.map((page) => [`${page.kind}/${page.slug}`, page]))
  const incident = incidentIndex(list)
  const nodes = []
  const seenNodes = new Set()
  const edges = []
  const seenEdges = new Set()
  let truncated = false
  const remember = (id) => {
    if (seenNodes.has(id) || !byId.has(id)) return false
    if (nodes.length >= MAX_NODES) {
      truncated = true
      return false
    }
    seenNodes.add(id)
    nodes.push(nodeOf(byId.get(id)))
    return true
  }
  for (const id of resolved.ids) remember(id)
  let frontier = [...seenNodes]
  for (let hop = 1; hop <= hops; hop += 1) {
    const next = []
    for (const id of frontier) {
      for (const edge of incident.get(id) ?? []) {
        if (predicate && edge.type !== predicate) continue
        const key = `${edge.from}\t${edge.type}\t${edge.to}`
        const other = edge.from === id ? edge.to : edge.from
        if (!seenEdges.has(key)) {
          if (edges.length >= MAX_EDGES) truncated = true
          else {
            seenEdges.add(key)
            edges.push({ ...edge, hop })
          }
        }
        if (remember(other)) next.push(other)
      }
    }
    frontier = next
  }
  return {
    ok: true,
    start,
    roots: resolved.ids.filter((id) => seenNodes.has(id)),
    ambiguous: resolved.ambiguous,
    hops,
    predicate,
    nodes,
    edges,
    truncated,
  }
}

/** 某个页出发能走到的关系目标，包括别人指向它的边。给取证的多跳用。 */
export function relationNeighbors(page, pages) {
  const id = `${page.kind}/${page.slug}`
  const found = new Set(relationsOf(page).map((item) => item.to))
  for (const other of pages) {
    if (`${other.kind}/${other.slug}` === id) continue
    for (const item of relationsOf(other)) {
      if (item.to === id) found.add(`${other.kind}/${other.slug}`)
    }
  }
  return [...found]
}

function resolveStart(pages, start) {
  if (PAGE_ID.test(start)) {
    const exact = pages.find((page) => `${page.kind}/${page.slug}` === start)
    return { ids: exact ? [start] : [], ambiguous: false }
  }
  const needle = start.toLowerCase()
  const exact = pages.filter((page) => sameName(page, needle))
  if (exact.length > 0) return { ids: exact.slice(0, 8).map(pageIdOf), ambiguous: exact.length > 1 }
  if (needle.length < 2) return { ids: [], ambiguous: false }
  const fuzzy = pages.filter((page) => includesName(page, needle))
  return { ids: fuzzy.slice(0, 8).map(pageIdOf), ambiguous: fuzzy.length > 1 }
}

function sameName(page, needle) {
  if (String(page.title ?? '').trim().toLowerCase() === needle) return true
  return (page.aliases ?? []).some((item) => String(item).trim().toLowerCase() === needle)
}

function includesName(page, needle) {
  if (String(page.title ?? '').toLowerCase().includes(needle)) return true
  return (page.aliases ?? []).some((item) => String(item).toLowerCase().includes(needle))
}

function incidentIndex(pages) {
  const index = new Map()
  const add = (id, edge) => {
    const list = index.get(id) ?? []
    list.push(edge)
    index.set(id, list)
  }
  for (const page of pages) {
    const id = pageIdOf(page)
    const base = { sources: (page.sources ?? []).slice(0, 4), locator: String(page.locator ?? '') }
    for (const item of relationsOf(page)) {
      const edge = { from: id, to: item.to, type: item.type, ...base }
      add(id, edge)
      add(item.to, edge)
    }
    for (const target of linksIn(page.body)) {
      const edge = { from: id, to: target, type: 'mentions', ...base }
      add(id, edge)
      add(target, edge)
    }
    for (const target of page.contradicts ?? []) {
      const edge = { from: id, to: target, type: 'contradicts', ...base }
      add(id, edge)
      add(target, edge)
    }
  }
  return index
}

function nodeOf(page) {
  return {
    id: pageIdOf(page),
    kind: page.kind,
    title: page.title ?? '',
    summary: page.summary ?? '',
    aliases: page.aliases ?? [],
  }
}

function pageIdOf(page) {
  return `${page.kind}/${page.slug}`
}

function clampHops(value) {
  if (value === undefined || value === null || value === '') return 2
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 4) return null
  return number
}
