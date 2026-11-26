/**
 * 解析、补丁和写入。不访问网络，不读真实密钥。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { extractJson, loadKey, MODEL, redact } from './llm.js'
import { parsePage, readPages, serializePage, writePage } from './pages.js'
import { acceptParsed, createRegistry, externalSlots } from './parsers.js'
import { queryGraph } from './graph.js'
import { validateIngest } from './patch.js'
import { presentSource } from './present.js'
import { splitSource } from './split.js'
import { hitsAtK, retrieve } from './retrieve.js'
import { EMBED_MODEL, createEmbedder } from './embed.js'
import { orphansOf, rebuildIndex, wikiRoot } from './store.js'
import { ingest, lint, localFindings, query } from './workflow.js'

test('解析器区分文本、表格、JSON、HTML，不认识的类型不假装成功', () => {
  const registry = createRegistry()
  const html = registry.parse({ path: 'a.html', text: '<html><title>标题</title><script>secret()</script><p>正文</p></html>' })
  assert.equal(html.ok, true)
  assert.equal(html.parser, 'html')
  assert.equal(html.text.includes('secret'), false)
  assert.equal(html.text.includes('正文'), true)
  const csv = registry.parse({ path: 'a.csv', text: 'name,n\n河,1\n' })
  assert.equal(csv.parser, 'csv')
  assert.match(csv.text, /\| name \| n \|/)
  const json = registry.parse({ path: 'a.json', text: '{"place":"河","years":[1,2,3]}' })
  assert.equal(json.parser, 'json')
  assert.match(json.text, /place/)
  assert.match(json.text, /长度 3/)
  const markdown = registry.parse({ path: 'a.md', text: '# 河\n\n向东' })
  assert.equal(markdown.title, '河')
  const plain = registry.parse({ text: '只有文字' })
  assert.equal(plain.parser, 'plain')
  const pdf = registry.parse({ path: 'a.pdf', mediaType: 'application/pdf', text: '%PDF' })
  assert.equal(pdf.ok, false)
  assert.equal(pdf.code, 'NEED_EXTERNAL_PARSER')
  assert.equal(pdf.family, 'pdf')
  const zip = registry.parse({ path: 'a.zip', mediaType: 'application/zip', text: 'PK' })
  assert.equal(zip.code, 'NO_PARSER')
})

test('外部解析成果保留位置和表格，原始字节单独保存', async () => {
  const registry = createRegistry()
  const registered = registry.register({
    id: 'pdf',
    mediaTypes: ['application/pdf'],
    accepts: (input) => input.mediaType === 'application/pdf',
    parse: () => ({ document: { parser: 'pdf', mediaType: 'application/pdf', title: '合同', text: '第一页正文' } }),
  })
  assert.equal(registered.ok, true)
  const viaParser = registry.parse({ path: 'a.pdf', mediaType: 'application/pdf', bytes: Buffer.from('%PDF') })
  assert.equal(viaParser.ok, true)
  assert.equal(viaParser.text, '第一页正文')
  assert.equal(externalSlots(registry.list()).find((item) => item.family === 'pdf').ready, true)
  registered.dispose()
  assert.equal(registry.parse({ path: 'a.pdf', mediaType: 'application/pdf' }).code, 'NEED_EXTERNAL_PARSER')
  assert.equal(registry.register({ id: 'PDF', mediaTypes: ['application/pdf'], accepts() {}, parse() {} }).code, 'BAD_PARSER')

  const original = Buffer.from('pdf-bytes')
  const table = '| 指标 | 数值 |\n| --- | --- |\n| 稀释每股收益 | -0.16 |'
  const preview = acceptParsed({
    parser: 'demo-pdf',
    mediaType: 'application/pdf',
    title: '年报',
    source: { name: '年报.pdf', base64: original.toString('base64') },
    parts: [{ role: 'table', locator: '第4页', text: table }],
  })
  assert.equal(preview.ok, true)
  assert.match(preview.text, /位置：第4页/)
  assert.match(preview.text, /稀释每股收益/)
  assert.match(preview.text, /-0\.16/)
  const root = tempWiki()
  const seen = []
  const result = await ingest({
    root,
    input: {
      title: '年报',
      parsed: {
        parser: 'demo-pdf',
        mediaType: 'application/pdf',
        title: '年报',
        source: { name: '年报.pdf', base64: original.toString('base64') },
        parts: [{ role: 'table', locator: '第4页', text: table }],
      },
    },
    approve: async () => 'allowed-once',
    complete: async (messages) => {
      seen.push(JSON.parse(messages.at(-1).content))
      return {
        ok: true,
        model: 'deepseek-flash',
        text: JSON.stringify({
          summary: '记下年报',
          pages: [{
            kind: 'source', slug: 'report', title: '年报', summary: '有一张表', body: '见表。',
            sources: [seen.at(-1).hash], aliases: ['年报'], claims: ['稀释每股收益为 -0.16'],
          }],
        }),
      }
    },
  })
  assert.equal(result.ok, true, result.message)
  assert.match(seen[0].source, /位置：第4页/)
  assert.match(seen[0].source, /-0\.16/)
  const rawFile = readdirSync(path.join(root, 'raw')).find((name) => name.endsWith('.pdf'))
  assert.equal(readFileSync(path.join(root, 'raw', rawFile)).equals(original), true)
  const meta = JSON.parse(readFileSync(path.join(root, 'raw', `${result.hash}.meta.json`), 'utf8'))
  assert.equal(meta.parser, 'demo-pdf')
  assert.equal(meta.mediaType, 'application/pdf')
  assert.equal(meta.origin, 'parsed:demo-pdf')
  const both = await ingest({
    root,
    input: { path: 'a.pdf', parsed: { parser: 'demo-pdf', mediaType: 'application/pdf', text: 'x' } },
    approve: async () => 'allowed-once',
    complete: async () => { throw new Error('两种材料不应调用模型') },
  })
  assert.equal(both.code, 'BOTH_SOURCE')
})

test('实体、事件和关系可以沿边查询', async () => {
  const hash = 'a'.repeat(64)
  const pages = [
    { kind: 'entity', slug: 'vendor', title: '供应商', summary: '供货方', body: 'zephyr-supply', aliases: ['乙方'], claims: [], relations: ['supplies entity/plant'], contradicts: [], sources: [hash], partial: false },
    { kind: 'entity', slug: 'plant', title: '整车厂', summary: '买方', body: '甲方。', aliases: [], claims: [], relations: ['party-to event/claim'], contradicts: [], sources: [hash], partial: false },
    { kind: 'event', slug: 'claim', title: '质量纠纷', summary: '索赔', body: '责任上限有两套约定。', aliases: [], claims: [], relations: [], contradicts: [], sources: [hash], partial: false },
  ]
  const findings = localFindings(pages)
  assert.equal(findings.some((item) => item.id === 'event/claim' && item.code === 'ORPHAN'), false)
  assert.equal(findings.some((item) => item.id === 'entity/plant' && item.code === 'ORPHAN'), false)
  assert.equal(findings.some((item) => item.id === 'entity/vendor' && item.code === 'ORPHAN'), true)
  const broken = localFindings([{ ...pages[0], relations: ['party-to event/missing'] }])
  assert.equal(broken.some((item) => item.code === 'MISSING_RELATION' && item.target === 'event/missing'), true)
  const walked = queryGraph(pages, { start: '乙方', hops: 2 })
  assert.equal(walked.ok, true)
  assert.deepEqual(walked.roots, ['entity/vendor'])
  assert.equal(walked.nodes.some((node) => node.id === 'event/claim'), true)
  const supplies = queryGraph(pages, { start: 'entity/vendor', hops: 2, predicate: 'supplies' })
  assert.equal(supplies.nodes.some((node) => node.id === 'event/claim'), false)
  assert.equal(supplies.edges.some((edge) => edge.type === 'supplies' && edge.to === 'entity/plant'), true)
  const back = queryGraph(pages, { start: 'event/claim', hops: 2 })
  assert.equal(back.nodes.some((node) => node.id === 'entity/vendor'), true)
  const dropped = validateIngest({
    summary: '更新',
    pages: [{
      kind: 'entity', slug: 'vendor', title: '供应商', summary: '供货方', body: '乙方。',
      sources: [hash], relations: [], update: true,
    }],
  }, { hash, existing: new Map([['entity/vendor', pages[0]]]) })
  assert.equal(dropped.code, 'INDEX_DROPPED')
  const filler = Array.from({ length: 45 }, (_item, index) => ({
    kind: 'source', slug: `pad${index}`, title: `pad${index}`, summary: 'pad', body: 'weather report', contradicts: [], relations: [], partial: false,
  }))
  const found = await retrieve('zephyr-supply', [...filler, ...pages], { embed: false, semantic: false, scanLimit: 40 })
  assert.equal(hitsAtK(found.hits, ['entity/plant']), 1)
  const root = tempWiki()
  const filed = await ingest({
    root,
    input: { text: '乙方给整车厂供货，后来发生质量纠纷。', title: '纠纷' },
    approve: async () => 'allowed-once',
    complete: async (messages) => {
      const sourceHash = JSON.parse(messages.at(-1).content).hash
      return {
        ok: true,
        model: 'deepseek-flash',
        text: JSON.stringify({
          summary: '记下纠纷',
          pages: [
            { kind: 'entity', slug: 'vendor', title: '供应商', summary: '供货方', body: '乙方。', sources: [sourceHash], aliases: ['乙方'], relations: ['supplies entity/plant'] },
            { kind: 'entity', slug: 'plant', title: '整车厂', summary: '买方', body: '甲方。', sources: [sourceHash], relations: ['party-to event/claim'] },
            { kind: 'event', slug: 'claim', title: '质量纠纷', summary: '索赔', body: '两套责任上限。', sources: [sourceHash] },
          ],
        }),
      }
    },
  })
  assert.equal(filed.ok, true, filed.message)
  const stored = readPages(root).pages
  assert.equal(stored.some((page) => page.kind === 'event' && page.slug === 'claim'), true)
  const graph = queryGraph(stored, { start: '乙方', hops: 2 })
  assert.equal(graph.nodes.some((node) => node.id === 'event/claim'), true)
})

test('超长材料会标明不完整', () => {
  const shown = presentSource({ text: '1234567890', parser: 'plain', title: '长' }, { maxChars: 4 })
  assert.equal(shown.partial, true)
  assert.match(shown.text, /材料未完整交给模型/)
  assert.equal(presentSource({ text: '短', partial: false }).partial, false)
})

test('长材料按表格切开，表头和数字留在同一段', () => {
  const table = ['| 指标 | 数值 |', '| --- | --- |', '| 稀释每股收益 | -0.16 |', '| 责任上限 | 6300万 |'].join('\n')
  const text = ['# 年报', '', '这是年报表前的说明，用来占满第一段。', '', table, '', '# 附件', '', '责任上限为合同总金额的百分之百。'].join('\n')
  const split = splitSource(text, { maxChars: 80 })
  assert.equal(split.segments.length > 1, true)
  const holding = split.segments.find((item) => item.text.includes('-0.16'))
  assert.ok(holding)
  assert.match(holding.text, /稀释每股收益/)
  assert.match(holding.text, /\| --- \|/)
  const other = split.segments.find((item) => item.text.includes('百分之百'))
  assert.equal(other.text.includes('-0.16'), false)
  const wide = ['| 项 | 值 |', '| --- | --- |', ...Array.from({ length: 6 }, (_item, index) => `| 项 | ${index} |`)].join('\n')
  const rows = splitSource(wide, { maxChars: 40 })
  assert.equal(rows.segments.length > 1, true)
  for (const segment of rows.segments) {
    assert.match(segment.text, /\| 项 \| 值 \|/)
    assert.match(segment.text, /\| --- \|/)
  }
})

test('长材料分成多段，共用一份原料和索引头', async () => {
  const root = tempWiki()
  const calls = []
  const table = ['| 指标 | 数值 |', '| --- | --- |', '| 稀释每股收益 | -0.16 |'].join('\n')
  const text = `# 年报\n\n${'说明'.repeat(40)}\n\n${table}\n\n# 附件\n\n${'上限'.repeat(40)}`
  const result = await ingest({
    root,
    input: { text, title: '年报' },
    maxChars: 90,
    now: () => new Date('2026-11-26T00:00:00.000Z'),
    approve: async () => 'allowed-once',
    complete: async (messages) => {
      calls.push(JSON.parse(messages.at(-1).content))
      const payload = calls.at(-1)
      return {
        ok: true,
        model: 'deepseek-flash',
        text: JSON.stringify({
          summary: '分段',
          pages: [{
            kind: 'source',
            slug: 'ignored',
            title: '模型标题',
            summary: '模型摘要',
            body: '模型只写了摘要',
            sources: [payload.hash],
            aliases: ['年报'],
            claims: ['这一段已核对'],
          }],
        }),
      }
    },
  })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.partial, false)
  assert.equal(calls.length, result.segments)
  assert.equal(calls.length > 1, true)
  assert.equal(new Set(calls.map((item) => item.hash)).size, 1)
  const pages = readPages(root).pages
  const index = pages.find((page) => page.slug.startsWith('src-') && !/-\d+$/.test(page.slug))
  assert.match(index.body, /索引头相同/)
  assert.equal(index.partial, false)
  const parts = pages.filter((page) => /-\d+$/.test(page.slug))
  assert.equal(parts.length, calls.length)
  assert.equal(parts.every((page) => page.sources.includes(result.hash) && page.aliases.includes('年报')), true)
  assert.equal(parts.every((page) => page.locator.includes('年报')), true)
  const earnings = parts.find((page) => page.body.includes('-0.16'))
  assert.match(earnings.body, /稀释每股收益/)
  assert.equal(earnings.body.includes('模型只写了摘要'), false)
  assert.equal(parts.some((page) => page.body.includes('上限') && !page.body.includes('-0.16')), true)
  assert.equal(parts.every((page) => page.partial !== true), true)
  assert.equal(readdirSync(path.join(root, 'raw')).filter((name) => name.endsWith('.meta.json')).length, 1)
  const failedRoot = tempWiki()
  let attempts = 0
  const failed = await ingest({
    root: failedRoot,
    input: { text, title: '年报' },
    maxChars: 90,
    approve: async () => 'allowed-once',
    complete: async (messages) => {
      attempts += 1
      if (attempts > 1) return { ok: false, code: 'UPSTREAM', message: '第二段失败' }
      const payload = JSON.parse(messages.at(-1).content)
      return {
        ok: true,
        model: 'deepseek-flash',
        text: JSON.stringify({
          summary: '分段',
          pages: [{
            kind: 'source', slug: 'ignored', title: '模型标题', summary: '模型摘要', body: '模型只写了摘要', sources: [payload.hash],
          }],
        }),
      }
    },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'UPSTREAM')
  assert.equal(readdirSync(path.join(failedRoot, 'raw')).filter((name) => !name.startsWith('.')).length, 0)
  assert.equal(readPages(failedRoot).pages.length, 0)
  assert.match(readFileSync(path.join(failedRoot, 'log.md'), 'utf8'), /失败 UPSTREAM/)
  const cappedRoot = tempWiki()
  const capped = await ingest({
    root: cappedRoot,
    input: { text: `${'甲'.repeat(80)}\n\n${'乙'.repeat(80)}`, title: '长文' },
    maxChars: 50,
    maxSegments: 1,
    approve: async () => 'allowed-once',
    complete: async (messages) => {
      const payload = JSON.parse(messages.at(-1).content)
      return {
        ok: true,
        model: 'deepseek-flash',
        text: JSON.stringify({
          summary: '只纳入开头',
          pages: [{
            kind: 'source', slug: 'ignored', title: '长文', summary: '开头', body: '开头', sources: [payload.hash],
          }],
        }),
      }
    },
  })
  assert.equal(capped.ok, true, capped.message)
  assert.equal(capped.partial, true)
  const cappedPages = readPages(cappedRoot).pages
  const cappedIndex = cappedPages.find((page) => !/-\d+$/.test(page.slug))
  assert.equal(cappedIndex.partial, true)
  assert.match(cappedIndex.body, /没有纳入/)
  assert.equal(cappedPages.some((page) => page.body.includes('乙')), false)
})

test('页面头可以写回，slug 和路径穿越不能进补丁', () => {
  const page = parsePage(serializePage({
    kind: 'entity',
    slug: 'li',
    title: '李',
    summary: '一个人',
    partial: false,
    updated: '2026-11-25T00:00:00.000Z',
    sources: ['a'.repeat(64)],
    cites: [],
    contradicts: ['concept/name'],
    body: '正文',
  }))
  assert.equal(page.ok, true)
  assert.equal(page.title, '李')
  assert.deepEqual(page.sources, ['a'.repeat(64)])
  const rewritten = validateIngest({
    summary: 'x',
    pages: [{ kind: 'entity', slug: '../raw', title: '坏', summary: '坏', body: '坏', sources: ['a'.repeat(64)] }],
  }, { hash: 'a'.repeat(64), existing: new Map() })
  assert.equal(rewritten.ok, true)
  assert.equal(rewritten.pages[0].slug, 'huai')
  assert.equal(rewritten.pages[0].slug.includes('/'), false)
  const blind = validateIngest({
    summary: 'x',
    pages: [{ kind: 'entity', slug: '***', title: '***', summary: '坏', body: '坏', sources: ['a'.repeat(64)] }],
  }, { hash: 'a'.repeat(64), existing: new Map() })
  assert.equal(blind.code, 'BAD_PATCH')
  assert.equal(blind.field, 'slug')
  assert.equal(blind.value, '***')
  assert.equal(blind.rule, '^[a-z0-9]+(?:-[a-z0-9]+)*$')
})

test('非法 slug 按标题转写，BAD_PATCH 带回值和规则', async () => {
  const hash = 'b'.repeat(64)
  const pages = [
    { kind: 'entity', slug: '星桥科技', title: '星桥科技', summary: '公司', body: '做光学。', sources: [hash] },
    { kind: 'entity', slug: 'Northwind Logistics', title: 'Northwind Logistics', summary: '客户', body: '在北方。', sources: [hash] },
    { kind: 'event', slug: '成立年份', title: '成立年份', summary: '年份', body: '二零一九。', sources: [hash] },
  ]
  const checked = validateIngest({ summary: '三份', pages }, { hash, existing: new Map() })
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.pages.map((page) => page.slug), ['xing-qiao-ke-ji', 'northwind-logistics', 'cheng-li-nian-fen'])
  const root = tempWiki()
  const failed = await ingest({
    root,
    input: { text: '# 河\n\n向东', title: '河' },
    now: () => new Date('2026-11-25T00:00:00.000Z'),
    complete: async () => ({
      ok: true,
      model: 'deepseek-flash',
      text: JSON.stringify({ summary: '缺摘要', pages: [{ kind: 'source', slug: 'river', title: '河', summary: '', body: '向东', sources: [hash] }] }),
    }),
    approve: async () => 'allowed-once',
  })
  assert.equal(failed.field, 'summary')
  assert.equal(failed.value, '')
  assert.match(readFileSync(path.join(root, 'log.md'), 'utf8'), /失败 BAD_PATCH summary= rule=1到200字/)
  rmSync(root, { recursive: true, force: true })
})

test('摄入在批准后写页面和日志，拒绝或坏补丁不落盘', async () => {
  const root = tempWiki()
  const now = () => new Date('2026-11-25T00:00:00.000Z')
  const refused = await ingest({
    root,
    input: { text: '# 河\n\n向东', title: '河' },
    now,
    complete: modelPatch,
    approve: async () => 'deny',
  })
  assert.equal(refused.code, 'NOT_APPROVED')
  assert.equal(refused.approved, false)
  assert.equal(refused.outcome, 'deny')
  assert.equal(existsSync(path.join(root, 'pages', 'source', 'river.md')), false)
  assert.equal(readdirSync(path.join(root, 'raw')).length, 0)

  const broken = await ingest({
    root,
    input: { text: '# 河\n\n向东', title: '河' },
    now,
    complete: async () => ({ ok: true, model: 'deepseek-flash', text: '这不是补丁' }),
    approve: async () => 'allowed-once',
  })
  assert.equal(broken.code, 'BAD_PATCH')
  assert.equal(existsSync(path.join(root, 'pages', 'source', 'river.md')), false)

  const saved = await ingest({
    root,
    input: { text: '# 河\n\n向东', title: '河' },
    now,
    complete: modelPatch,
    approve: async () => 'allowed-once',
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.approved, true)
  assert.equal(saved.outcome, 'allowed-once')
  assert.equal(saved.pages[0], 'source/river')
  const page = parsePage(readFileSync(path.join(root, 'pages', 'source', 'river.md'), 'utf8'))
  assert.equal(page.sources[0], saved.hash)
  assert.match(readFileSync(path.join(root, 'index.md'), 'utf8'), /\[\[source\/river\]\]/)
  assert.match(readFileSync(path.join(root, 'log.md'), 'utf8'), /^## \[2026-11-25\] ingest \| 河/m)
  const raw = readFileSync(path.join(root, 'raw', `${saved.hash}.txt`), 'utf8')
  writeFileSync(path.join(root, 'raw', `${saved.hash}.txt`), '被人改过')
  await ingest({
    root,
    input: { text: '# 河\n\n向东', title: '河' },
    now,
    complete: async (messages) => {
      const hash = JSON.parse(messages.at(-1).content).hash
      return { ok: true, model: 'deepseek-flash', text: JSON.stringify({ summary: '再次', pages: [{ kind: 'source', slug: 'river', title: '河', summary: '仍向东', body: '仍向东', sources: [hash], update: true }] }) }
    },
    approve: async () => 'allowed-once',
  })
  assert.equal(readFileSync(path.join(root, 'raw', `${saved.hash}.txt`), 'utf8'), '被人改过')
  rmSync(root, { recursive: true, force: true })
})

test('更新必须声明，并且不能丢掉旧来源', async () => {
  const root = tempWiki()
  await ingest({
    root,
    input: { text: '第一份', title: '第一' },
    now: () => new Date('2026-11-25T00:00:00.000Z'),
    complete: modelPatch,
    approve: async () => 'allowed-once',
  })
  const forgotten = await ingest({
    root,
    input: { text: '第二份', title: '第二' },
    now: () => new Date('2026-11-25T00:00:00.000Z'),
    complete: async (messages) => {
      const hash = JSON.parse(messages.at(-1).content).hash
      return { ok: true, model: 'deepseek-flash', text: JSON.stringify({ summary: '覆盖', pages: [{ kind: 'source', slug: 'river', title: '河', summary: '新的', body: '新的', sources: [hash] }] }) }
    },
    approve: async () => 'allowed-once',
  })
  assert.equal(forgotten.code, 'EXISTS')
  const dropped = await ingest({
    root,
    input: { text: '第二份', title: '第二' },
    now: () => new Date('2026-11-25T00:00:00.000Z'),
    complete: async (messages) => {
      const hash = JSON.parse(messages.at(-1).content).hash
      return { ok: true, model: 'deepseek-flash', text: JSON.stringify({ summary: '丢掉旧的', pages: [{ kind: 'source', slug: 'river', title: '河', summary: '新的', body: '新的', sources: [hash], update: true }] }) }
    },
    approve: async () => 'allowed-once',
  })
  assert.equal(dropped.code, 'SOURCE_DROPPED')
  rmSync(root, { recursive: true, force: true })
})

test('查询不读空维基，默认不归档，批准后才留下提问页', async () => {
  const root = tempWiki()
  const empty = await query({ root, question: '河往哪流', complete: async () => ({ ok: false, code: 'SHOULD_NOT_CALL' }), approve: async () => 'allowed-once' })
  assert.equal(empty.code, 'EMPTY_WIKI')
  await ingest({
    root,
    input: { text: '河向东', title: '河' },
    now: () => new Date('2026-11-25T00:00:00.000Z'),
    complete: modelPatch,
    approve: async () => 'allowed-once',
  })
  let calls = 0
  const answer = await query({
    root,
    question: '河往哪流',
    embed: false,
    complete: async (messages) => {
      calls += 1
      if (calls === 1) return { ok: true, model: 'deepseek-flash', text: '{"slugs":["source/river","raw/secret"]}' }
      return { ok: true, model: 'deepseek-flash', text: JSON.stringify({ answer: '向东', citations: ['source/river', 'raw/secret'], slug: 'where', title: '流向', summary: '向东', body: '河向东。' }) }
    },
    approve: async () => { throw new Error('不应审批') },
  })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.citations, ['source/river'])
  assert.equal(existsSync(path.join(root, 'pages', 'query', 'where.md')), false)
  const filed = await query({
    root,
    question: '河往哪流',
    file: true,
    embed: false,
    complete: async (messages) => {
      const task = messages[0].content
      if (task.includes('slugs')) return { ok: true, model: 'deepseek-flash', text: '{"slugs":["source/river"]}' }
      return { ok: true, model: 'deepseek-flash', text: JSON.stringify({ answer: '向东', citations: ['source/river'], slug: 'where', title: '流向', summary: '向东', body: '见 [[source/river]]。' }) }
    },
    approve: async () => 'allowed-once',
  })
  assert.equal(filed.filed, 'query/where')
  rmSync(root, { recursive: true, force: true })
})

test('体检默认只报告，apply 不能新建页面', async () => {
  const root = tempWiki()
  await ingest({
    root,
    input: { text: '单独一页', title: '单独' },
    now: () => new Date('2026-11-25T00:00:00.000Z'),
    complete: modelPatch,
    approve: async () => 'allowed-once',
  })
  const report = await lint({ root, complete: async () => ({ ok: false, code: 'SHOULD_NOT_CALL' }) })
  assert.equal(report.applied, false)
  assert.equal(report.findings.some((item) => item.code === 'ORPHAN'), false)
  const created = await lint({
    root,
    apply: true,
    complete: async () => ({
      ok: true,
      model: 'deepseek-flash',
      text: JSON.stringify({ summary: '新页', pages: [{ kind: 'concept', slug: 'water', title: '水', summary: '新的', body: '新的', sources: [], update: true }] }),
    }),
    approve: async () => 'allowed-once',
  })
  assert.equal(created.code, 'LINT_CREATE')
  assert.equal(existsSync(path.join(root, 'pages', 'concept', 'water.md')), false)
  rmSync(root, { recursive: true, force: true })
})

test('图式已有内容时摄入不覆盖', async () => {
  const root = tempWiki()
  writeFileSync(path.join(root, 'schema.md'), '人改过的图式\n')
  await ingest({
    root,
    input: { text: '材料', title: '材料' },
    now: () => new Date('2026-11-25T00:00:00.000Z'),
    complete: modelPatch,
    approve: async () => 'allowed-once',
  })
  assert.equal(readFileSync(path.join(root, 'schema.md'), 'utf8'), '人改过的图式\n')
  rmSync(root, { recursive: true, force: true })
})

test('密钥不出现在错误文本里，模型名用 deepseek-v4-flash', () => {
  assert.equal(MODEL, 'deepseek-v4-flash')
  const key = 'sk-test-secret'
  assert.equal(redact(`bearer ${key} failed`, key).includes(key), false)
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'wiki-key-')), 'key')
  writeFileSync(file, 'from-file\n')
  assert.equal(loadKey({ DEEPSEEK_KEY_FILE: file }, readFileSync), 'from-file')
  assert.equal(loadKey({ DEEPSEEK_API_KEY: 'from-env', DEEPSEEK_KEY_FILE: file }, readFileSync), 'from-env')
  assert.equal(loadKey({}, () => { throw new Error('nope') }), '')
  assert.equal(extractJson('前文 {"a":1} 后文').a, 1)
  assert.equal(extractJson('{"a":'), null)
  assert.equal(wikiRoot({ LLM_WIKI_ROOT: '/tmp/wiki-root' }), '/tmp/wiki-root')
})

test('插件入口注册八个工具', async () => {
  if (!existsSync(path.resolve('node_modules/@deepseek-ai/dsh-tools/package.json'))) return
  const loaded = await import('./index.js')
  assert.equal(loaded.name, 'llm-wiki')
  const names = []
  let provided = null
  loaded.apply({
    tools: { register(tool) { names.push(tool.name) } },
    provide(name, value) { provided = { name, value } },
    get() { return null },
  })
  assert.deepEqual(names, ['wiki_status', 'wiki_parsers', 'wiki_read', 'wiki_ingest', 'wiki_query', 'wiki_graph', 'wiki_lint', 'wiki_llm'])
  assert.equal(provided.name, 'llm-wiki.parsers')
  assert.equal(typeof provided.value.accept, 'function')
  assert.equal(typeof provided.value.register, 'function')
})

test('使用模型前先问用户，选定后记住', async () => {
  const { decideLlm, readMode } = await import('./llm-mode.js')
  const root = tempWiki()
  const pending = await decideLlm({
    root,
    approve: async () => { throw new Error('还没选择，不应询问') },
  })
  assert.equal(pending.code, 'NEED_LLM_CHOICE')
  assert.deepEqual(pending.choices.map((item) => item.id), ['dsh', 'key', 'off'])
  assert.equal(readMode(root), '')
  assert.equal(existsSync(path.join(root, 'llm.json')), false)

  const off = await decideLlm({
    root,
    llm: 'off',
    approve: async (copy) => {
      assert.match(copy.zh, /不做插件里的模型任务/)
      return 'allowed-once'
    },
  })
  assert.equal(off.mode, 'off')
  assert.equal(off.outcome, 'argument')
  assert.equal(readMode(root), 'off')
  assert.deepEqual(await off.complete([{ role: 'user', content: 'hi' }]), { ok: false, code: 'LLM_OFF' })

  const again = await decideLlm({ root, approve: async () => { throw new Error('不应再问') } })
  assert.equal(again.mode, 'off')

  const switched = await decideLlm({
    root,
    llm: 'dsh',
    approve: async () => { throw new Error('工具参数里的选择不再另问') },
  })
  assert.equal(switched.mode, 'dsh')
  assert.equal(readMode(root), 'dsh')
  const stayed = await decideLlm({
    root,
    llm: 'off',
    change: true,
    approve: async () => 'rejected',
  })
  assert.equal(stayed.code, 'NOT_APPROVED')
  assert.equal(stayed.approved, false)
  assert.equal(readMode(root), 'dsh')
  rmSync(root, { recursive: true, force: true })
})

test('缺字段的补丁会再要一次，通过后才落盘', async () => {
  const root = tempWiki()
  let calls = 0
  const saved = await ingest({
    root,
    input: { text: '# 河\n\n向东', title: '河' },
    now: () => new Date('2026-11-25T00:00:00.000Z'),
    complete: async (messages) => {
      calls += 1
      const hash = JSON.parse(messages.find((item) => item.role === 'user').content).hash
      if (calls === 1) {
        return { ok: true, model: 'deepseek-flash', text: JSON.stringify({ pages: [{ kind: 'source', slug: 'river', title: '河', body: '向东。' }] }) }
      }
      assert.match(messages.at(-1).content, /summary/)
      return { ok: true, model: 'deepseek-flash', text: JSON.stringify({ summary: '记下河流', pages: [{ kind: 'source', slug: 'river', title: '河', summary: '向东', body: '河向东。', sources: [hash] }] }) }
    },
    approve: async () => 'allowed-once',
  })
  assert.equal(calls, 2)
  assert.equal(saved.ok, true)
  assert.equal(existsSync(path.join(root, 'pages', 'source', 'river.md')), true)
  rmSync(root, { recursive: true, force: true })
})

test('用户指定用 DSH 模型时走当前会话，不读密钥', async () => {
  const { decideLlm } = await import('./llm-mode.js')
  const root = tempWiki()
  let seen
  const chosen = await decideLlm({
    root,
    llm: 'dsh',
    agent: { model: { current: () => ({ provider: 'deepseek', model: 'dsv4flash' }) } },
    llmRuntime: {
      async *stream(request) {
        seen = request
        yield { type: 'text-delta', text: '{"ok":true}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    approve: async (copy) => {
      assert.match(copy.zh, /dsv4flash/)
      return 'allowed-once'
    },
  })
  const result = await chosen.complete([
    { role: 'system', content: '只返回 JSON' },
    { role: 'user', content: '你好' },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.model, 'dsv4flash')
  assert.equal(seen.provider, 'deepseek')
  assert.equal(seen.model, 'dsv4flash')
  assert.equal(seen.reasoningEffort, 'off')
  assert.equal(seen.system, '只返回 JSON')
  assert.equal(seen.messages[0].content[0].type, 'text')
  assert.equal(seen.messages[0].content[0].text, '你好')
  rmSync(root, { recursive: true, force: true })
})

test('DSH 失败带回路由和结束原因', async () => {
  const { completeWithDsh } = await import('./llm-mode.js')
  const result = await completeWithDsh({
    async *stream() {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: '缺少权限', code: 'FORBIDDEN', status: 403 } },
      }
    },
  }, { model: { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } }, [
    { role: 'user', content: '你好' },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UPSTREAM')
  assert.equal(result.provider, 'deepseek-account')
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(result.upstreamStatus, 403)
  assert.equal(result.finishReason.failure.code, 'FORBIDDEN')
  assert.equal(result.message.includes('没有完成'), false)
})

test('模型失败不写原料，日志和孤儿清单仍能看见', async () => {
  const root = tempWiki()
  const failed = await ingest({
    root,
    input: { text: '不会留下', title: '失败材料' },
    now: () => new Date('2026-11-25T00:00:00.000Z'),
    complete: async () => ({ ok: false, code: 'LLM_OFF' }),
    approve: async () => 'allowed-once',
  })
  assert.equal(failed.code, 'LLM_OFF')
  assert.equal(failed.approved, false)
  assert.equal(failed.outcome, 'not-asked')
  assert.equal(readdirSync(path.join(root, 'raw')).length, 0)
  assert.match(readFileSync(path.join(root, 'log.md'), 'utf8'), /失败 LLM_OFF/)
  writeFileSync(path.join(root, 'raw', 'abc.meta.json'), `${JSON.stringify({ hash: 'abc', title: '旧残留', file: 'abc.md' })}\n`)
  writeFileSync(path.join(root, 'raw', 'abc.md'), '旧残留')
  assert.equal(orphansOf(root)[0].title, '旧残留')
  const empty = await lint({ root })
  assert.equal(empty.code, 'EMPTY_WIKI')
  assert.equal(empty.findings[0].message, '无页面可检查')
  rmSync(root, { recursive: true, force: true })
})

test('技能注册传 source，失败时留下警告', async () => {
  if (!existsSync(path.resolve('node_modules/@deepseek-ai/dsh-tools/package.json'))) return
  const loaded = await import('./index.js')
  let registered
  loaded.apply({
    tools: { register() {} },
    get(name) { return name === 'skills' ? { register(skill) { registered = skill } } : null },
  })
  assert.equal(registered.name, 'llm-wiki')
  assert.equal(registered.source, 'runtime')
  assert.equal(typeof registered.content, 'string')
  assert.equal(registered.content.includes('NEED_LLM_CHOICE'), true)
  const warnings = []
  loaded.apply({
    tools: { register() {} },
    logger: { warn(message) { warnings.push(message) } },
    get(name) {
      return name === 'skills' ? { register() { throw new Error('source must be a string') } } : null
    },
  })
  assert.match(warnings[0], /技能注册失败/)
})

function tempWiki() {
  const root = mkdtempSync(path.join(tmpdir(), 'llm-wiki-'))
  mkdirSync(root, { recursive: true })
  return root
}

async function modelPatch(messages) {
  const hash = JSON.parse(messages.at(-1).content).hash
  return {
    ok: true,
    model: 'deepseek-flash',
    text: JSON.stringify({
      summary: '记下河流',
      pages: [{
        kind: 'source',
        slug: 'river',
        title: '河',
        summary: '向东',
        body: '河向东。',
        sources: [hash],
      }],
    }),
  }
}

test('取证覆盖多跳、冲突、噪声和无词面重合', async () => {
  const filler = (slug, text) => ({ kind: 'source', slug, title: slug, summary: slug, body: text, contradicts: [], partial: false })
  const pages = [
    filler('alpha', 'The archive key is kept at the place described in [[entity/vault]].'),
    { kind: 'entity', slug: 'vault', title: 'vault', summary: 'place', body: 'The place is recorded in [[concept/code]].', contradicts: [], partial: false },
    { kind: 'concept', slug: 'code', title: 'code', summary: 'sealed', body: 'The sealed number is 42.', contradicts: [], partial: false },
    filler('noise', `archive ${'unrelated rumor '.repeat(80)}`),
    filler('note', 'The archive key is 42.'),
    ...Array.from({ length: 8 }, (_item, index) => filler(`pad${index}`, 'weather markets shipping schedules')),
    { kind: 'source', slug: 'left', title: 'left', summary: 'old', body: 'The bridge opened in 1990.', contradicts: ['source/right'], partial: false },
    { kind: 'source', slug: 'right', title: 'right', summary: 'new', body: 'The bridge opened in 2004.', contradicts: ['source/left'], partial: false },
    { kind: 'entity', slug: 'paraphrase', title: 'paraphrase', summary: 'hidden', body: 'A sealed container sits under the north stair.', contradicts: [], partial: false },
  ]
  const hopped = await retrieve('where is the archive key kept', pages, { semantic: false })
  assert.equal(hitsAtK(hopped.hits, ['source/alpha', 'entity/vault', 'concept/code']), 1)
  assert.equal(hopped.hits[0].page === 'source/noise', false)
  const noteAt = hopped.hits.findIndex((hit) => hit.page === 'source/note')
  const noiseAt = hopped.hits.findIndex((hit) => hit.page === 'source/noise')
  assert.equal(noteAt >= 0 && (noiseAt < 0 || noteAt < noiseAt), true)
  const conflicted = await retrieve('when did the bridge open', pages)
  assert.equal(conflicted.conflicts.length > 0, true)
  assert.equal(hitsAtK(conflicted.hits, ['source/left', 'source/right']), 1)
  const hidden = await retrieve('where is the key', pages, {
    rerank: async () => ['entity/paraphrase#0'],
  })
  assert.equal(hitsAtK(hidden.hits, ['entity/paraphrase']), 1)
  assert.equal(hidden.hits[0].page, 'entity/paraphrase')
  const crowded = [
    ...Array.from({ length: 45 }, (_item, index) => filler(`crowd${index}`, 'The archive weather report is long.')),
    { kind: 'entity', slug: 'needle', title: 'needle', summary: 'hidden', body: 'A sealed container sits under the north stair.', contradicts: [], partial: false },
  ]
  const missed = await retrieve('where is the archive key', crowded)
  assert.equal(missed.coverage, 'partial')
  assert.equal(hitsAtK(missed.hits, ['entity/needle']), 0)
})

test('本地向量能在没有共同词时把目标留在前 10，失败则退回词面', async () => {
  const filler = (slug, text) => ({ kind: 'source', slug, title: slug, summary: slug, body: text, contradicts: [], partial: false })
  const crowded = [
    ...Array.from({ length: 45 }, (_item, index) => filler(`crowd${index}`, 'The archive weather report is long.')),
    { kind: 'entity', slug: 'needle', title: 'needle', summary: 'hidden', body: 'A sealed container sits under the north stair.', contradicts: [], partial: false },
  ]
  const direction = (text) => {
    const value = String(text)
    if (value.includes('north stair') || value.includes('where is the archive key')) return [1, 0]
    return [0, 1]
  }
  const found = await retrieve('where is the archive key', crowded, {
    embed: async (texts) => texts.map(direction),
  })
  assert.equal(found.embedding, 'on')
  assert.equal(found.coverage, 'embedded')
  assert.equal(hitsAtK(found.hits, ['entity/needle']), 1)
  const pads = Array.from({ length: 24 }, (_item, index) => filler(`pad${index}`, 'The archive weather report is long.'))
  const near = Array.from({ length: 23 }, (_item, index) => filler(`near${index}`, 'Shipping schedules and market notes.'))
  const split = [
    ...pads,
    ...near,
    { kind: 'entity', slug: 'needle', title: 'needle', summary: 'hidden', body: 'A sealed container sits under the north stair.', contradicts: [], partial: false },
  ]
  let sawNeedle = false
  const close = await retrieve('where is the archive key', split, {
    embed: async (texts) => texts.map((text) => {
      const value = String(text)
      if (value.includes('where is the archive key') || value.includes('market notes')) return [1, 0]
      if (value.includes('north stair')) return [0.5, 0.5]
      return [0, 1]
    }),
    rerank: async (_question, items) => {
      sawNeedle = items.slice(0, 40).some((item) => item.page === 'entity/needle')
      return ['entity/needle#0']
    },
  })
  assert.equal(sawNeedle, true)
  assert.equal(hitsAtK(close.hits, ['entity/needle']), 1)
  const failed = await retrieve('where is the archive key', crowded, {
    embed: async () => { throw new Error('权重没加载') },
  })
  assert.equal(failed.embedding, 'unavailable')
  assert.equal(failed.coverage, 'partial')
  assert.equal(hitsAtK(failed.hits, ['entity/needle']), 0)
})

test('向量按 query 和 passage 加前缀，算过的文本不再重算', async () => {
  assert.equal(EMBED_MODEL, 'Xenova/multilingual-e5-small')
  const root = tempWiki()
  const seen = []
  const load = async () => async (batch) => {
    seen.push(...batch)
    const data = new Float32Array(batch.length * 2)
    for (let index = 0; index < batch.length; index += 1) data[index * 2] = 1
    return { dims: [batch.length, 2], data }
  }
  const embed = createEmbedder({ cacheDir: root, load })
  const first = await embed(['河向东', '钥匙在哪'], { kinds: ['passage', 'query'] })
  assert.deepEqual(seen, ['passage: 河向东', 'query: 钥匙在哪'])
  assert.equal(first[0][0], 1)
  seen.length = 0
  await embed(['河向东'], { kinds: ['passage'] })
  assert.deepEqual(seen, [])
  const again = createEmbedder({
    cacheDir: root,
    load: async () => async () => { throw new Error('不应再加载') },
  })
  const cached = await again(['河向东'], { kinds: ['passage'] })
  assert.equal(cached[0][0], 1)
  rmSync(root, { recursive: true, force: true })
})

test('别名和主张进入目录与矛盾清单，并参与取证', async () => {
  const root = tempWiki()
  writePage(root, {
    kind: 'entity', slug: 'key', title: '钥匙', summary: '存放处', body: 'A sealed container sits under the north stair.',
    aliases: ['archive key'], claims: ['The archive key is under the north stair.'], contradicts: ['entity/other'],
    sources: [], cites: [], partial: false, updated: '',
  })
  writePage(root, {
    kind: 'entity', slug: 'other', title: '另一处', summary: '抽屉', body: 'The archive key is in the drawer.',
    aliases: [], claims: ['The archive key is in the drawer.'], contradicts: ['entity/key'],
    sources: [], cites: [], partial: false, updated: '',
  })
  rebuildIndex(root)
  const index = readFileSync(path.join(root, 'index.md'), 'utf8')
  const contradictions = readFileSync(path.join(root, 'contradictions.md'), 'utf8')
  assert.match(index, /别名：archive key/)
  assert.match(index, /主张：The archive key is under the north stair/)
  assert.match(contradictions, /entity\/key/)
  assert.match(contradictions, /entity\/other/)
  const found = await retrieve('where is the archive key', readPages(root).pages, { embed: false })
  assert.equal(hitsAtK(found.hits, ['entity/key', 'entity/other']), 1)
  const kept = validateIngest({
    summary: '补',
    pages: [{
      kind: 'entity', slug: 'key', title: '钥匙', summary: '存放处', body: '仍在北楼梯。', update: true,
      sources: ['a'.repeat(64)], aliases: [], claims: [],
    }],
  }, {
    hash: 'a'.repeat(64),
    existing: new Map([['entity/key', { sources: ['a'.repeat(64)], aliases: ['archive key'], claims: ['The archive key is under the north stair.'] }]]),
  })
  assert.equal(kept.code, 'INDEX_DROPPED')
  rmSync(root, { recursive: true, force: true })
})

test('按页取证会带回整页，证据句不必落在得分最高的片段里', async () => {
  const story = {
    kind: 'source',
    slug: 'story',
    title: 'Story',
    summary: 'story',
    locator: 'TechCrunch October 7, 2023',
    body: 'Markets were quiet and the weather was mild. The archive key is under the north stair.',
    contradicts: [],
    partial: false,
  }
  const pages = [
    story,
    ...Array.from({ length: 30 }, (_item, index) => ({
      kind: 'source',
      slug: `pad${index}`,
      title: `pad${index}`,
      summary: 'pad',
      body: 'Markets were quiet and the weather was mild across the trading floor today.',
      contradicts: [],
      partial: false,
    })),
  ]
  const found = await retrieve('TechCrunch October archive key', pages, { embed: false, unit: 'page', k: 5 })
  assert.equal(found.coverage, 'page')
  assert.equal(found.hits.some((hit) => hit.page === 'source/story' && hit.text.includes('north stair')), true)
})

test('页级向量不能压过只在一页里出现的词', async () => {
  const needle = {
    kind: 'source',
    slug: 'needle',
    title: 'needle',
    summary: 'needle',
    body: 'The studio kept a lookbook.',
    contradicts: [],
    partial: false,
  }
  const pages = [
    ...Array.from({ length: 8 }, (_item, index) => ({
      kind: 'source',
      slug: `pad${index}`,
      title: `pad${index}`,
      summary: 'pad',
      body: 'The archive weather report is long.',
      contradicts: [],
      partial: false,
    })),
    needle,
  ]
  const found = await retrieve('lookbooks', pages, {
    unit: 'page',
    k: 3,
    embed: async (texts) => texts.map((text) => (
      String(text) === 'lookbooks' || String(text).includes('weather') ? [1, 0] : [0, 1]
    )),
  })
  assert.equal(found.hits[0].page, 'source/needle')
})

test('连写的长词能对上拆开的英语名', async () => {
  const house = {
    kind: 'source',
    slug: 'house',
    title: 'house',
    summary: 'house',
    body: 'The Semper Opera House is open tonight.',
    contradicts: [],
    partial: false,
  }
  const pages = [
    ...Array.from({ length: 6 }, (_item, index) => ({
      kind: 'source',
      slug: `pad${index}`,
      title: `pad${index}`,
      summary: 'pad',
      body: 'The archive weather report is long.',
      contradicts: [],
      partial: false,
    })),
    house,
  ]
  const found = await retrieve('semperoper', pages, { embed: false, unit: 'page', k: 3 })
  assert.equal(found.hits[0].page, 'source/house')
})

test('姓氏保持原形，不会收成另一个名字', async () => {
  const pages = [
    {
      kind: 'source',
      slug: 'bard',
      title: 'bard',
      summary: 'bard',
      body: 'William Shakespeare wrote plays about kings.',
      contradicts: [],
      partial: false,
    },
    {
      kind: 'source',
      slug: 'robin',
      title: 'robin',
      summary: 'robin',
      body: 'Robin Williams was in the film.',
      contradicts: [],
      partial: false,
    },
  ]
  const found = await retrieve('Williams', pages, { embed: false, unit: 'page', k: 2 })
  assert.equal(found.hits[0].page, 'source/robin')
})

test('长词前缀后面也得接上正文里的词', async () => {
  const pages = [
    {
      kind: 'source',
      slug: 'city',
      title: 'city',
      summary: 'city',
      body: 'The old walls stand above the harbor.',
      contradicts: [],
      partial: false,
    },
    {
      kind: 'source',
      slug: 'lab',
      title: 'lab',
      summary: 'lab',
      body: 'The constant reading stayed flat through the night.',
      contradicts: [],
      partial: false,
    },
  ]
  const found = await retrieve('Constantinople', pages, { embed: false, unit: 'page', k: 2 })
  assert.equal(found.hits[0].page === 'source/lab', false)
})

test('页内证据句留下最稀有的词，也留下用户要搜的原话', async () => {
  const plant = await retrieve('which plant is erica vagans', [{
    kind: 'source',
    slug: 'flora',
    title: 'flora',
    summary: 'flora',
    body: `${'Some known plants grow by the road. '.repeat(40)}The species erica vagans is the Cornish heath.`,
    aliases: [],
    contradicts: [],
    partial: false,
  }], { embed: false, unit: 'page', k: 1 })
  assert.equal(plant.hits[0].text.slice(0, 400).includes('Cornish heath'), true)
  const quote = await retrieve('What does "to be or not to be, that is the question" mean here?', [{
    kind: 'source',
    slug: 'play',
    title: 'play',
    summary: 'play',
    body: `${'The opening night was cancelled after the fire. '.repeat(20)}The line is: to be or not to be, that is the question.`,
    aliases: [],
    contradicts: [],
    partial: false,
  }], { embed: false, unit: 'page', k: 1 })
  assert.equal(quote.hits[0].text.slice(0, 400).includes('that is the question'), true)
})

test('词面只剩虚词时，虚构证据句单独把对的页排上来', async () => {
  let calls = 0
  const pages = [
    ...Array.from({ length: 6 }, (_item, index) => ({
      kind: 'source',
      slug: `pad${index}`,
      title: `pad${index}`,
      summary: 'pad',
      body: 'A character walked near the old road.',
      contradicts: [],
      partial: false,
    })),
    {
      kind: 'source',
      slug: 'kiasma',
      title: 'kiasma',
      summary: 'kiasma',
      body: 'Yuki lives next to the Kiasma museum.',
      contradicts: [],
      partial: false,
    },
  ]
  const found = await retrieve('Which character has been to Helsinki?', pages, {
    embed: false,
    unit: 'page',
    k: 2,
    expand: async () => {
      calls += 1
      return 'Yuki lives next to the Kiasma museum.'
    },
  })
  assert.equal(calls, 1)
  assert.equal(found.hits[0].page, 'source/kiasma')
})

test('已经有稀有词命中时不扩写', async () => {
  let calls = 0
  const found = await retrieve('lookbooks', [
    {
      kind: 'source',
      slug: 'needle',
      title: 'needle',
      summary: 'needle',
      body: 'The studio kept a lookbook.',
      contradicts: [],
      partial: false,
    },
    {
      kind: 'source',
      slug: 'pad',
      title: 'pad',
      summary: 'pad',
      body: 'The archive weather report is long.',
      contradicts: [],
      partial: false,
    },
  ], {
    embed: false,
    unit: 'page',
    k: 2,
    expand: async () => {
      calls += 1
      return 'The archive weather report is long.'
    },
  })
  assert.equal(calls, 0)
  assert.equal(found.hits[0].page, 'source/needle')
})

test('长页后部的句子也会送去编码', async () => {
  const seen = []
  const tail = 'Yuki lives next to the Kiasma museum.'
  const found = await retrieve('Which character has been to Helsinki?', [{
    kind: 'source',
    slug: 'long',
    title: 'long',
    summary: 'long',
    body: `${'The weather was mild across the valley today. '.repeat(80)}${tail}`,
    contradicts: [],
    partial: false,
  }], {
    unit: 'page',
    k: 1,
    expand: async () => tail,
    embed: async (texts) => {
      seen.push(...texts.map((item) => String(item)))
      return texts.map(() => [1, 0])
    },
  })
  assert.equal(found.embedding, 'on')
  assert.equal(seen.some((text) => text.includes('valley') && text.includes('Kiasma')), true)
})

test('目录里的别名比正文里顺带提到的更靠前', async () => {
  const pages = [
    {
      kind: 'source',
      slug: 'mention',
      title: 'mention',
      summary: 'mention',
      body: 'Someone passed through Helsinki on the way to the coast.',
      aliases: [],
      claims: [],
      contradicts: [],
      partial: false,
    },
    {
      kind: 'source',
      slug: 'card',
      title: 'card',
      summary: 'museum',
      body: 'Yuki lives next to the building.',
      aliases: ['Helsinki'],
      claims: [],
      contradicts: [],
      partial: false,
    },
  ]
  const found = await retrieve('Helsinki', pages, { embed: false, unit: 'page', k: 2 })
  assert.equal(found.hits[0].page, 'source/card')
})

test('打开条目后顺着链接再看一页', async () => {
  const pages = [
    {
      kind: 'source',
      slug: 'hub',
      title: 'hub',
      summary: 'hub',
      body: 'The archive key is kept at [[entity/vault]].',
      contradicts: [],
      partial: false,
    },
    {
      kind: 'entity',
      slug: 'vault',
      title: 'vault',
      summary: 'vault',
      body: 'The sealed number is 42.',
      contradicts: [],
      partial: false,
    },
    ...Array.from({ length: 6 }, (_item, index) => ({
      kind: 'source',
      slug: `pad${index}`,
      title: `pad${index}`,
      summary: 'pad',
      body: 'The archive weather report is long.',
      contradicts: [],
      partial: false,
    })),
  ]
  const found = await retrieve('where is the archive key kept', pages, { embed: false, unit: 'page', k: 3 })
  assert.equal(found.hits[0].page, 'source/hub')
  assert.equal(found.hits.some((hit) => hit.page === 'entity/vault'), true)
})

test('重排看到证据句，不是页首', async () => {
  let saw = ''
  await retrieve('which plant is erica vagans', [{
    kind: 'source',
    slug: 'flora',
    title: 'flora',
    summary: 'flora',
    body: `${'The weather was mild across the valley. '.repeat(40)}The species erica vagans is the Cornish heath.`,
    contradicts: [],
    partial: false,
  }], {
    embed: false,
    unit: 'page',
    k: 1,
    rerank: async (_question, items) => {
      saw = items[0].text
      return [items[0].id]
    },
  })
  assert.equal(saw.includes('Cornish heath'), true)
})

test('英文复数和单数算同一个词', async () => {
  const book = {
    kind: 'source',
    slug: 'book',
    title: 'book',
    summary: 'book',
    body: 'The studio prepared a lookbook for the director.',
    contradicts: [],
    partial: false,
  }
  const pages = [
    ...Array.from({ length: 12 }, (_item, index) => ({
      kind: 'source',
      slug: `pad${index}`,
      title: `pad${index}`,
      summary: 'pad',
      body: 'The archive weather report is long.',
      contradicts: [],
      partial: false,
    })),
    book,
  ]
  const found = await retrieve('archive lookbooks', pages, { embed: false, unit: 'page', k: 3 })
  assert.equal(found.hits.some((hit) => hit.page === 'source/book'), true)
})

test('图像解析保留像素，不把看图结果写成已经识别的文字', () => {
  const registry = createRegistry()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const parsed = registry.parse({ path: 'chart.png', bytes: png, mediaType: 'image/png' })
  assert.equal(parsed.parser, 'image')
  assert.equal(parsed.text, '')
  const shown = presentSource(parsed)
  assert.equal(shown.partial, false)
  assert.equal(shown.images.length, 1)
  assert.match(shown.text, /图像/)
})

test('图像摄入把像素交给模型，不把未识别的图写成文字', async () => {
  const root = tempWiki()
  const file = path.join(root, 'chart.png')
  writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  let sawImage = false
  const result = await ingest({
    root,
    input: { path: file, mediaType: 'image/png' },
    complete: async (messages) => {
      const content = messages.at(-1).content
      sawImage = Array.isArray(content)
        && content.some((part) => part.type === 'image_url' && String(part.image_url?.url ?? '').startsWith('data:image/png;base64,'))
      return { ok: true, model: 'deepseek-flash', text: 'not-json' }
    },
    approve: async () => { throw new Error('不应审批') },
  })
  assert.equal(sawImage, true)
  assert.equal(result.code, 'BAD_PATCH')
  rmSync(root, { recursive: true, force: true })
})

test('本地检查能看见断链', () => {
  const findings = localFindings([{
    kind: 'entity',
    slug: 'li',
    partial: true,
    contradicts: ['concept/missing'],
    body: '见 [[concept/missing]]',
  }])
  assert.equal(findings.some((item) => item.code === 'PARTIAL'), true)
  assert.equal(findings.some((item) => item.code === 'BROKEN_LINK'), true)
  assert.equal(findings.some((item) => item.code === 'ORPHAN' && item.id === 'entity/li' && item.message === '无其他页引用'), true)
  const roots = localFindings([{ kind: 'source', slug: 'river', body: '河向东。' }])
  assert.equal(roots.some((item) => item.code === 'ORPHAN'), false)
})
