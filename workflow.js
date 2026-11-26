/**
 * 摄入、查询、体检。模型调用和审批都由调用方注入，方便测试。
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { extractJson } from './llm.js'
import { applyPatch, validateIngest, validateLint, validateQuery } from './patch.js'
import { relationsOf } from './graph.js'
import { linksIn } from './pages.js'
import { acceptParsed, extensionOf } from './parsers.js'
import { presentSource } from './present.js'
import { MAX_SEGMENTS, SEGMENT_CHARS, segmentLocator, splitSource } from './split.js'
import { createRegistry } from './parsers.js'
import { appendLog, catalogOf, ensureWiki, hashBytes, SCHEMA_TEXT, writeRaw } from './store.js'
import { defaultEmbedder } from './embed.js'
import { retrieve } from './retrieve.js'

/** 单份原料的字节上限。再大就拒绝，不截断后假装读完。 */
export const MAX_SOURCE_BYTES = 2_000_000

/**
 * 读入一份材料，请模型给出补丁，批准后写入维基。
 */
export async function ingest(options) {
  const loaded = loadSource(options.input ?? {})
  if (!loaded.ok) return observe(loaded)
  const registry = options.registry ?? createRegistry()
  const parsed = loaded.parsed ?? registry.parse({
    path: options.input.path,
    text: loaded.text,
    bytes: loaded.bytes,
    mediaType: options.input.mediaType,
  })
  if (!parsed.ok) return observe(parsed)
  ensureWiki(options.root)
  const title = options.input.title || parsed.title
  const hash = hashBytes(loaded.bytes)
  const catalog = catalogOf(options.root)
  const pieceLimit = Math.min(options.maxChars ?? SEGMENT_CHARS, SEGMENT_CHARS)
  const split = splitSource(parsed.text, { maxChars: pieceLimit, maxSegments: options.maxSegments ?? MAX_SEGMENTS })
  const drafted = split.segments.length > 1 || split.omitted > 0
    ? await ingestSegments(options, { parsed, title, hash, catalog, split })
    : await ingestOne(options, { parsed, title, hash, catalog })
  if (!drafted.ok) return failAttempt(options, title, drafted)
  const names = drafted.pages.map((page) => `${page.kind}/${page.slug}`)
  const approved = await gate(options.approve, {
    zh: `把「${title}」写进知识维基，更新 ${names.join('、')}。原料不改。${drafted.partial ? '材料没有完整交给模型。' : ''}`,
    en: `File "${title}" into the wiki: ${names.join(', ')}. Raw sources stay unchanged.${drafted.partial ? ' The source was incomplete.' : ''}`,
  })
  if (!approved.ok) return failAttempt(options, title, approved)
  const raw = writeRaw(options.root, loaded.bytes, {
    ext: loaded.ext,
    title,
    mediaType: parsed.mediaType,
    parser: parsed.parser,
    origin: options.input.path || (parsed.foreign ? `parsed:${parsed.parser}` : ''),
  })
  const now = options.now?.() ?? new Date()
  applyPatch(options.root, { pages: drafted.pages, summary: drafted.summary }, {
    partial: false,
    updated: now.toISOString(),
    date: day(now),
    op: 'ingest',
    title,
  })
  return {
    ok: true,
    hash: raw.hash,
    pages: names,
    partial: drafted.partial,
    segments: drafted.segments ?? 1,
    model: drafted.model,
    approved: true,
    outcome: 'allowed-once',
  }
}

/** 短材料仍一次交给模型。 */
async function ingestOne(options, { parsed, title, hash, catalog }) {
  const presented = presentSource(parsed, { maxChars: options.maxChars })
  const messages = ingestMessages({ schema: readSchema(options.root), catalog, presented, hash, title })
  const checked = await draftPatch(options, messages, hash, existingMap(catalog.pages))
  if (!checked.ok) return checked
  const pages = presented.partial ? checked.pages.map((page) => ({ ...page, partial: true })) : checked.pages
  return { ok: true, pages, summary: checked.summary, partial: presented.partial, model: checked.model, segments: 1 }
}

