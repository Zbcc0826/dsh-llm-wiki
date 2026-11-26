/**
 * LLM Wiki。原料只读，维基按校验过的补丁写入。
 * 需要模型时请求 deepseek-v4-flash，也就是这里能用的 dsv4.1flash。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { complete } from './llm.js'
import { createRegistry } from './parsers.js'
import { catalogOf, ensureWiki, wikiRoot } from './store.js'
import { ingest, lint, query } from './workflow.js'

export const name = 'llm-wiki'
export const inject = ['tools']

/** 注册工具和技能。目录在第一次调用时创建。 */
export function apply(ctx) {
  const registry = createRegistry()
  registerSkill(ctx)

  ctx.tools.register(defineTool({
    name: 'wiki_status',
    description: '查看知识维基有多少页、用哪些解析器、最近写过什么。不调用模型，不计费。',
    parameters: {},
    output: textOutput(),
    async execute() {
      const root = wikiRoot()
      ensureWiki(root)
      const catalog = catalogOf(root)
      return JSON.stringify({
        ok: true,
        root,
        pages: catalog.total,
        truncated: catalog.truncated,
        broken: catalog.broken,
        parsers: registry.list(),
        recent: recentLog(root),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_parsers',
    description: '列出当前能解析的材料类型。没有列出的类型会在摄入时返回 NO_PARSER。',
    parameters: {},
    output: textOutput(),
    async execute() {
      return JSON.stringify({ ok: true, parsers: registry.list() })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_read',
    description: '按种类/slug 读取一页，例如 entity/li。不调用模型。',
    parameters: {
      slug: { type: 'string', required: true, description: '种类/slug' },
    },
    output: textOutput(),
    async execute(args) {
      const root = wikiRoot()
      ensureWiki(root)
      const page = catalogOf(root).pages.find((item) => `${item.kind}/${item.slug}` === args.slug)
      if (!page) return JSON.stringify({ ok: false, code: 'MISSING', slug: args.slug })
      return JSON.stringify({ ok: true, page })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_ingest',
    description: '把一份材料解析后写入知识维基。路径和文本只能给一个。批准后才写，原料不会被修改。',
    parameters: {
      path: { type: 'string', description: '原料文件的路径' },
      text: { type: 'string', description: '直接给出的文本。与 path 二选一' },
      title: { type: 'string', description: '材料标题' },
      mediaType: { type: 'string', description: '媒体类型，例如 application/json 或 text/html' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const result = await ingest({
        root: wikiRoot(),
        input: args,
        registry,
        complete,
        approve: (copy) => askApproval(ctx, exec, 'wiki_ingest', copy),
      })
      return JSON.stringify(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_query',
    description: '先从维基里取出证据再回答。词面、本地向量、链接过去的页和互相矛盾的两面都会进入证据。不读取原料。只有 file 为 true 时才把答案收成新页，并且需要批准。',
    parameters: {
      question: { type: 'string', required: true, description: '要问的问题' },
      file: { type: 'boolean', description: '为 true 时把答案留下' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const result = await query({
        root: wikiRoot(),
        question: args.question,
        file: args.file === true,
        complete,
        approve: (copy) => askApproval(ctx, exec, 'wiki_query', copy),
      })
      return JSON.stringify(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_lint',
    description: '检查断链、孤立页、不完整材料和矛盾指向。apply 为 true 时才修改已有页面，不新建，也不删除依据。',
    parameters: {
      apply: { type: 'boolean', description: '为 true 时提交修改' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const result = await lint({
        root: wikiRoot(),
        apply: args.apply === true,
        complete,
        approve: (copy) => askApproval(ctx, exec, 'wiki_lint', copy),
      })
      return JSON.stringify(result)
    },
  }))
}

/** 没有审批服务时返回 unavailable，调用方据此不写盘。 */
async function askApproval(ctx, exec, tool, copy) {
  const approval = ctx.get?.('approval')
  if (!approval?.request || !exec?.agent) return 'unavailable'
  try {
    return await approval.request({
      agent: exec.agent,
      toolName: tool,
      callId: exec.callId,
      reason: copy.zh,
      displayReason: { en: copy.en, zh: copy.zh },
    })
  } catch {
    return 'unavailable'
  }
}

function registerSkill(ctx) {
  try {
    const skills = ctx.get?.('skills')
    if (!skills?.register) return
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'SKILL.md')
    const raw = readFileSync(file, 'utf8')
    const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    const content = raw.replace(/^---[\s\S]*?---\n/, '')
    if (!description || !content.trim()) return
    skills.register({ name: 'llm-wiki', description, content })
  } catch {
    // 没有技能服务时，工具仍然可用。
  }
}

function recentLog(root) {
  try {
    return readFileSync(path.join(root, 'log.md'), 'utf8').split('\n').filter((line) => line.startsWith('## [')).slice(-5)
  } catch {
    return []
  }
}

function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}
