/**
 * 长材料按章节和表格切开。
 * 每一段都能单独放进一页，表格不和表头拆开。
 */

/** 一页正文的上限以下，留出余量给索引头。 */
export const SEGMENT_CHARS = 7500

/** 一次摄入最多展开的段数。再往后的字标成不完整，不假装已经读完。 */
export const MAX_SEGMENTS = 8

/**
 * 短材料原样返回一段。超长时按空行、标题和整张表打包。
 * omitted 是这次没有放进任何段的字符数。
 */
export function splitSource(text, options = {}) {
  const maxChars = options.maxChars ?? SEGMENT_CHARS
  const maxSegments = options.maxSegments ?? MAX_SEGMENTS
  const source = String(text ?? '').trim()
  if (!source || source.length <= maxChars) {
    return { segments: [segmentOf(source, 1, 1, headingOf(source))], omitted: 0 }
  }
  const pieces = []
  for (const block of blocksOf(source)) {
    pieces.push(...splitOversized(block, maxChars))
  }
  const packed = []
  let current = []
  let size = 0
  let omitted = 0
  const take = (block) => {
    if (packed.length >= maxSegments) {
      omitted += block.length
      return
    }
    const next = size + block.length + (current.length ? 2 : 0)
    if (current.length && next > maxChars) {
      packed.push(current.join('\n\n'))
      current = []
      size = 0
      if (packed.length >= maxSegments) {
        omitted += block.length
        return
      }
    }
    current.push(block)
    size += block.length + (current.length > 1 ? 2 : 0)
  }
  for (const block of pieces) take(block)
  if (current.length) {
    if (packed.length >= maxSegments) omitted += current.join('\n\n').length
    else packed.push(current.join('\n\n'))
  }
  const segments = packed.map((body, index) => segmentOf(body, index + 1, packed.length, headingOf(body)))
  return { segments, omitted }
}

/** 给一段写上稳定的位置说明，检索时能和正文一起被看见。 */
export function segmentLocator(title, segment, omitted = 0) {
  const head = [String(title ?? '').trim(), segment.heading].filter(Boolean).join(' · ')
  const place = `${head} · 第 ${segment.index}/${segment.total} 段`
  return omitted > 0 ? `${place} · 其后还有未纳入的文字` : place
}

function segmentOf(text, index, total, heading) {
  return { index, total, heading, text }
}

function headingOf(text) {
  const line = String(text ?? '').split('\n').find((item) => /^#{1,6}\s+\S/.test(item.trim()))
  return line ? line.replace(/^#{1,6}\s+/, '').trim().slice(0, 80) : ''
}

/** 空行和标题断开。表格连同紧挨着的位置说明收成一块，避免数字离开表头。 */
function blocksOf(text) {
  const blocks = []
  let buf = []
  let inTable = false
  let sticky = false
  const flush = () => {
    if (buf.length === 0) return
    blocks.push(buf.join('\n'))
    buf = []
    inTable = false
    sticky = false
  }
  for (const line of String(text).split('\n')) {
    const table = looksLikeTable(line)
    if (table) {
      if (!inTable && !sticky) flush()
      inTable = true
      sticky = false
      buf.push(line)
      continue
    }
    if (inTable) flush()
    if (line.trim() === '') {
      flush()
      continue
    }
    if (/^#{1,6}\s+/.test(line) && buf.length) flush()
    if (isLocator(line) && buf.length && !sticky) flush()
    buf.push(line)
    sticky = isLocator(line)
  }
  flush()
  return blocks
}

function isLocator(line) {
  return /^\[位置：/.test(line.trim())
}

function looksLikeTable(line) {
  const text = line.trim()
  return text.startsWith('|') && text.includes('|', 1)
}

function splitOversized(block, maxChars) {
  if (block.length <= maxChars) return [block]
  const lines = block.split('\n')
  const tableAt = lines.findIndex((line) => looksLikeTable(line))
  if (tableAt === 0) return splitTable(block, maxChars)
  if (tableAt > 0 && lines.slice(0, tableAt).every((line) => isLocator(line))) {
    const prefix = lines.slice(0, tableAt).join('\n')
    const room = Math.max(20, maxChars - prefix.length - 1)
    return splitTable(lines.slice(tableAt).join('\n'), room).map((part) => `${prefix}\n${part}`)
  }
  const parts = []
  let rest = block
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars)
    if (cut < maxChars * 0.5) cut = lastBreak(rest.slice(0, maxChars))
    if (cut < maxChars * 0.5) cut = maxChars
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

/** 超长表格每段都重复表头，后面的行才能对上列名。 */
function splitTable(block, maxChars) {
  const lines = block.split('\n')
  const header = lines.slice(0, 2)
  const rows = lines.slice(2)
  if (rows.length === 0) return splitOversized(block.replace(/^\|/, ' |'), maxChars)
  const parts = []
  let buf = [...header]
  let size = header.join('\n').length
  for (const row of rows) {
    if (buf.length > header.length && size + row.length + 1 > maxChars) {
      parts.push(buf.join('\n'))
      buf = [...header]
      size = header.join('\n').length
    }
    buf.push(row)
    size += row.length + 1
  }
  if (buf.length > header.length) parts.push(buf.join('\n'))
  return parts.length ? parts : [block.slice(0, maxChars)]
}

function lastBreak(text) {
  const marks = ['。', '！', '？', '.', ' ']
  let at = -1
  for (const mark of marks) at = Math.max(at, text.lastIndexOf(mark))
  return at
}
