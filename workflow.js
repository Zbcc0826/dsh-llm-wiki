/**
 * 摄入、查询、体检。模型调用和审批都由调用方注入，方便测试。
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { extractJson } from './llm.js'
import { applyPatch, validateIngest, validateLint, validateQuery } from './patch.js'
import { extensionOf } from './parsers.js'
import { presentSource } from './present.js'
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
  const parsed = registry.parse({
    path: options.input.path,
    text: loaded.text,
    bytes: loaded.bytes,
    mediaType: options.input.mediaType,
  })
  if (!parsed.ok) return observe(parsed)
  ensureWiki(options.root)
  const title = options.input.title || parsed.title
  const hash = hashBytes(loaded.bytes)
  const presented = presentSource(parsed, { maxChars: options.maxChars })
  const catalog = catalogOf(options.root)
  const messages = ingestMessages({
    schema: readSchema(options.root),
    catalog,
    presented,
    hash,
    title,
  })
  let drafted = await askModel(options.complete, messages)
  if (!drafted.ok) return failAttempt(options, title, drafted)
  let checked = validateIngest(drafted.value, { hash, existing: existingMap(catalog.pages) })
  if (!checked.ok && checked.code === 'BAD_PATCH') {
    drafted = await askModel(options.complete, repairMessages(messages, checked.message || 'BAD_PATCH', hash))
    if (!drafted.ok) return failAttempt(options, title, drafted)
    checked = validateIngest(drafted.value, { hash, existing: existingMap(catalog.pages) })
  }
  if (!checked.ok) return failAttempt(options, title, checked)
  const names = checked.pages.map((page) => `${page.kind}/${page.slug}`)
  const approved = await gate(options.approve, {
    zh: `把「${title}」写进知识维基，更新 ${names.join('、')}。原料不改。${presented.partial ? '材料没有完整交给模型。' : ''}`,
    en: `File "${title}" into the wiki: ${names.join(', ')}. Raw sources stay unchanged.${presented.partial ? ' The source was incomplete.' : ''}`,
  })
  if (!approved.ok) return failAttempt(options, title, approved)
  const raw = writeRaw(options.root, loaded.bytes, {
    ext: loaded.ext,
    title,
    mediaType: parsed.mediaType,
    parser: parsed.parser,
    origin: options.input.path || '',
  })
  const now = options.now?.() ?? new Date()
  applyPatch(options.root, checked, {
    partial: presented.partial,
    updated: now.toISOString(),
    date: day(now),
    op: 'ingest',
    title,
  })
  return { ok: true, hash: raw.hash, pages: names, partial: presented.partial, model: drafted.model, approved: true, outcome: 'allowed-once' }
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
  }
  for (const id of ids) {
    if (!inbound.has(id)) findings.push({ code: 'ORPHAN', id })
  }
  return findings
}

async function askModel(complete, messages) {
  if (typeof complete !== 'function') return { ok: false, code: 'NO_MODEL' }
  const result = await complete(messages)
  if (!result?.ok) return result ?? { ok: false, code: 'NO_MODEL' }
  const value = extractJson(result.text)
  if (!value) return { ok: false, code: 'BAD_PATCH', message: String(result.text ?? '').slice(0, 400) }
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
  appendLog(options.root, {
    date: day(now),
    op: 'ingest',
    title,
    detail: `失败 ${result.code ?? 'FAILED'}${message ? ` ${message}` : ''}`,
  })
  return observe(result)
}

function loadSource(input) {
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

function embedFor(options) {
  if (options.embed === false) return undefined
  if (typeof options.embed === 'function') return options.embed
  return defaultEmbedder(path.join(options.root, '.cache', 'embeddings'))
}

function existingMap(pages) {
  return new Map(pages.map((page) => [`${page.kind}/${page.slug}`, page]))
}

function readSchema(root) {
  try { return readFileSync(`${root}/schema.md`, 'utf8') } catch { return SCHEMA_TEXT }
}

/** 第一次补丁缺字段时，把缺什么和必须带上的哈希再交给模型一次。 */
function repairMessages(messages, reason, hash) {
  return [
    ...messages,
    {
      role: 'user',
      content: `上一份补丁不合格：${reason}。每页必须有 summary（1到200字）和 body。sources 必须包含 ${hash}。不要写 query 页。只返回一个 JSON 对象。`,
    },
  ]
}

function ingestMessages({ schema, catalog, presented, hash, title }) {
  const payload = JSON.stringify({
    task: 'ingest',
    hash,
    title,
    partial: presented.partial,
    catalog: catalog.entries,
    catalogTruncated: catalog.truncated,
    source: presented.text,
  })
  return [
    { role: 'system', content: `${schema}\n只返回一个 JSON 对象。图像里的数字和文字也要写进页面。每页必须有 summary，sources 必须包含给出的 hash。每页带 aliases（读者以后会拿来查找的词，包括正文没写但读者会用的常见叫法，最多 8 个，没有把握就少写）和 claims（原子主张，最多 8 条）。更新已有页时，原来的 aliases 和 claims 必须保留。` },
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
    { role: 'system', content: `${schema}\n只修改已有页面，sources 和 cites 必须原样保留。只返回 JSON：{"summary":"","pages":[]}。` },
    { role: 'user', content: JSON.stringify({ findings, catalog: catalog.entries }) },
  ]
}

function linksIn(body) {
  return [...String(body ?? '').matchAll(/\[\[(source|entity|concept|query)\/([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g)]
    .map((match) => `${match[1]}/${match[2]}`)
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
