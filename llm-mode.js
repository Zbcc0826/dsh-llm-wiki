/**
 * 要用模型之前先问用户：用 DSH 里已有的模型、用环境变量密钥，或不做插件里的模型任务。
 * 选定后记在维基根目录，避免每一次摄入和提问都再问一遍。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { complete } from './llm.js'

/** 三种做法。dsh 走宿主已配置的模型，key 走环境变量，off 不调用模型。 */
export const LLM_MODES = ['dsh', 'key', 'off']

/**
 * 读已记住的做法。文件缺失或内容不对时返回空，调用方会再问。
 */
export function readMode(root, readFile = readFileSync) {
  try {
    const mode = JSON.parse(readFile(path.join(root, 'llm.json'), 'utf8'))?.mode
    return LLM_MODES.includes(mode) ? mode : ''
  } catch {
    return ''
  }
}

/** 把用户选定的做法写进维基根目录。这里不保存密钥。 */
export function writeMode(root, mode, writeFile = writeFileSync) {
  if (!LLM_MODES.includes(mode)) throw new Error('BAD_LLM_MODE')
  mkdirSync(root, { recursive: true })
  writeFile(path.join(root, 'llm.json'), `${JSON.stringify({ mode }, null, 2)}\n`)
}

/**
 * 还没选定时交给调用方展示的三种做法。
 */
export function llmChoice() {
  return {
    ok: false,
    code: 'NEED_LLM_CHOICE',
    choices: [
      {
        id: 'dsh',
        zh: '使用 DSH 里已有的模型（如 dsv4flash）做插件里的模型任务',
        en: 'Use a model already available in DSH, such as dsv4flash, for this plugin’s model tasks',
      },
      {
        id: 'key',
        zh: '另提供环境变量 DEEPSEEK_API_KEY，或 DEEPSEEK_KEY_FILE 指向的密钥',
        en: 'Provide DEEPSEEK_API_KEY, or a key file named by DEEPSEEK_KEY_FILE',
      },
      {
        id: 'off',
        zh: '不做插件里的模型任务',
        en: 'Do not run this plugin’s model tasks',
      },
    ],
  }
}

/**
 * 决定这次用哪种模型。已记住的选择直接沿用。
 * 没有选择时先问要不要用 DSH 模型；拒绝后再问要不要用环境变量密钥；再拒绝就记为不做。
 * 调用方如果已经带回用户说的 dsh、key 或 off，只再确认一次。
 */
export async function decideLlm(options) {
  const saved = readMode(options.root)
  if (saved && !options.change) return ready(saved, options)
  if (options.llm != null) {
    if (!LLM_MODES.includes(options.llm)) return { ok: false, code: 'BAD_LLM_MODE' }
    if (options.llm === saved) return ready(saved, options)
    const outcome = await options.approve(confirm(options.llm))
    if (outcome !== 'allowed-once') return { ok: false, code: 'NOT_APPROVED', outcome: outcome || 'unavailable' }
    writeMode(options.root, options.llm)
    return ready(options.llm, options)
  }
  const dsh = await options.approve(askDsh())
  if (dsh === 'allowed-once') {
    writeMode(options.root, 'dsh')
    return ready('dsh', options)
  }
  if (dsh === 'cancelled' || dsh === 'unavailable' || !dsh) {
    return { ...llmChoice(), outcome: dsh || 'unavailable' }
  }
  const key = await options.approve(askKey())
  if (key === 'allowed-once') {
    writeMode(options.root, 'key')
    return ready('key', options)
  }
  if (key === 'cancelled' || key === 'unavailable' || !key) {
    return { ...llmChoice(), outcome: key || 'unavailable' }
  }
  writeMode(options.root, 'off')
  return ready('off', options)
}

/** 按做法返回 complete。off 不访问网络，只让调用方知道模型任务停了。 */
export function completeFor(mode, options = {}) {
  if (mode === 'off') return async () => ({ ok: false, code: 'LLM_OFF' })
  if (mode === 'key') return (messages, call) => complete(messages, call)
  return (messages, call) => completeWithDsh(options.llmRuntime, options.agent, messages, call)
}