/**
 * 长材料切成多段。每段单独请模型整理，但共用原料哈希和索引头。
 * 目录页把各段串起来。任何一段失败，整份材料都不落盘。
 */
async function ingestSegments(options, { parsed, title, hash, catalog, split }) {
  const parent = `src-${hash.slice(0, 10)}`
  const alias = sharedAlias(title)
  const existing = existingMap(catalog.pages)
  const pages = []
  let model = ''
  const images = presentSource(parsed, { maxChars: 0 }).images
  for (const segment of split.segments) {
    const slug = `${parent}-${segment.index}`
    const locator = segmentLocator(title, segment).slice(0, 180)
    const presented = {
      partial: false,
      images: segment.index === 1 ? images : [],
      text: `${locator}\n\n${segment.text}`,
    }
    const messages = ingestMessages({
      schema: readSchema(options.root),
      catalog,
      presented,
      hash,
      title,
      segment: { index: segment.index, total: segment.total, slug, locator, alias },
    })
    const checked = await draftPatch(options, messages, hash, existing, (pages) => pinSegment(pages, {
      slug,
      hash,
      title: segmentTitle(title, segment),
      locator,
      text: segment.text,
      alias,
      summary: segment.heading || title,
    }))
    if (!checked.ok) return checked
    const pinned = checked.pages
    for (const page of pinned) {
      existing.set(`${page.kind}/${page.slug}`, page)
      pages.push(page)
    }
    remember(catalog, pinned)
    model = checked.model || model
  }
  const index = indexPage({ parent, title, hash, alias, pages, omitted: split.omitted, total: split.segments.length })
  const indexChecked = validateIngest({ summary: index.summary, pages: [index] }, { hash, existing })
  if (!indexChecked.ok) return indexChecked
  const incomplete = split.omitted > 0 || parsed.partial === true
  const filedIndex = { ...indexChecked.pages[0], locator: index.locator, partial: incomplete }
  return {
    ok: true,
    pages: [filedIndex, ...pages],
    summary: `「${title}」分成 ${split.segments.length} 段`,
    partial: incomplete,
    model,
    segments: split.segments.length,
  }
}

/** 请模型写补丁。第一次不合格就按缺的字段再要一次。prepare 可在校验前改写页面。 */
async function draftPatch(options, messages, hash, existing, prepare) {
  let drafted = await askModel(options.complete, messages)
  if (!drafted.ok) return drafted
  const check = (value) => validateIngest(
    { ...value, pages: prepare ? prepare(value?.pages) : value?.pages },
    { hash, existing },
  )
  let checked = check(drafted.value)
  if (!checked.ok && checked.code === 'BAD_PATCH') {
    drafted = await askModel(options.complete, repairMessages(messages, checked, hash))
    if (!drafted.ok) return drafted
    checked = check(drafted.value)
  }
  if (!checked.ok) return checked
  return { ...checked, model: drafted.model }
}

/** 来源页固定到这一段的 slug，正文保留这段原文，别名带上整份材料的索引头。 */
function pinSegment(pages, segment) {
  const list = Array.isArray(pages) ? pages.filter((page) => page && typeof page === 'object') : []
  const rest = list.filter((page) => page.kind !== 'source')
  const source = list.find((page) => page.kind === 'source') ?? {
    kind: 'source',
    summary: String(segment.summary || segment.title).slice(0, 200),
    claims: [],
    contradicts: [],
    cites: [],
  }
  return [{
    ...source,
    kind: 'source',
    slug: segment.slug,
    title: segment.title.slice(0, 120),
    summary: String(source.summary || segment.summary || segment.title).slice(0, 200),
    body: segment.text.slice(0, 8000),
    locator: segment.locator,
    partial: segment.text.length > 8000,
    sources: [...new Set([segment.hash, ...(source.sources ?? [])])],
    aliases: uniqueLimited([segment.alias, ...(source.aliases ?? [])], 8),
    update: false,
  }, ...rest]
}

