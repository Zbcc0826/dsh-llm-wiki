/**
 * 取证。词面、本地向量、图上的邻页、冲突的另一面，以及对话模型对候选片段的重排，合成最多 10 条证据。
 */
import { relationNeighbors } from './graph.js'
import { linksIn } from './pages.js'

/** 词面和向量各自先留这么多条，再做链接扩展。 */
const RECALL_KEEP = 24

/** 第一名至少是第二名的这么多倍，才算目录或正文已经锁定，不再换词条名。 */
const LEAD_RATIO = 2

const STOP = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'with',
  'which', 'who', 'whom', 'whose', 'what', 'when', 'where', 'why', 'how',
  'has', 'have', 'had', 'been', 'being', 'be', 'that', 'this', 'these', 'those',
  'it', 'its', 'or', 'as', 'at', 'by', 'from', 'into', 'about', 'than', 'then',
  'there', 'their', 'them', 'they', 'he', 'she', 'his', 'her', 'you', 'your', 'we', 'our',
  'not', 'no', 'nor', 'but', 'if', 'so', 'do', 'does', 'did', 'can', 'could', 'would', 'should',
  'may', 'might', 'will', 'just', 'over', 'after', 'before', 'between', 'out', 'up',
  'such', 'only', 'also', 'any', 'all', 'each', 'both', 'few', 'more', 'most', 'other', 'some',
])

/** 同一批页面反复提问时不重新分词。页面数组换了就会失效。 */
const preparedCache = new WeakMap()

/**
 * 把页面切成可引用的片段。按句子打包，不把一句证据切成两半。
 * 相邻片段重叠最后一句，跨句的证据仍能整句出现。
 * locator 写在每段前面，日期和出处才能跟正文一起被词面命中。
 */
export function chunkPages(pages, size = 480) {
  const chunks = []
  for (const page of pages ?? []) {
    const id = `${page.kind}/${page.slug}`
    const images = page.images ?? []
    const locator = String(page.locator ?? '').trim()
    const decorate = (text) => (locator ? `${locator}\n${text}` : text)
    if (images.length > 0 && !String(page.body ?? '').trim()) {
      chunks.push(makeChunk(page, `${id}#0`, decorate(`[图像 ${page.title}]`), images))
      continue
    }
    const paragraphs = String(page.body ?? '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
    const sentences = []
    for (const paragraph of paragraphs.length > 0 ? paragraphs : []) {
      const parts = paragraph.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean)
      sentences.push(...(parts.length > 0 ? parts : [paragraph]))
    }
    let index = 0
    for (const group of packSentences(sentences, size)) {
      chunks.push(makeChunk(page, `${id}#${index}`, decorate(group), index === 0 ? images : []))
      index += 1
    }
    const card = [...(page.aliases ?? []), ...(page.claims ?? [])].map((item) => String(item).trim()).filter(Boolean)
    if (card.length > 0) chunks.push(makeChunk(page, `${id}#claim`, card.join('\n'), []))
  }
  return chunks
}

/** 句子装进不超过 size 的片段，下一片段从上一句接上。 */
function packSentences(sentences, size) {
  const groups = []
  let bucket = []
  let length = 0
  const emit = () => {
    if (bucket.length === 0) return
    groups.push(bucket.join(' '))
    const carry = bucket[bucket.length - 1]
    bucket = carry.length < size ? [carry] : []
    length = bucket.reduce((sum, item) => sum + item.length, 0)
  }
  for (const sentence of sentences) {
    if (bucket.length > 0 && length + sentence.length + 1 > size) emit()
    bucket.push(sentence)
    length += sentence.length + 1
  }
  if (bucket.length > 0) groups.push(bucket.join(' '))
  return groups
}

/**
 * 返回按相关度排好的证据。gold 是否出现在前 k 条，用 hitsAtK 算。
 * 人查 wiki 先看目录卡片，再打开少数几页，顺着链接看一页。
 * embed 用来找回没有共同词的页。rerank 看的是证据句。
 */
