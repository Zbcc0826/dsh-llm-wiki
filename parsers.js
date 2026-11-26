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
 */
export function createRegistry(extra = []) {
  const parsers = [...extra, ...builtinParsers()]
  return {
    list() {
      return parsers.map((parser) => ({ id: parser.id, mediaTypes: [...parser.mediaTypes] }))
    },
    parse(input) {
      const parser = parsers.find((item) => item.accepts(input ?? {}))
      const mediaType = input?.mediaType || extensionOf(input?.path)
      if (!parser) return { ok: false, code: 'NO_PARSER', mediaType }
      try {
        const parsed = parser.parse(input ?? {})
        if (!parsed || parsed.ok === false) return parsed ?? { ok: false, code: 'PARSE', parser: parser.id }
        return { ok: true, parser: parser.id, partial: false, parts: [], meta: {}, ...parsed }
      } catch (error) {
        return { ok: false, code: 'PARSE', parser: parser.id, message: error instanceof Error ? error.message : 'PARSE' }
      }
    },
  }
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
