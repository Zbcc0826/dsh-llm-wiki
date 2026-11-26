/**
 * 本地向量召回。用开源的 multilingual-e5-small，不走 DeepSeek。
 * 权重第一次用到时下载到插件目录的 .cache，片段向量按文本哈希留在维基里。
 * 测试可以注入 load，避免下载。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Hugging Face 上的模型名。MIT，中英都能用，检索时要加 query/passage 前缀。 */
export const EMBED_MODEL = 'Xenova/multilingual-e5-small'

const MODEL_CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache', 'models')
const shared = new Map()

/** 按 e5 的约定给查询和正文加前缀。前缀不同，向量不能混用。 */
export function prefixText(text, kind) {
  const head = kind === 'query' ? 'query: ' : 'passage: '
  return head + String(text ?? '')
}

/**
 * 返回一个 embed(texts, { kinds })。
 * kinds 与 texts 对齐，缺省当作 passage。相同前缀文本只算一次。
 */
export function createEmbedder(options = {}) {
  let loading = null
  const memory = new Map()
  const vectorDir = options.cacheDir ? path.join(options.cacheDir, 'vectors') : ''
  const load = options.load ?? (() => loadDefault(options.modelCacheDir || MODEL_CACHE))

  return async function embed(texts, meta = {}) {
    const list = Array.isArray(texts) ? texts.map((text) => String(text ?? '')) : []
    const kinds = Array.isArray(meta.kinds) ? meta.kinds : []
    const prepared = list.map((text, index) => prefixText(text, kinds[index]))
    const rows = new Array(prepared.length)
    const missing = []
    for (let index = 0; index < prepared.length; index += 1) {
      const key = hashText(prepared[index])
      const cached = memory.get(key) ?? readVector(vectorDir, key)
      if (cached) {
        memory.set(key, cached)
        rows[index] = cached
      } else {
        missing.push(index)
      }
    }
    if (missing.length === 0) return rows
    loading ??= Promise.resolve()
      .then(load)
      .catch((error) => {
        loading = null
        throw error
      })
    const extractor = await loading
    const batchSize = 32
    for (let start = 0; start < missing.length; start += batchSize) {
      const slice = missing.slice(start, start + batchSize)
      const batch = slice.map((index) => prepared[index])
      const vectors = rowsFromOutput(await extractor(batch, { pooling: 'mean', normalize: true }), batch.length)
      slice.forEach((index, offset) => {
        const key = hashText(prepared[index])
        const vector = vectors[offset]
        memory.set(key, vector)
        writeVector(vectorDir, key, vector)
        rows[index] = vector
      })
    }
    return rows
  }
}

/** 同一个缓存目录共用一个模型实例。 */
export function defaultEmbedder(cacheDir) {
  const key = cacheDir || 'default'
  if (!shared.has(key)) shared.set(key, createEmbedder({ cacheDir }))
  return shared.get(key)
}

/** 下载并加载量化权重。调用方负责在失败时退回词面召回。 */
async function loadDefault(modelCacheDir) {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = modelCacheDir
  env.allowLocalModels = true
  env.allowRemoteModels = true
  if (process.env.LLM_WIKI_HF_ENDPOINT) env.remoteHost = process.env.LLM_WIKI_HF_ENDPOINT
  try {
    return await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' })
  } catch {
    return pipeline('feature-extraction', EMBED_MODEL)
  }
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

function readVector(dir, hash) {
  if (!dir) return null
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, `${hash}.json`), 'utf8'))
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null
  } catch {
    return null
  }
}

function writeVector(dir, hash, vector) {
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${hash}.json`)
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(vector))
  renameSync(temp, file)
}

/** 把 pipeline 的二维输出切成每个文本一个数组。 */
function rowsFromOutput(output, count) {
  if (output?.data && output?.dims?.length) {
    const dim = output.dims[output.dims.length - 1]
    return Array.from({ length: count }, (_item, index) => Array.from(output.data.slice(index * dim, (index + 1) * dim)))
  }
  if (Array.isArray(output) && Array.isArray(output[0])) return output
  throw new Error('EMBED_SHAPE')
}