export async function retrieve(question, pages, options = {}) {
  const prepared = prepare(pages, options.chunkSize)
  const chunks = prepared.chunks
  if (chunks.length === 0) return { hits: [], coverage: 'empty', conflicts: [], embedding: 'off' }
  const primary = scoreIndexed(question, prepared)
  // 目录卡片和正文分开打分。换词条名时也不和原问题焊在同一次打分里。
  const { lexical, queries, lexicalLeads } = await expandedQuery(question, primary, prepared, pages, options)
  if (options.unit === 'page') {
    const reps = []
    for (const item of pages ?? []) reps.push(...pageWindows(item, chunks))
    const embedded = await semanticVectors(queries, reps, options.embed)
    return finishPages(question, pages, chunks, lexical, embedded, { ...options, lexicalLeads })
  }
  const embedded = await semanticVectors(queries, chunks, options.embed)
  const embedScores = embedded.scores
  let maxLex = 0
  for (const chunk of chunks) {
    const value = lexical.get(chunk.id) ?? 0
    if (value > maxLex) maxLex = value
  }
  const rankScore = (chunk) => {
    const lex = lexical.get(chunk.id) ?? 0
    if (!embedScores) return lex
    const lexNorm = maxLex > 0 ? lex / maxLex : 0
    let semantic = Math.max(0, embedScores.get(chunk.id) ?? 0)
    if (chunk.partial) semantic *= 0.45
    return 0.45 * lexNorm + 0.55 * semantic
  }
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const ranked = [...chunks].sort((left, right) => (lexical.get(right.id) ?? 0) - (lexical.get(left.id) ?? 0))
  const byVector = embedScores
    ? [...chunks].sort((left, right) => (embedScores.get(right.id) ?? 0) - (embedScores.get(left.id) ?? 0))
    : []
  const scanLimit = options.scanLimit ?? 40
  const pool = []
  const take = (chunk, score) => {
    if (!chunk) return
    const existing = pool.find((item) => item.id === chunk.id)
    if (existing) {
      if (score > existing.score) existing.score = score
      return
    }
    pool.push({ ...chunk, score })
  }
  for (const chunk of ranked.slice(0, RECALL_KEEP)) take(chunk, rankScore(chunk))
  for (const chunk of byVector.slice(0, RECALL_KEEP)) take(chunk, rankScore(chunk))
  for (const chunk of expand(pool, pages, byId, options.hops ?? 2)) take(chunk, rankScore(chunk) + 0.15)
  for (const chunk of chunks.filter((item) => item.images.length > 0).slice(0, 4)) take(chunk, rankScore(chunk))
  let coverage = chunks.length <= scanLimit ? 'full' : 'partial'
  if (coverage === 'full') {
    for (const chunk of chunks) take(chunk, rankScore(chunk))
  } else if (embedScores) {
    coverage = 'embedded'
  }
  let ordered = pool.sort((left, right) => right.score - left.score)
  if (embedScores) {
    const preferred = new Set(byVector.slice(0, RECALL_KEEP).map((chunk) => chunk.id))
    const front = ordered.filter((chunk) => preferred.has(chunk.id))
    const rest = ordered.filter((chunk) => !preferred.has(chunk.id))
    ordered = [...front, ...rest]
  }
  if (typeof options.rerank === 'function') {
    const picked = await options.rerank(question, ordered)
    const ids = Array.isArray(picked) ? picked : []
    const front = []
    const used = new Set()
    for (const id of ids) {
      const chunk = ordered.find((item) => item.id === id || item.page === id)
      if (!chunk || used.has(chunk.id)) continue
      used.add(chunk.id)
      front.push(chunk)
    }
    ordered = [...front, ...ordered.filter((item) => !used.has(item.id))]
  }
  const hits = withConflicts(ordered, pages, byId, options.k ?? 10)
  return { hits, coverage, conflicts: conflictPairs(hits), embedding: embedded.state }
}

/** 标准 Hits@k：标准答案里有多少比例出现在前 k 条。 */
export function hitsAtK(hits, gold, k = 10) {
  const top = (hits ?? []).slice(0, k)
  const wanted = gold ?? []
  if (wanted.length === 0) return 0
  const found = wanted.filter((id) => top.some((hit) => hit.id === id || hit.page === id || hit.id.startsWith(`${id}#`)))
  return found.length / wanted.length
}

/**
 * 给全部片段打向量分。失败时退回词面，不让查询中断。
 * 几个问句分开编码，片段取得分最高的那一个，避免把猜出来的句子和原问题焊成一段。
 */