/** 整份材料共用的短索引头，方便以后用同一个名字找到每一段。 */
function sharedAlias(title) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 40) : ''
}

function segmentTitle(title, segment) {
  const suffix = `（${segment.index}/${segment.total}）`
  const head = String(title || segment.heading || '材料').trim()
  return `${head.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`
}

/** 目录页链到各段。没有纳入的尾巴只标在这一页上。 */
function indexPage({ parent, title, hash, alias, pages, omitted, total }) {
  const links = pages
    .filter((page) => page.kind === 'source')
    .map((page) => `- [[source/${page.slug}]] ${page.title}`)
  const tail = omitted > 0 ? `\n\n后面约 ${omitted} 字这一次没有纳入。` : ''
  return {
    kind: 'source',
    slug: parent,
    title: String(title || '材料').slice(0, 120),
    summary: (`共 ${total} 段${omitted > 0 ? '，后面还有未纳入的文字' : ''}`).slice(0, 200),
    body: `同一份材料，索引头相同。\n\n${links.join('\n')}${tail}`,
    sources: [hash],
    aliases: alias ? [alias] : [],
    claims: [],
    contradicts: [],
    cites: [],
    locator: String(title || '材料').slice(0, 180),
  }
}

/** 下一段还能看见这一段刚整理出来的页。 */
function remember(catalog, pages) {
  for (const page of pages) {
    catalog.pages.push(page)
    catalog.entries.push({
      id: `${page.kind}/${page.slug}`,
      title: page.title,
      summary: page.summary,
      aliases: page.aliases ?? [],
      claims: page.claims ?? [],
      sources: page.sources ?? [],
      cites: page.cites ?? [],
      contradicts: page.contradicts ?? [],
      relations: page.relations ?? [],
      partial: page.partial === true,
    })
  }
}

function uniqueLimited(items, max) {
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))].slice(0, max)
}

/**
 * 先取证再作答。词面、本地向量、邻页和冲突的另一面都进入证据。
 * 默认不写回。file 为 true 时才归档。embed 为 false 时不加载向量模型。
 */
export async function query(options) {
  const question = String(options.question ?? '').trim()
  if (!question) return { ok: false, code: 'NEED_QUESTION' }
  ensureWiki(options.root)
  const catalog = catalogOf(options.root)
  if (catalog.pages.length === 0) return { ok: false, code: 'EMPTY_WIKI' }
  const pages = attachImages(options.root, catalog.pages)
  const ranked = await retrieve(question, pages, {
    k: options.k ?? 10,
    hops: options.hops ?? 2,
    embed: embedFor(options),
    unit: options.unit ?? 'page',
    expand: options.embed === false || options.expand === false ? undefined : (text) => imagineEvidence(options.complete, text),
    rerank: options.semantic === false ? undefined : (_question, items) => semanticRerank(options.complete, question, items),
  })
  if (ranked.hits.length === 0) return { ok: false, code: 'NO_PAGES', coverage: ranked.coverage }
  const answered = await askModel(options.complete, answerMessages(question, ranked.hits))
  if (!answered.ok) return { ...answered, hits: publicHits(ranked.hits), coverage: ranked.coverage }
  const allowed = new Set(ranked.hits.map((hit) => hit.page))
  const citations = unique(answered.value?.citations).map(pageOf).filter((id) => allowed.has(id))
  if (citations.length === 0) return { ok: false, code: 'UNCITED', hits: publicHits(ranked.hits), conflicts: ranked.conflicts }
  const answer = limit(answered.value?.answer, 8000)
  if (!answer) return { ok: false, code: 'BAD_PATCH', hits: publicHits(ranked.hits) }
  const result = {
    ok: true,
    answer,
    citations,
    hits: publicHits(ranked.hits),
    conflicts: ranked.conflicts,
    coverage: ranked.coverage,
    embedding: ranked.embedding,
    model: answered.model,
  }
  if (options.file !== true) return result
  const filed = validateQuery({
    kind: 'query',
    slug: answered.value?.slug,
    title: answered.value?.title,
    summary: answered.value?.summary,
    body: answered.value?.body || answer,
    cites: citations,
    contradicts: [],
    sources: [],
  }, { read: allowed, existing: existingMap(catalog.pages) })
  if (!filed.ok) return { ...filed, ...result, ok: false }
  const approved = await gate(options.approve, {
    zh: `把这个问题收成 ${filed.page.kind}/${filed.page.slug}。`,
    en: `File this answer as ${filed.page.kind}/${filed.page.slug}.`,
  })
  if (!approved.ok) return { ...approved, answer, citations, hits: result.hits, conflicts: result.conflicts, approved: false }
  const now = options.now?.() ?? new Date()
  applyPatch(options.root, { pages: [filed.page], summary: filed.page.summary }, {
    partial: false,
    updated: now.toISOString(),
    date: day(now),
    op: 'query',
    title: filed.page.title,
  })
  return { ...result, filed: `${filed.page.kind}/${filed.page.slug}`, approved: true, outcome: 'allowed-once' }
}

