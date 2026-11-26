/**
 * 把原始材料变成同一种文本结果。摄入只消费这个结果，不把字节直接交给模型。
 */

const TEXT_EXT = new Set(['.txt', '.md', '.markdown'])
const HTML_EXT = new Set(['.html', '.htm'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const IMAGE_TYPE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 路径的小写扩展名。没有路径时是空字符串。 */
export function extensionOf(filePath) {
  const name = String(filePath ?? '')
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const base = slash >= 0 ? name.slice(slash + 1) : name
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** 内建解析器。更具体的类型放在前面。 */
export function builtinParsers() {
  return [imageParser(), htmlParser(), csvParser(), jsonParser(), markdownParser(), plainParser()]
}

/**
 * 按注册顺序找第一个 accepts 为真的解析器。
 * 额外解析器插在内建之前，这样后来的类型可以盖过纯文本。
 * PDF、Office 和音视频不在这里解析。别的插件用 register 接上，或把成果交给 acceptParsed。
 */
export function createRegistry(extra = []) {
  const added = [...extra]
  const builtins = builtinParsers()
  const all = () => [...added, ...builtins]
  return {
    /** 注册一个外部解析器。同 id 的后注册者替换先注册者。 */
    register(parser) {
      const checked = checkParser(parser)
      if (!checked.ok) return checked
      const previous = added.findIndex((item) => item.id === parser.id)
      if (previous >= 0) added.splice(previous, 1)
      added.unshift(parser)
      return {
        ok: true,
        dispose() {
          const index = added.indexOf(parser)
          if (index >= 0) added.splice(index, 1)
        },
      }
    },
    list() {
      return all().map((parser) => ({ id: parser.id, mediaTypes: [...parser.mediaTypes] }))
    },
    /** 预览其他插件的解析成果，不写盘。 */
    accept(document) {
      const accepted = acceptParsed(document)
      if (!accepted.ok) return accepted
      return {
        ok: true,
        parser: accepted.parser,
        title: accepted.title,
        mediaType: accepted.mediaType,
        text: accepted.text,
        partial: accepted.partial,
        meta: accepted.meta,
        bytes: accepted.rawBytes.length,
      }
    },
    parse(input) {
      const parser = all().find((item) => item.accepts(input ?? {}))
      const mediaType = input?.mediaType || extensionOf(input?.path)
      if (!parser) {
        const family = externalFamily(input ?? {})
        if (family) {
          return {
            ok: false,
            code: 'NEED_EXTERNAL_PARSER',
            mediaType,
            family,
            message: '本插件不解析这类字节。请把解析成果交给 accept，或注册解析器。',
          }
        }
        return { ok: false, code: 'NO_PARSER', mediaType }
      }
      try {
        const parsed = parser.parse(input ?? {})
        if (parsed?.document && parsed.text === undefined && parsed.parts === undefined && parsed.ok !== false) {
          return acceptParsed(parsed.document)
        }
        if (!parsed || parsed.ok === false) return parsed ?? { ok: false, code: 'PARSE', parser: parser.id }
        return { ok: true, parser: parser.id, partial: false, parts: [], meta: {}, ...parsed }
      } catch (error) {
        return { ok: false, code: 'PARSE', parser: parser.id, message: error instanceof Error ? error.message : 'PARSE' }
      }
    },
  }
}

/** 其他插件提供的服务名。注入 llm-wiki.parsers 后即可 register 或 accept。 */
export const PARSER_SERVICE = 'llm-wiki.parsers'

/** 和摄入上限一致。解析成果再大就拒绝，不截断后假装读完。 */
const MAX_PARSE_BYTES = 2_000_000

const EXTERNAL_SLOTS = [
  { family: 'pdf', mediaTypes: ['application/pdf'], extensions: ['.pdf'], prefixes: [] },
  {
    family: 'word',
    mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'],
    extensions: ['.docx', '.doc'],
    prefixes: [],
  },
  {
    family: 'excel',
    mediaTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
    extensions: ['.xlsx', '.xls'],
    prefixes: [],
  },
  {
    family: 'powerpoint',
    mediaTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'],
    extensions: ['.pptx', '.ppt'],
    prefixes: [],
  },
  {
    family: 'audio',
    mediaTypes: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/flac', 'audio/ogg'],
    extensions: ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac'],
    prefixes: ['audio/'],
  },
  {
    family: 'video',
    mediaTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
    extensions: ['.mp4', '.mov', '.webm', '.mkv', '.avi'],
    prefixes: ['video/'],
  },
]

/** 这些类型留给别的插件。返回家族名；不是这类材料时返回空字符串。 */
export function externalFamily(input) {
  const mediaType = String(input?.mediaType ?? '').toLowerCase()
  const extension = extensionOf(input?.path || input?.name)
  for (const slot of EXTERNAL_SLOTS) {
    if (mediaType && (slot.mediaTypes.includes(mediaType) || slot.prefixes.some((prefix) => mediaType.startsWith(prefix)))) {
      return slot.family
    }
    if (extension && slot.extensions.includes(extension)) return slot.family
  }
  return ''
}

/** 列出留给外部插件的类型，并标出是不是已经有解析器接上。 */
export function externalSlots(parsers = []) {
  const listed = parsers.flatMap((parser) => (parser.mediaTypes ?? []).map((item) => String(item).toLowerCase()))
  return EXTERNAL_SLOTS.map((slot) => ({
    family: slot.family,
    mediaTypes: [...slot.mediaTypes],
    extensions: [...slot.extensions],
    ready: listed.some((item) => slot.mediaTypes.includes(item) || slot.prefixes.some((prefix) => item.startsWith(prefix))),
  }))
}

/**
 * 收下其他插件已经解析好的成果。
 * 文本、表格、字幕都保留各自的位置；原始字节只在 source.base64 里出现。
 * 不读取路径，也不把字节交给本插件的解析器。
 */
export function acceptParsed(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return { ok: false, code: 'BAD_PARSE' }
  const parser = String(document.parser ?? '').trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(parser)) return { ok: false, code: 'BAD_PARSE', message: 'parser' }
  const mediaType = String(document.mediaType ?? '').trim().toLowerCase()
  if (!mediaType || mediaType.length > 120 || /[\n\r]/.test(mediaType)) return { ok: false, code: 'BAD_PARSE', message: 'mediaType' }
  const parts = Array.isArray(document.parts) ? document.parts : []
  if (parts.length > 400) return { ok: false, code: 'BAD_PARSE', message: 'parts' }
  const blocks = []
  const images = []
  let droppedImage = false
  const ownText = typeof document.text === 'string' ? document.text : ''
  if (ownText.trim()) blocks.push(withLocator(ownText, document.locator))
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return { ok: false, code: 'BAD_PARSE', message: 'part' }
    const role = part.role
    if (!['text', 'table', 'caption', 'transcript', 'image'].includes(role)) return { ok: false, code: 'BAD_PARSE', message: 'role' }
    if (role === 'image') {
      const base64 = typeof part.base64 === 'string' ? part.base64 : ''
      if (!base64) continue
      if (base64.length > 1_500_000) return { ok: false, code: 'TOO_LARGE' }
      if (images.length >= 4) {
        droppedImage = true
        continue
      }
      images.push({
        id: clip(part.id, 40) || `image-${images.length + 1}`,
        role: 'image',
        mediaType: clip(part.mediaType, 80) || 'image/png',
        base64,
      })
      continue
    }
    if (typeof part.text !== 'string' || !part.text.trim()) return { ok: false, code: 'BAD_PARSE', message: 'text' }
    blocks.push(withLocator(part.text, part.locator))
  }
  const text = blocks.join('\n\n').trim()
  if (!text && images.length === 0) return { ok: false, code: 'EMPTY_PARSE' }
  const raw = originalBytes(document.source)
  if (raw.code) return raw
  const rawBytes = raw.bytes ?? Buffer.from(text, 'utf8')
  if (rawBytes.length > MAX_PARSE_BYTES || Buffer.byteLength(text) > MAX_PARSE_BYTES) {
    return { ok: false, code: 'TOO_LARGE', bytes: rawBytes.length }
  }
  const name = document.source?.name
  return {
    ok: true,
    foreign: true,
    parser,
    kind: externalFamily({ mediaType, path: name }) || 'external',
    title: clip(document.title, 120) || titleFromPath(name) || 'parsed',
    mediaType,
    text,
    partial: document.partial === true || droppedImage,
    parts: [...images],
    meta: plainMeta(document.meta),
    rawBytes,
    rawExt: raw.bytes ? (extensionOf(name) || extensionForMedia(mediaType)) : '.txt',
  }
}

function checkParser(parser) {
  if (!parser || typeof parser.accepts !== 'function' || typeof parser.parse !== 'function') {
    return { ok: false, code: 'BAD_PARSER' }
  }
  if (typeof parser.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,40}$/.test(parser.id)) {
    return { ok: false, code: 'BAD_PARSER' }
  }
  if (!Array.isArray(parser.mediaTypes) || parser.mediaTypes.length === 0 || parser.mediaTypes.some((item) => typeof item !== 'string')) {
    return { ok: false, code: 'BAD_PARSER' }
  }
  return { ok: true }
}