async function semanticVectors(questions, chunks, embed) {
  const queries = (Array.isArray(questions) ? questions : [questions]).map((item) => String(item ?? '')).filter(Boolean)
  if (typeof embed !== 'function' || queries.length === 0) return { scores: null, state: 'off' }
  try {
    const texts = [...queries]
    const kinds = queries.map(() => 'query')
    for (const chunk of chunks) {
      texts.push(chunk.text)
      kinds.push('passage')
    }
    const rows = await embed(texts, { kinds })
    if (!Array.isArray(rows) || rows.length !== texts.length || !rows[0]?.length) return { scores: null, state: 'unavailable' }
    const scores = new Map()
    chunks.forEach((chunk, index) => {
      let best = 0
      for (let query = 0; query < queries.length; query += 1) {
        const score = cosine(rows[query], rows[queries.length + index])
        if (score > best) best = score
      }
      scores.set(chunk.id, best)
    })
    return { scores, state: 'on' }
  } catch {
    return { scores: null, state: 'unavailable' }
  }
}

/**
 * 长页不能只看开头。沿正文取最多 4 个窗口，向量用其中最接近问句的那个。
 * 窗口太少会漏掉后文；每句都编码则太慢。
 */
function pageWindows(page, chunks) {
  const id = `${page.kind}/${page.slug}`
  const local = chunks.filter((chunk) => chunk.page === id && !chunk.id.endsWith('#claim'))
  const picked = spread(local, 4)
  if (picked.length === 0) {
    return [makeChunk(
      page,
      `${id}#page0`,
      [page.title, page.locator, String(page.body ?? '').slice(0, 1500)].filter(Boolean).join('\n'),
      page.images ?? [],
    )]
  }
  return picked.map((chunk, index) => makeChunk(
    page,
    `${id}#page${index}`,
    [page.title, page.locator, chunk.text].filter(Boolean).join('\n'),
    index === 0 ? (page.images ?? []) : [],
  ))
}

/** 从头到尾均匀取 limit 个片段，始终包含最后一段。 */
function spread(chunks, limit) {
  if (chunks.length <= limit) return chunks
  const picks = []
  const seen = new Set()
  for (let index = 0; index < limit; index += 1) {
    const at = Math.round((index * (chunks.length - 1)) / (limit - 1))
    if (seen.has(at)) continue
    seen.add(at)
    picks.push(chunks[at])
  }
  return picks
}

/**
 * 词面有没有拉开差距。并列的弱命中（例如书里随便出现两次的虚词）不算锁定。
 * 只有一页命中，或者第一名至少是第二名的两倍，才算锁定。
 */
function clearLead(lexical, chunks) {
  let best = 0
  let second = 0
  const byPage = new Map()
  for (const chunk of chunks) {
    const score = lexical.get(chunk.id) ?? 0
    const prev = byPage.get(chunk.page) ?? 0
    if (score > prev) byPage.set(chunk.page, score)
  }
  for (const score of byPage.values()) {
    if (score > best) {
      second = best
      best = score
    } else if (score > second) second = score
  }
  return best > 0 && (second === 0 || best >= second * LEAD_RATIO)
}

/** 目录卡片：标题、摘要、别名、主张。人不先读正文。 */
function catalogIndex(pages) {
  const chunks = []
  for (const page of pages ?? []) {
    const text = [page.title, page.summary, ...(page.aliases ?? []), ...(page.claims ?? [])]
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .join('\n')
    if (!text) continue
    chunks.push(makeChunk(page, `${page.kind}/${page.slug}#card`, text, []))
  }
  return { chunks, ...buildIndex(chunks) }
}

