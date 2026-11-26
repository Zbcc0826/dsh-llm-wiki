/**
 * LLM Wiki。原料只读，维基按校验过的补丁写入。
 * 需要模型时先问用户：用 DSH 里已有的模型、另提供环境变量密钥，或不做插件里的模型任务。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { queryGraph } from './graph.js'
import { decideLlm, readMode } from './llm-mode.js'
import { PARSER_SERVICE, createRegistry, externalSlots } from './parsers.js'
import { catalogOf, ensureWiki, orphansOf, wikiRoot } from './store.js'
import { ingest, lint, query } from './workflow.js'

export const name = 'llm-wiki'
export const inject = ['tools']

/** 注册工具和技能。目录在第一次调用时创建。 */
export function apply(ctx) {
  const registry = createRegistry()
  registerSkill(ctx)
  if (typeof ctx.provide === 'function') {
    ctx.provide(PARSER_SERVICE, {
      register: (parser) => registry.register(parser),
      list: () => registry.list(),
      accept: (document) => registry.accept(document),
      external: () => externalSlots(registry.list()),
    })
  }

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
        orphans: orphansOf(root),
        parsers: registry.list(),
        external: externalSlots(registry.list()),
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
      return JSON.stringify({ ok: true, parsers: registry.list(), external: externalSlots(registry.list()) })
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
    description: '把一份材料解析后写入知识维基。路径、文本、parsed 三者只能给一个。parsed 是其他插件交来的 PDF、Office 或音视频成果。批准后才写，原料不会被修改。',
    parameters: {
      path: { type: 'string', description: '原料文件的路径' },
      text: { type: 'string', description: '直接给出的文本。与 path 二选一' },
      title: { type: 'string', description: '材料标题' },
      mediaType: { type: 'string', description: '媒体类型，例如 application/json 或 text/html' },
      parsed: { type: 'string', description: '其他插件已经解析好的 PDF、Office 或音视频成果，JSON 字符串。与 path、text 三选一。' },
      llm: { type: 'string', description: '用户已经选定的做法：dsh、key 或 off。没选过就不要代填，让插件直接问用户。' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const chosen = await choose(ctx, exec, 'wiki_ingest', args.llm)
      if (!chosen.ok) return JSON.stringify(chosen)
      const result = await ingest({
        root: wikiRoot(),
        input: args,
        registry,
        complete: chosen.complete,
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
      llm: { type: 'string', description: '用户已经选定的做法：dsh、key 或 off。没选过就不要代填，让插件直接问用户。' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const chosen = await choose(ctx, exec, 'wiki_query', args.llm)
      if (!chosen.ok) return JSON.stringify(chosen)
      const result = await query({
        root: wikiRoot(),
        question: args.question,
        file: args.file === true,
        complete: chosen.complete,
        approve: (copy) => askApproval(ctx, exec, 'wiki_query', copy),
      })
      return JSON.stringify(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_graph',
    description: '从某个实体、事件或名字出发，沿关系走若干跳。不调用模型。predicate 可只走一种谓语。',
    parameters: {
      start: { type: 'string', required: true, description: '页标识、标题或别名，例如 entity/acme' },
      hops: { type: 'integer', description: '最多走几跳，0 到 4，默认 2' },
      predicate: { type: 'string', description: '只走这一种关系，例如 works-for。不填则关系、链接和矛盾都走' },
    },
    output: textOutput(),
    async execute(args) {
      const root = wikiRoot()
      ensureWiki(root)
      return JSON.stringify(queryGraph(catalogOf(root).pages, {
        start: args.start,
        hops: args.hops,
        predicate: args.predicate,
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_lint',
    description: '检查断链、孤立页、不完整材料和矛盾指向。apply 为 true 时才修改已有页面，不新建，也不删除依据。',
    parameters: {
      apply: { type: 'boolean', description: '为 true 时提交修改' },
      llm: { type: 'string', description: '用户已经选定的做法：dsh、key 或 off。只在 apply 为 true 且还没选过时需要。' },
    },
    output: textOutput(),
    async execute(args, exec) {
      let complete
      if (args.apply === true) {
        const chosen = await choose(ctx, exec, 'wiki_lint', args.llm)
        if (!chosen.ok) return JSON.stringify(chosen)
        complete = chosen.complete
      }
      const result = await lint({
        root: wikiRoot(),
        apply: args.apply === true,
        complete,
        approve: (copy) => askApproval(ctx, exec, 'wiki_lint', copy),
      })
      return JSON.stringify(result)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_llm',
    description: '查看或更改插件里的模型任务怎么做：dsh 用 DSH 已有模型，key 用环境变量密钥，off 不做模型任务。更改前会再问一次用户。',
    parameters: {
      llm: { type: 'string', description: '要改成的做法：dsh、key 或 off。不传则只查看当前选择。' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const root = wikiRoot()
      ensureWiki(root)
      if (args.llm == null || args.llm === '') return JSON.stringify({ ok: true, mode: readMode(root) || null })
      const chosen = await decideLlm({
        root,
        llm: args.llm,
        change: true,
        agent: exec?.agent,
        llmRuntime: ctx.get?.('llm'),
        approve: (copy) => askApproval(ctx, exec, 'wiki_llm', copy),
      })
      if (!chosen.ok) return JSON.stringify(chosen)
      return JSON.stringify({ ok: true, mode: chosen.mode })
    },
  }))
}

/** 摄入、提问和改写在调用模型前先选定做法。查阅类工具不走这里。 */
async function choose(ctx, exec, tool, llm) {
  const root = wikiRoot()
  ensureWiki(root)
  return decideLlm({
    root,
    llm,
    agent: exec?.agent,
    llmRuntime: ctx.get?.('llm'),
    approve: (copy) => askApproval(ctx, exec, tool, copy),
  })
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
  const skills = ctx.get?.('skills')
  if (!skills?.register) return
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'SKILL.md')
    const raw = readFileSync(file, 'utf8')
    const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    const content = raw.replace(/^---[\s\S]*?---\n/, '')
    if (!description || !content.trim()) throw new Error('SKILL.md 缺少 description 或正文')
    skills.register({ name: 'llm-wiki', description, content, source: 'runtime' })
  } catch (error) {
    const message = `llm-wiki 技能注册失败：${error instanceof Error ? error.message : error}`
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
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