/** 位置和正文放在同一块，后面的切分才不会把表头和这一处来源拆开。 */
function withLocator(text, locator) {
  const place = clip(locator, 80)
  return place ? `[位置：${place}]\n${text}` : text
}

function originalBytes(source) {
  if (source == null) return {}
  if (typeof source !== 'object' || Array.isArray(source)) return { code: 'BAD_PARSE', ok: false, message: 'source' }
  if (source.base64 == null || source.base64 === '') return {}
  if (typeof source.base64 !== 'string' || source.base64.length > 2_800_000) return { ok: false, code: 'TOO_LARGE' }
  const bytes = Buffer.from(source.base64, 'base64')
  if (bytes.length === 0) return { ok: false, code: 'BAD_PARSE', message: 'source' }
  return { bytes }
}

function plainMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {}
  const out = {}
  for (const [key, value] of Object.entries(meta)) {
    if (Object.keys(out).length >= 12) break
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) continue
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value
    else if (typeof value === 'string' && value.length <= 200 && !/[\n\r]/.test(value)) out[key] = value
  }
  return out
}

function extensionForMedia(mediaType) {
  const known = {
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  }
  return known[mediaType] || '.bin'
}

function clip(value, max) {
  const text = String(value ?? '').replace(/[\n\r]/g, ' ').trim()
  return text ? text.slice(0, max) : ''
}