/** 卡片命中加到该页每一段上，让词条名压过正文里顺带出现的同一个词。 */
function withCards(lexical, chunks, cardScores) {
  const byPage = new Map()
  for (const [id, score] of cardScores) byPage.set(id.replace(/#card$/, ''), score)
  const out = new Map(lexical)
  for (const chunk of chunks) {
    const card = byPage.get(chunk.page) ?? 0
    if (card > 0) out.set(chunk.id, (out.get(chunk.id) ?? 0) + card * 2)
  }
  return out
}

/**
 * 原问题已经在目录或正文里拉开差距时，不换词条名。
 * 没有拉开时，换一组读者会去查的名称，单独打分后再和原问题取较高的一段。
 */
async function expandedQuery(question, primary, prepared, pages, options) {
  const cards = catalogIndex(pages)
  const queries = [question]
  const base = withCards(primary, prepared.chunks, scoreIndexed(question, cards))
  const leads = clearLead(base, prepared.chunks)
  if (typeof options.expand !== 'function' || leads) return { lexical: base, queries, lexicalLeads: leads }
  let extra = ''
  try { extra = String(await options.expand(question) ?? '').trim() } catch { extra = '' }
  if (!extra || extra === question) return { lexical: base, queries, lexicalLeads: false }
  queries.push(extra)
  const secondary = withCards(scoreIndexed(extra, prepared), prepared.chunks, scoreIndexed(extra, cards))
  const lexical = new Map(base)
  for (const [id, value] of secondary) {
    if (value > (lexical.get(id) ?? 0)) lexical.set(id, value)
  }
  return { lexical, queries, lexicalLeads: clearLead(lexical, prepared.chunks) }
}

/** 人打开最靠前的几页后，会顺着正文里的链接再看一页。 */
function bringSeeAlso(ordered, pages) {
  const byPage = new Map((pages ?? []).map((page) => [`${page.kind}/${page.slug}`, page]))
  const byHit = new Map(ordered.map((hit) => [hit.page, hit]))
  const seeds = new Set(ordered.slice(0, 3).map((hit) => hit.page))
  const result = []
  const placed = new Set()
  const place = (hit) => {
    if (!hit || placed.has(hit.page)) return
    placed.add(hit.page)
    result.push(hit)
  }
  for (const hit of ordered) {
    place(hit)
    if (!seeds.has(hit.page)) continue
    const page = byPage.get(hit.page)
    if (!page) continue
    for (const id of linksIn(page.body)) place(byHit.get(id))
  }
  return result
}

function cosine(left, right) {
  if (!left || !right || left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm)
  return denom === 0 ? 0 : dot / denom
}

function makeChunk(page, id, text, images) {
  return {
    id,
    page: `${page.kind}/${page.slug}`,
    title: page.title,
    text,
    partial: page.partial === true,
    contradicts: page.contradicts ?? [],
    images: images ?? [],
  }
}

/** 一页有多个窗口时，取和问句最接近的那个。 */
function semanticOf(embedScores, pageId) {
  if (!embedScores) return 0
  let best = 0
  const prefix = `${pageId}#page`
  for (const [key, value] of embedScores) {
    if (key.startsWith(prefix) && value > best) best = value
  }
  return best
}

/**
 * 按页取证。一页的分数是它最高的那一段。
 * 返回的正文是命中段加上整页，证据句不必正好落在得分最高的那一段里。
 */
async function finishPages(question, pages, chunks, lexical, embedded, options) {
  const embedScores = embedded.scores
  let maxLex = 0
  const bestLex = new Map()
  const bestChunk = new Map()
  for (const chunk of chunks) {
    const lex = lexical.get(chunk.id) ?? 0
    if (lex > maxLex) maxLex = lex
    const prev = bestLex.get(chunk.page) ?? -1
    if (lex > prev) {
      bestLex.set(chunk.page, lex)
      bestChunk.set(chunk.page, chunk)
    }
  }
  let ordered = (pages ?? []).map((item) => {
    const id = `${item.kind}/${item.slug}`
    const lex = bestLex.get(id) ?? 0
    const chunk = bestChunk.get(id)
    const lexNorm = maxLex > 0 ? lex / maxLex : 0
    const semantic = semanticOf(embedScores, id)
    // 有稀有词命中时，向量只作小幅调整。全是常见词时改由向量排序。
    const lexicalLeads = options.lexicalLeads === true
    const score = !embedScores ? lex : lexicalLeads ? lexNorm + semantic * (lex > 0 ? 0.2 : 0.5) : semantic
    return {
      id: chunk?.id ?? `${id}#0`,
      page: id,
      title: item.title,
      text: chunk?.text || String(item.body ?? ''),
      partial: item.partial === true,
      contradicts: item.contradicts ?? [],
      images: chunk?.images ?? [],
      score: item.partial === true ? score * 0.45 : score,
    }
  }).sort((left, right) => right.score - left.score)
  ordered = bringSeeAlso(ordered, pages)
  const byId = new Map(ordered.map((chunk) => [chunk.id, chunk]))
  const pageById = new Map((pages ?? []).map((item) => [`${item.kind}/${item.slug}`, item]))
  // 重排看到证据句，而不是页首。整页仍在最后附上。
  ordered = ordered.map((hit) => {
    const evidence = evidenceChunk(question, pageById.get(hit.page), chunks, hit)
    return { ...hit, text: String(evidence?.text || hit.text).slice(0, 700) }
  })
  if (typeof options.rerank === 'function') ordered = await reorder(question, ordered, options.rerank)
  const chosen = withConflicts(ordered, pages, byId, options.k ?? 10)
  const hits = chosen.map((hit) => {
    const item = pageById.get(hit.page)
    const evidence = evidenceChunk(question, item, chunks, hit)
    const body = String(item?.body ?? '')
    const lead = evidence?.text || hit.text
    const text = body && !lead.includes(body) ? `${lead}\n\n${body}` : lead
    return { ...hit, text }
  })
  return { hits, coverage: 'page', conflicts: conflictPairs(hits), embedding: embedded.state }
}

/**
 * 页已经选中之后，再挑证据句。
 * 引号里的原话留着。先看这段有没有问题里最稀有的词，再看整段得分。
 * 页面标题里的词不参与，避免标题句盖住后文。
 */
function evidenceChunk(question, page, chunks, fallback) {
  if (!page) return fallback
  const skip = new Set(tokens([page.title, ...(page.aliases ?? [])].filter(Boolean).join(' ')))
  const local = chunks.filter((chunk) => chunk.page === `${page.kind}/${page.slug}` && !chunk.id.endsWith('#claim'))
  if (local.length === 0) return fallback
  const index = buildIndex(local)
  const kept = tokens(question).filter((term) => !skip.has(term) && term.length > 2)
  if (kept.length === 0) return fallback
  const scores = scoreIndexed(kept.join(' '), { chunks: local, ...index })
  const idfOf = (term) => {
    const seen = index.df.get(term) ?? 0
    if (seen === 0) return 0
    return Math.log(1 + (index.total - seen + 0.5) / (seen + 0.5))
  }
  let best = null
  let bestIdf = 0
  let bestScore = 0
  for (const chunk of local) {
    const words = new Set(tokens(chunk.text))
    let maxIdf = 0
    for (const term of kept) {
      if (!words.has(term)) continue
      const idf = idfOf(term)
      if (idf > maxIdf) maxIdf = idf
    }
    const score = scores.get(chunk.id) ?? 0
    if (maxIdf > bestIdf || (maxIdf === bestIdf && score > bestScore)) {
      bestIdf = maxIdf
      bestScore = score
      best = chunk
    }
  }
  return bestIdf > 0 ? best : fallback
}

async function reorder(question, ordered, rerank) {
  const picked = await rerank(question, ordered)
  const ids = Array.isArray(picked) ? picked : []
  const front = []
  const used = new Set()
  for (const id of ids) {
    const chunk = ordered.find((item) => item.id === id || item.page === id)
    if (!chunk || used.has(chunk.id)) continue
    used.add(chunk.id)
    front.push(chunk)
  }
  return [...front, ...ordered.filter((item) => !used.has(item.id))]
}

/** 切词和倒排只做一次，同一批页面的后续问题直接打分。 */
function prepare(pages, chunkSize) {
  const list = pages ?? []
  const size = chunkSize ?? 480
  let sizes = preparedCache.get(list)
  if (!sizes) {
    sizes = new Map()
    preparedCache.set(list, sizes)
  }
  if (sizes.has(size)) return sizes.get(size)
  const chunks = chunkPages(list, size)
  const value = { chunks, ...buildIndex(chunks) }
  sizes.set(size, value)
  return value
}

/** 倒排索引。打分公式和逐篇 BM25 相同，只是不把每篇再扫一遍。 */
function buildIndex(chunks) {
  const lengths = []
  const postings = new Map()
  const df = new Map()
  chunks.forEach((chunk, index) => {
    const counts = new Map()
    for (const term of tokens(chunk.text)) counts.set(term, (counts.get(term) ?? 0) + 1)
    let length = 0
    for (const freq of counts.values()) length += freq
    lengths.push(length)
    for (const [term, freq] of counts) {
      df.set(term, (df.get(term) ?? 0) + 1)
      const list = postings.get(term)
      if (list) list.push([index, freq])
      else postings.set(term, [[index, freq]])
    }
  })
  const avg = lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lengths.length)
  return { lengths, postings, df, avg, total: chunks.length }
}

/** 去掉 s 会变成另一个常用词时，不要把复数收成它。 */
const STEM_BLOCK = new Set(['well', 'new', 'doe', 'goe', 'gate', 'will', 'his'])

/** 只在查询词本身不在索引里时，才试规则复数。正文保持原形，Williams 不会变成 William。 */
function pluralStem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return ''
}