/**
 * 先做不调用模型的检查。apply 为 true 时才请模型改已有页面。
 */
export async function lint(options) {
  ensureWiki(options.root)
  const catalog = catalogOf(options.root)
  const local = localFindings(catalog.pages)
  if (catalog.pages.length === 0) {
    return { ok: false, code: 'EMPTY_WIKI', findings: [{ code: 'EMPTY_WIKI', message: '无页面可检查' }], applied: false }
  }
  if (options.apply !== true) return { ok: true, findings: local, applied: false }
  const drafted = await askModel(options.complete, lintMessages(readSchema(options.root), catalog, local))
  if (!drafted.ok) return { ...observe(drafted), findings: local }
  const checked = validateLint(drafted.value, { existing: existingMap(catalog.pages) })
  if (!checked.ok) return { ...observe(checked), findings: local }
  const names = checked.pages.map((page) => `${page.kind}/${page.slug}`)
  const approved = await gate(options.approve, {
    zh: `按体检结果修改 ${names.join('、')}。不新建页面，也不删除依据。`,
    en: `Apply the lint to ${names.join(', ')}. No new pages and no dropped sources.`,
  })
  if (!approved.ok) return { ...approved, findings: local, approved: false }
  const previous = existingMap(catalog.pages)
  checked.pages = checked.pages.map((page) => ({
    ...page,
    partial: previous.get(`${page.kind}/${page.slug}`)?.partial === true,
  }))
  const now = options.now?.() ?? new Date()
  applyPatch(options.root, checked, {
    partial: false,
    updated: now.toISOString(),
    date: day(now),
    op: 'lint',
    title: '体检',
  })
  return { ok: true, findings: local, pages: names, applied: true, model: drafted.model, approved: true, outcome: 'allowed-once' }
}

/** 不调用模型也能看出的问题。 */
export function localFindings(pages) {
  const ids = new Set(pages.map((page) => `${page.kind}/${page.slug}`))
  const inbound = new Set()
  const findings = []
  for (const page of pages) {
    const id = `${page.kind}/${page.slug}`
    if (page.partial) findings.push({ code: 'PARTIAL', id })
    for (const target of page.contradicts ?? []) {
      if (!ids.has(target)) findings.push({ code: 'MISSING_CONTRADICTION', id, target })
    }
    for (const target of linksIn(page.body)) {
      if (target !== id) inbound.add(target)
      if (!ids.has(target)) findings.push({ code: 'BROKEN_LINK', id, target })
    }
    for (const relation of relationsOf(page)) {
      if (ids.has(relation.to)) inbound.add(relation.to)
      else findings.push({ code: 'MISSING_RELATION', id, target: relation.to, type: relation.type })
    }
  }
  for (const id of ids) {
    // 来源页是材料入口，没有别的页指向它是正常的。
    if (id.startsWith('source/')) continue
    if (!inbound.has(id)) findings.push({ code: 'ORPHAN', id, message: '无其他页引用' })
  }
  return findings
}