/** 图像：保留像素，不编造看图结果。 */
function imageParser() {
  return {
    id: 'image',
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    accepts(input) {
      const mediaType = String(input.mediaType ?? '')
      return mediaType.startsWith('image/') || IMAGE_EXT.has(extensionOf(input.path))
    },
    parse(input) {
      const bytes = input.bytes ? Buffer.from(input.bytes) : Buffer.from(String(input.text ?? ''), 'utf8')
      const mediaType = String(input.mediaType || IMAGE_TYPE[extensionOf(input.path)] || 'image/png')
      return {
        kind: 'image',
        title: titleFromPath(input.path) || 'image',
        mediaType,
        text: '',
        parts: [{ id: 'image', role: 'image', mediaType, base64: bytes.toString('base64') }],
      }
    },
  }
}

/** HTML：去掉脚本和样式，留下标题和可见文字。 */
function htmlParser() {
  return {
    id: 'html',
    mediaTypes: ['text/html'],
    accepts(input) {
      return input.mediaType === 'text/html' || HTML_EXT.has(extensionOf(input.path))
    },
    parse(input) {
      const raw = sourceText(input)
      const title = decode(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || titleFromPath(input.path) || 'html'
      const visible = raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
      const text = collapse(decode(visible))
      return { kind: 'html', title, mediaType: 'text/html', text, parts: [{ id: 'body', role: 'text', text }] }
    },
  }
}

/** CSV：表头加有限行数，并记下总行数。 */
function csvParser() {
  return {
    id: 'csv',
    mediaTypes: ['text/csv'],
    accepts(input) {
      return input.mediaType === 'text/csv' || extensionOf(input.path) === '.csv'
    },
    parse(input) {
      const rows = parseCsv(sourceText(input))
      const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
      const header = (rows[0] ?? []).concat(Array(Math.max(0, width - (rows[0]?.length ?? 0))).fill(''))
      const body = rows.slice(1)
      const shown = body.slice(0, 50)
      const lines = [
        `| ${header.map(escapeCell).join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...shown.map((row) => `| ${pad(row, width).map(escapeCell).join(' | ')} |`),
      ]
      if (body.length > shown.length) lines.push('', `其余 ${body.length - shown.length} 行未展开。总数据行 ${body.length}。`)
      const text = lines.join('\n')
      return {
        kind: 'csv',
        title: titleFromPath(input.path) || 'csv',
        mediaType: 'text/csv',
        text,
        partial: body.length > shown.length,
        meta: { rows: String(body.length), columns: String(width) },
        parts: [{ id: 'table', role: 'table', text }],
      }
    },
  }
}

/** JSON：保留结构摘要，不把大数组原样铺开。 */
function jsonParser() {
  return {
    id: 'json',
    mediaTypes: ['application/json'],
    accepts(input) {
      return input.mediaType === 'application/json' || extensionOf(input.path) === '.json'
    },
    parse(input) {
      const value = JSON.parse(sourceText(input))
      const text = summarizeJson(value, 0)
      return {
        kind: 'json',
        title: titleFromPath(input.path) || 'json',
        mediaType: 'application/json',
        text,
        parts: [{ id: 'json', role: 'text', text }],
      }
    },
  }
}

/** Markdown：保留原文，不先改成纯文本。 */
function markdownParser() {
  return {
    id: 'markdown',
    mediaTypes: ['text/markdown'],
    accepts(input) {
      return input.mediaType === 'text/markdown' || extensionOf(input.path) === '.md' || extensionOf(input.path) === '.markdown'
    },
    parse(input) {
      const text = sourceText(input)
      const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
      return {
        kind: 'markdown',
        title: heading || titleFromPath(input.path) || 'markdown',
        mediaType: 'text/markdown',
        text,
        parts: [{ id: 'body', role: 'text', text }],
      }
    },
  }
}

/** 纯文本，以及没有路径、没有媒体类型的直接文本。 */
function plainParser() {
  return {
    id: 'plain',
    mediaTypes: ['text/plain'],
    accepts(input) {
      if (input.mediaType === 'text/plain' || extensionOf(input.path) === '.txt') return true
      return input.text !== undefined && !input.path && !input.mediaType
    },
    parse(input) {
      const text = sourceText(input)
      return {
        kind: 'plain',
        title: titleFromPath(input.path) || 'text',
        mediaType: 'text/plain',
        text,
        parts: [{ id: 'body', role: 'text', text }],
      }
    },
  }
}

function sourceText(input) {
  if (typeof input.text === 'string') return input.text
  if (input.bytes) return Buffer.from(input.bytes).toString('utf8')
  return ''
}

function titleFromPath(filePath) {
  if (!filePath) return ''
  const base = String(filePath).split(/[\\/]/).pop() ?? ''
  return base.replace(/\.[^.]+$/, '')
}

function collapse(text) {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
}

function decode(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function pad(row, width) {
  return row.concat(Array(Math.max(0, width - row.length)).fill(''))
}

/** 足够覆盖引号和逗号。换行仍按一行一条记录。 */
function parseCsv(text) {
  return text.split(/\r?\n/).filter((line) => line.length > 0).map((line) => {
    const cells = []
    let current = ''
    let quoted = false
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (quoted && ch === '"' && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else if (ch === '"') quoted = !quoted
      else if (ch === ',' && !quoted) {
        cells.push(current)
        current = ''
      } else current += ch
    }
    cells.push(current)
    return cells
  })
}

function summarizeJson(value, depth) {
  if (depth > 4) return '…'
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    const shown = JSON.stringify(value)
    return shown.length > 180 ? `${shown.slice(0, 180)}…` : shown
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 3).map((item) => summarizeJson(item, depth + 1))
    return `数组，长度 ${value.length}。前 ${head.length} 项：${head.join('；')}`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    const lines = keys.slice(0, 40).map((key) => `- ${key}：${summarizeJson(value[key], depth + 1)}`)
    if (keys.length > 40) lines.push(`- 其余 ${keys.length - 40} 个键未展开`)
    return lines.join('\n')
  }
  return String(value)
}

export const parserMediaExtensions = TEXT_EXT