/** 前缀后面剩下的部分，要能接上索引里的另一个词。Constantinople 不会收成 constant。 */
function restContinues(rest, postings) {
  if (rest.length < 3) return false
  if (postings.has(rest)) return true
  for (const word of postings.keys()) {
    if (word.length > rest.length && word.length <= rest.length + 4 && word.startsWith(rest)) return true
  }
  return false
}

/** 整词已经在索引里时不拆、不折。连写词只有后半也能对上正文时才取前缀。 */
function queryTerms(question, postings) {
  const terms = new Set(tokens(question))
  for (const term of [...terms]) {
    if (!postings.has(term)) {
      const stem = pluralStem(term)
      if (stem && !STEM_BLOCK.has(stem) && postings.has(stem)) terms.add(stem)
    }
    if (term.length < 10 || postings.has(term)) continue
    for (let size = 6; size <= 8; size += 1) {
      const prefix = term.slice(0, size)
      const rest = term.slice(size)
      if (postings.has(prefix) && restContinues(rest, postings)) terms.add(prefix)
    }
  }
  return terms
}

function scoreIndexed(question, prepared) {
  const sums = new Map()
  const matched = new Map()
  for (const term of queryTerms(question, prepared.postings)) {
    const list = prepared.postings.get(term)
    if (!list) continue
    const seen = prepared.df.get(term) ?? 0
    const idf = Math.log(1 + (prepared.total - seen + 0.5) / (seen + 0.5))
    for (const [index, freq] of list) {
      const length = prepared.lengths[index] || 1
      const norm = (freq * 2.2) / (freq + 1.2 * (1 - 0.75 + 0.75 * length / Math.max(1, prepared.avg)))
      sums.set(index, (sums.get(index) ?? 0) + idf * norm)
      matched.set(index, (matched.get(index) ?? 0) + 1)
    }
  }
  const scores = new Map()
  for (const [index, count] of matched) {
    const length = prepared.lengths[index] || 1
    let score = sums.get(index) * (0.5 + count / Math.sqrt(length))
    if (prepared.chunks[index].partial) score *= 0.45
    scores.set(prepared.chunks[index].id, score)
  }
  return scores
}