async function askModel(complete, messages) {
  if (typeof complete !== 'function') return { ok: false, code: 'NO_MODEL' }
  const result = await complete(messages)
  if (!result?.ok) return result ?? { ok: false, code: 'NO_MODEL' }
  const value = extractJson(result.text)
  if (!value) {
    const text = String(result.text ?? '').slice(0, 180)
    return { ok: false, code: 'BAD_PATCH', field: 'json', value: text, rule: '一个 JSON 对象', message: text }
  }
  return { ok: true, value, model: result.model }
}

async function gate(approve, copy) {
  if (typeof approve !== 'function') return { ok: false, code: 'NOT_APPROVED', approved: false, outcome: 'unavailable' }
  let outcome = 'unavailable'
  try { outcome = await approve(copy) } catch { outcome = 'unavailable' }
  if (outcome !== 'allowed-once') return { ok: false, code: 'NOT_APPROVED', approved: false, outcome }
  return { ok: true, approved: true, outcome: 'allowed-once' }
}

/** 还没问过能不能写时，把结果标成未批准。 */
function observe(result) {
  if (result.approved !== undefined) return result
  return { ...result, approved: false, outcome: result.outcome ?? 'not-asked' }
}

/** 模型、校验或批准失败时只记日志，不写原料。 */
function failAttempt(options, title, result) {
  const now = options.now?.() ?? new Date()
  const message = typeof result.message === 'string' ? result.message.slice(0, 200) : ''
  const detail = result.field
    ? `失败 ${result.code ?? 'FAILED'} ${result.field}=${result.value ?? ''} rule=${result.rule ?? ''}`
    : `失败 ${result.code ?? 'FAILED'}${message ? ` ${message}` : ''}`
  appendLog(options.root, {
    date: day(now),
    op: 'ingest',
    title,
    detail,
  })
  return observe(result)
}

function loadSource(input) {
  const hasPath = Boolean(input.path)
  const hasText = input.text !== undefined && input.text !== null && input.text !== ''
  const hasParsed = input.parsed !== undefined && input.parsed !== null && input.parsed !== ''
  if ([hasPath, hasText, hasParsed].filter(Boolean).length > 1) return { ok: false, code: 'BOTH_SOURCE' }
  if (hasParsed) return loadParsed(input.parsed)
  if (input.path && input.text !== undefined) return { ok: false, code: 'BOTH_SOURCE' }
  if (input.text !== undefined) {
    const bytes = Buffer.from(String(input.text))
    if (bytes.length > MAX_SOURCE_BYTES) return { ok: false, code: 'TOO_LARGE', bytes: bytes.length }
    return { ok: true, bytes, text: String(input.text), ext: extFromMedia(input.mediaType) || '.txt' }
  }
  if (!input.path) return { ok: false, code: 'NEED_SOURCE' }
  let stat
  try { stat = statSync(input.path) } catch { return { ok: false, code: 'NOT_A_FILE' } }
  if (!stat.isFile()) return { ok: false, code: 'NOT_A_FILE' }
  if (stat.size > MAX_SOURCE_BYTES) return { ok: false, code: 'TOO_LARGE', bytes: stat.size }
  const bytes = readFileSync(input.path)
  return { ok: true, bytes, text: bytes.toString('utf8'), ext: extensionOf(input.path) || '.bin' }
}

