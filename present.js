/**
 * 可用性：模型只能看见这里交出去的文本。
 * 解析结果再长，也先被裁到上限，并标明没有给全。
 */

/** 默认交给模型的字符数。调用方可以改，但省略时用这一档。 */
export const DEFAULT_PRESENT_CHARS = 12000

/**
 * 把解析结果收成模型可读的一份材料。
 * 超长时 partial 为真，正文只保留开头。
 */
export function presentSource(parsed, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_PRESENT_CHARS
  const text = String(parsed?.text ?? '')
  const truncated = text.length > maxChars
  const images = (parsed?.parts ?? [])
    .filter((part) => part?.role === 'image' && part.base64)
    .slice(0, 4)
    .map((part) => ({ mediaType: part.mediaType || 'image/png', base64: part.base64 }))
  const partial = truncated || (parsed?.partial === true && images.length === 0)
  const shown = truncated ? text.slice(0, maxChars) : text
  const body = images.length > 0 && !shown ? `[图像 ${parsed?.title || ''}]` : shown
  return {
    title: parsed?.title || '',
    parser: parsed?.parser || '',
    mediaType: parsed?.mediaType || '',
    partial,
    chars: text.length,
    shown: body.length,
    images,
    text: partial ? `${body}\n\n[材料未完整交给模型]` : body,
  }
}
