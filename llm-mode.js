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
 * 决定这次用哪种模型。
 * 没有记下的选择、调用方也没带来用户的选择时，只返回三种做法，不写 llm.json。
 * 显式传入的 dsh、key 或 off 优先于已记住的选择。
 * 摄入和提问上的参数是用户已经做过的选择，直接记住。
 * 只有 wiki_llm 这种更改会再请一次批准。
 */
export async function decideLlm(options) {
  const saved = readMode(options.root)
  const requested = options.llm == null || options.llm === '' ? '' : options.llm
  if (requested) {
    if (!LLM_MODES.includes(requested)) return { ok: false, code: 'BAD_LLM_MODE', approved: false, outcome: 'not-asked' }
    if (requested === saved) return ready(saved, options)
    if (options.change) {
      const outcome = await options.approve(confirm(requested))
      if (outcome !== 'allowed-once') {
        return { ok: false, code: 'NOT_APPROVED', approved: false, outcome: outcome || 'unavailable' }
      }
    }
    writeMode(options.root, requested)
    return { ...ready(requested, options), approved: options.change === true, outcome: options.change ? 'allowed-once' : 'argument' }
  }
  if (saved) return ready(saved, options)
  return { ...llmChoice(), approved: false, outcome: 'not-asked' }
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
  if (!route) return { ok: false, code: 'NO_DSH_MODEL', provider: undefined, model: undefined }
  const prepared = splitMessages(messages)
  let text = ''
  let finishReason
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      reasoningEffort: options.reasoningEffort ?? 'off',
      system: prepared.system || undefined,
      messages: prepared.messages,
      maxTokens: options.maxTokens ?? 4096,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && chunk.text) text += chunk.text
      if (chunk?.type === 'finish') finishReason = chunk.reason
    }
  } catch (error) {
    return upstream(route, {
      finishReason: { kind: 'error', message: error instanceof Error ? error.message : 'UPSTREAM' },
      message: error instanceof Error ? error.message : 'UPSTREAM',
    })
  }
  const kind = finishReason?.kind
  if (kind === 'error' || kind === 'aborted') {
    const failure = finishReason.failure ?? {}
    return upstream(route, {
      finishReason,
      upstreamStatus: failure.status,
      message: failure.message || failure.code || kind,
    })
  }
  if (!text.trim()) return { ...upstream(route, { finishReason, message: '模型没有返回正文' }), code: 'EMPTY_MODEL' }
  if (kind === 'max-tokens') return { ok: false, code: 'INCOMPLETE', provider: route.provider, model: route.model, finishReason }
  return { ok: true, text, provider: route.provider, model: route.model }
}

/** 失败时保留路由和结束原因，方便判断是权限、参数还是上游状态。 */
function upstream(route, extra) {
  return {
    ok: false,
    code: 'UPSTREAM',
    provider: route.provider,
    model: route.model,
    finishReason: extra.finishReason,
    upstreamStatus: extra.upstreamStatus,
    message: String(extra.message ?? '').slice(0, 300),
  }
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

/**
 * 把系统消息交给宿主的 system 槽。
 * 用户消息必须是文本块数组；纯字符串会被适配器当成非法内容。
 * DSH 这条路认的是附件引用，不是密钥接口的 image_url，像素改走密钥模式。
 */
function splitMessages(messages) {
  const system = []
  const rest = []
  for (const message of messages ?? []) {
    if (message?.role === 'system' && typeof message.content === 'string') system.push(message.content)
    else if (message) rest.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: toBlocks(message.content) })
  }
  if (rest.length === 0) rest.push({ role: 'user', content: [{ type: 'text', text: '请继续。' }] })
  return { system: system.join('\n'), messages: rest }
}

/** 收成宿主能序列化的文本块。图像像素不在这里发送。 */
function toBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content || '请继续。' }]
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content ?? '请继续。') }]
  const blocks = []
  let images = 0
  for (const block of content) {
    if (block?.type === 'text' && block.text) blocks.push({ type: 'text', text: block.text })
    else if (block?.type === 'image_url' || block?.type === 'image') images += 1
  }
  if (images > 0) blocks.push({ type: 'text', text: `有 ${images} 张图像没能交给 DSH 模型。需要看像素时请改用密钥模式。` })
  if (blocks.length === 0) blocks.push({ type: 'text', text: '请继续。' })
  return blocks
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