/** 其他插件交来的解析成果。原始字节优先，没有则保存整理后的文本。 */
function loadParsed(value) {
  let document = value
  if (typeof value === 'string') {
    try { document = JSON.parse(value) } catch { return { ok: false, code: 'BAD_PARSE', message: 'json' } }
  }
  const accepted = acceptParsed(document)
  if (!accepted.ok) return accepted
  if (accepted.rawBytes.length > MAX_SOURCE_BYTES) return { ok: false, code: 'TOO_LARGE', bytes: accepted.rawBytes.length }
  return { ok: true, bytes: accepted.rawBytes, text: accepted.text, ext: accepted.rawExt, parsed: accepted }
}

function embedFor(options) {
  if (options.embed === false) return undefined
  if (typeof options.embed === 'function') return options.embed
  return defaultEmbedder(path.join(options.root, '.cache', 'embeddings'))
}

function existingMap(pages) {
  return new Map(pages.map((page) => [`${page.kind}/${page.slug}`, page]))
}

function readSchema(root) {
  let text = SCHEMA_TEXT
  try { text = readFileSync(`${root}/schema.md`, 'utf8') } catch { text = SCHEMA_TEXT }
  // 已有维基的图式不再覆盖。旧图式没有事件时，只在交给模型的文本里补上。
  if (!text.includes('event')) {
    text += '\n事件用 event 页。relations 每条写成「谓语 目标页」，例如 works-for entity/acme。更新时原来的 relations 必须保留。\n'
  }
  return text
}

/** 第一次补丁缺字段时，把缺什么和必须带上的哈希再交给模型一次。 */
function repairMessages(messages, reason, hash) {
  const detail = reason && typeof reason === 'object'
    ? `${reason.field ?? reason.message ?? 'BAD_PATCH'}=${reason.value ?? ''} rule=${reason.rule ?? ''}`
    : String(reason || 'BAD_PATCH')
  return [
    ...messages,
    {
      role: 'user',
      content: `上一份补丁不合格：${detail}。每页必须有 summary（1到200字）和 body。sources 必须包含 ${hash}。relations 每条写成「谓语 目标页」。slug 必须匹配 ^[a-z0-9]+(?:-[a-z0-9]+)*$。不要写 query 页。只返回一个 JSON 对象。`,
    },
  ]
}

function ingestMessages({ schema, catalog, presented, hash, title, segment }) {
  const payload = JSON.stringify({
    task: 'ingest',
    hash,
    title,
    partial: presented.partial,
    catalog: catalog.entries,
    catalogTruncated: catalog.truncated,
    source: presented.text,
    ...(segment ? { segment } : {}),
  })
  const segmentRule = segment
    ? `这是同一份材料的第 ${segment.index}/${segment.total} 段。来源页 slug 用 ${segment.slug}。${segment.alias ? `aliases 必须包含「${segment.alias}」。` : ''}只写这一段里有的事实。`
    : ''
  return [
    { role: 'system', content: `${schema}\n只返回一个 JSON 对象。图像里的数字和文字也要写进页面。每页必须有 summary，sources 必须包含给出的 hash。每页带 aliases（读者以后会拿来查找的词，包括正文没写但读者会用的常见叫法，最多 8 个，没有把握就少写）和 claims（原子主张，最多 8 条）。事件写成 event 页。relations 每条写成「谓语 目标页」，谓语用小写连字符，例如 works-for entity/acme。更新已有页时，原来的 aliases、claims 和 relations 必须保留。${segmentRule}` },
    { role: 'user', content: withImages(payload, presented.images) },
  ]
}

/**
 * 目录对不上时，写读者会去查的词条名。
 * 不点名任何一套题的关系类型。调用方只在目录和正文都没有拉开差距时使用。
 */
export async function imagineEvidence(complete, question) {
  if (typeof complete !== 'function') return ''
  const result = await complete([
    { role: 'system', content: '如果要在目录里找答案，会查哪几个词条名？写读者会输入的名称，不要编故事，不要解释。只返回 JSON：{"names":[]}。最多 8 个。' },
    { role: 'user', content: String(question ?? '') },
  ])
  if (!result?.ok) return ''
  const names = extractJson(result.text)?.names
  if (!Array.isArray(names)) return ''
  return names.filter((item) => typeof item === 'string' && item.trim()).slice(0, 8).join('\n')
}