function scoreLexical(question, chunks) {
  return scoreIndexed(question, { chunks, ...buildIndex(chunks) })
}

function expand(pool, pages, byId, hops) {
  const added = []
  let frontier = pool.map((item) => item.page)
  for (let hop = 0; hop < hops; hop += 1) {
    const next = []
    for (const pageId of frontier) {
      const page = pages.find((item) => `${item.kind}/${item.slug}` === pageId)
      if (!page) continue
      const linked = [...linksIn(page.body), ...(page.contradicts ?? []), ...relationNeighbors(page, pages)]
      for (const target of linked) {
        const chunk = [...byId.values()].find((item) => item.page === target)
        if (chunk) {
          added.push(chunk)
          next.push(target)
        }
      }
    }
    frontier = next
  }
  return added
}

function withConflicts(ordered, pages, byId, k) {
  const chosen = []
  const seen = new Set()
  const push = (chunk, conflictWith = '') => {
    if (!chunk) return
    if (seen.has(chunk.id)) {
      if (!conflictWith) return
      const existing = chosen.find((item) => item.id === chunk.id)
      if (existing) {
        existing.conflict = true
        existing.conflictWith = conflictWith
      }
      return
    }
    if (chosen.length >= k) {
      const dropAt = chosen.findLastIndex((item) => item.conflict !== true)
      if (dropAt < 0) return
      seen.delete(chosen[dropAt].id)
      chosen.splice(dropAt, 1)
    }
    seen.add(chunk.id)
    chosen.push(conflictWith ? { ...chunk, conflict: true, conflictWith } : chunk)
  }
  for (const chunk of ordered) {
    if (chosen.length >= k) break
    push(chunk)
  }
  for (const chunk of [...chosen]) {
    const page = pages.find((item) => `${item.kind}/${item.slug}` === chunk.page)
    for (const other of page?.contradicts ?? []) {
      const extra = [...byId.values()].find((item) => item.page === other)
      push(extra, chunk.page)
    }
  }
  return chosen.slice(0, k)
}

function conflictPairs(hits) {
  const pairs = []
  for (const hit of hits) {
    if (!hit.conflictWith) continue
    const key = [hit.page, hit.conflictWith].sort().join('|')
    if (pairs.some((pair) => pair.key === key)) continue
    pairs.push({ key, left: hit.conflictWith, right: hit.page })
  }
  return pairs.map(({ left, right }) => ({ left, right }))
}

function tokens(text) {
  const out = []
  const lower = String(text ?? '').toLowerCase()
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    if (word.length > 1 && !STOP.has(word)) out.push(word)
  }
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.push(run)
    else for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2))
  }
  return out
}