/**
 * 用 DSH 当前会话的模型，没有当前会话时再从已注册模型里挑带 flash 的一个。
 * 思考开关留给宿主，这里只收集正文。
 */
export async function completeWithDsh(llm, agent, messages, options = {}) {
  if (typeof llm?.stream !== 'function') return { ok: false, code: 'NO_DSH_MODEL' }
  const route = await dshRoute(llm, agent)
  if (!route) return { ok: false, code: 'NO_DSH_MODEL' }
  const prepared = splitMessages(messages)
  let text = ''
  let incomplete = false
  let failed = false
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: prepared.system || undefined,
      messages: prepared.messages,
      maxTokens: options.maxTokens ?? 4096,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && chunk.text) text += chunk.text
      if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') failed = true
        if (kind === 'max-tokens') incomplete = true
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UPSTREAM'
    return { ok: false, code: 'UPSTREAM', message: String(message).slice(0, 300) }
  }
  if (failed) return { ok: false, code: 'UPSTREAM', message: 'DSH 模型没有完成' }
  if (!text.trim()) return { ok: false, code: 'EMPTY_MODEL' }
  if (incomplete) return { ok: false, code: 'INCOMPLETE', model: route.model }
  return { ok: true, text, model: route.model }
}

/** 优先用当前会话正在用的模型，否则在宿主目录里找名称里带 flash 的模型。 */
async function dshRoute(llm, agent) {
  const current = agent?.model?.current?.()
  if (current?.provider && current?.model) return { provider: current.provider, model: current.model }
  if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return null
  let providers
  try { providers = await llm.listProviders() } catch { return null }
  const ranked = []
  for (const item of Array.isArray(providers) ? providers : []) {
    const provider = typeof item === 'string' ? item : item?.id
    if (!provider) continue
    let models
    try { models = await llm.listModels(provider) } catch { continue }
    for (const model of models ?? []) {
      if (!model?.id) continue
      ranked.push({ provider: model.provider || provider, model: model.id, name: model.name || '' })
    }
  }
  return ranked.find((item) => /flash/i.test(`${item.model} ${item.name}`)) || ranked[0] || null
}

/** 把系统消息交给宿主的 system 槽，其余消息原样保留，图片块也不会被拆掉。 */
function splitMessages(messages) {
  const system = []
  const rest = []
  for (const message of messages ?? []) {
    if (message?.role === 'system' && typeof message.content === 'string') system.push(message.content)
    else if (message) rest.push(message)
  }
  if (rest.length === 0) rest.push({ role: 'user', content: '请继续。' })
  return { system: system.join('\n'), messages: rest }
}

function ready(mode, options) {
  return { ok: true, mode, complete: completeFor(mode, options) }
}

function askDsh() {
  return {
    zh: '插件里的模型任务怎么做？允许：使用 DSH 里已有的模型（如 dsv4flash）。拒绝：不用 DSH 模型，接着再问要不要改用环境变量里的密钥。',
    en: 'How should this plugin run its model tasks? Allow: use a model already available in DSH, such as dsv4flash. Reject: do not use the DSH model; you will then be asked about an environment-variable key.',
  }
}

function askKey() {
  return {
    zh: '允许：另提供环境变量 DEEPSEEK_API_KEY，或 DEEPSEEK_KEY_FILE 指向的密钥。拒绝：不做插件里的模型任务。',
    en: 'Allow: provide DEEPSEEK_API_KEY, or a key file named by DEEPSEEK_KEY_FILE. Reject: do not run this plugin’s model tasks.',
  }
}

function confirm(mode) {
  if (mode === 'dsh') return askDsh()
  if (mode === 'key') return askKey()
  return {
    zh: '之后不做插件里的模型任务。查阅和检查仍然可用，摄入和改写不会调用模型。',
    en: 'Do not run this plugin’s model tasks. Reading and checks still work; ingest and rewrites will not call a model.',
  }
}