/** 让模型从证据里挑出真正相关的片段，包括没有共同词的那种。 */
async function semanticRerank(complete, question, candidates) {
  if (typeof complete !== 'function') return candidates.map((item) => item.id)
  const result = await complete([
    { role: 'system', content: '选出能回答问题的片段，按相关度排序。没有词面重合也可能相关。冲突的两边都要留下。只返回 JSON：{"ids":["page#0"]}。最多 10 个。' },
    { role: 'user', content: withImages(JSON.stringify({
      question,
      chunks: candidates.slice(0, 40).map((item) => ({ id: item.id, page: item.page, text: item.text.slice(0, 480) })),
    }), candidates.flatMap((item) => item.images ?? []).slice(0, 4)) },
  ])
  if (!result?.ok) return candidates.map((item) => item.id)
  return extractJson(result.text)?.ids ?? candidates.map((item) => item.id)
}

function answerMessages(question, hits) {
  return [
    { role: 'system', content: '只根据给出的证据作答。证据不足就说明不足。若证据互相冲突，两边都写上。如果多条证据一致、只有一条相反，答案采用多数的那一边，并注明相反的说法。返回 JSON：{"answer":"","citations":["source/page"],"slug":"","title":"","summary":"","body":""}。citations 必须来自证据。' },
    { role: 'user', content: withImages(JSON.stringify({
      question,
      evidence: hits.map((hit) => ({ id: hit.id, page: hit.page, text: String(hit.text ?? '').slice(0, 6000), conflict: hit.conflict === true })),
    }), hits.flatMap((hit) => hit.images ?? []).slice(0, 4)) },
  ]
}

/** 有图像时按视觉接口把像素和文本放在同一条消息里。 */
function withImages(text, images) {
  const attached = (images ?? []).filter((image) => image?.base64)
  if (attached.length === 0) return text
  return [
    { type: 'text', text },
    ...attached.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mediaType || 'image/png'};base64,${image.base64}` },
    })),
  ]
}

/** 来源哈希如果指向图像，查询时把像素附回页面。 */
function attachImages(root, pages) {
  return pages.map((page) => {
    const images = []
    for (const hash of page.sources ?? []) {
      try {
        const meta = JSON.parse(readFileSync(path.join(root, 'raw', `${hash}.meta.json`), 'utf8'))
        if (!String(meta.mediaType ?? '').startsWith('image/')) continue
        const bytes = readFileSync(path.join(root, 'raw', meta.file))
        images.push({ mediaType: meta.mediaType, base64: bytes.toString('base64') })
      } catch {
        // 没有对应像素就不附。
      }
    }
    return images.length > 0 ? { ...page, images: images.slice(0, 4) } : page
  })
}

function publicHits(hits) {
  return hits.map((hit) => ({ id: hit.id, page: hit.page, score: hit.score, conflict: hit.conflict === true }))
}

function pageOf(id) {
  return String(id ?? '').split('#')[0]
}

function lintMessages(schema, catalog, findings) {
  return [
    { role: 'system', content: `${schema}\n只修改已有页面，sources、cites 和 relations 必须原样保留或只增加。只返回 JSON：{"summary":"","pages":[]}。` },
    { role: 'user', content: JSON.stringify({ findings, catalog: catalog.entries }) },
  ]
}

function unique(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => typeof item === 'string'))]
}

function limit(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function day(date) {
  return date.toISOString().slice(0, 10)
}

function extFromMedia(mediaType) {
  return {
    'text/html': '.html',
    'text/csv': '.csv',
    'application/json': '.json',
    'text/markdown': '.md',
    'text/plain': '.txt',
  }[mediaType] ?? ''
}
