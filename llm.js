/**
 * 调用 DeepSeek。测试注入 complete，不走这里。
 * dsv4.1flash 不是这把密钥能用的模型名。
 */
import { readFileSync } from 'node:fs'

/** 请求用的模型名。响应里的 model 字段经常是 deepseek-flash。 */
export const MODEL = 'deepseek-v4-flash'

const ENDPOINT = 'https://api.deepseek.com/chat/completions'

/**
 * 读取密钥。环境变量优先，其次是 DEEPSEEK_KEY_FILE 指向的文件。读不到就返回空字符串。
 */
export function loadKey(env = process.env, readFile = readFileSync) {
  const direct = env.DEEPSEEK_API_KEY?.trim()
  if (direct) return direct
  const file = env.DEEPSEEK_KEY_FILE?.trim()
  if (!file) return ''
  try {
    return String(readFile(file, 'utf8')).trim()
  } catch {
    return ''
  }
}

/** 错误文本里如果混进了密钥，换成占位。 */
export function redact(text, key) {
  const body = String(text ?? '')
  if (!key) return body.slice(0, 300)
  return body.split(key).join('[key]').slice(0, 300)
}

/**
 * 从模型回复里取第一个完整 JSON 对象。散文或半截对象都返回 null。
 */
export function extractJson(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/**
 * 发一次对话请求。思考关闭，避免占掉正文。
 * 密钥不会出现在返回的错误里。
 */
export async function complete(messages, options = {}) {
  const key = options.key ?? loadKey()
  if (!key) return { ok: false, code: 'NO_KEY' }
  const model = options.model ?? MODEL
  let response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.maxTokens ?? 4096,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60000),
    })
  } catch (error) {
    return { ok: false, code: 'UPSTREAM', message: redact(error instanceof Error ? error.message : 'UPSTREAM', key) }
  }
  const raw = await response.text()
  if (!response.ok) return { ok: false, code: 'UPSTREAM', status: response.status, message: redact(raw, key) }
  let body
  try { body = JSON.parse(raw) } catch {
    return { ok: false, code: 'UPSTREAM', message: '响应不是 JSON' }
  }
  const choice = body.choices?.[0]
  const text = choice?.message?.content ?? ''
  if (!text.trim()) return { ok: false, code: 'EMPTY_MODEL' }
  if (choice?.finish_reason === 'length') return { ok: false, code: 'INCOMPLETE', model: body.model ?? model }
  return { ok: true, text, model: body.model ?? model }
}
