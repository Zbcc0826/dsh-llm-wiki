---
name: llm-wiki
description: 基于 Andrej Karpathy 的 LLM Wiki 说明实现的知识维基插件工作流。摄入、提问、图谱查询和体检都通过 8 个插件工具完成，不要自己改 raw/、pages/、index.md 或 log.md；写入需用户批准，无审批界面时返回 NOT_APPROVED。欢迎试用，也欢迎让 agent 参与这个项目。
---

# LLM Wiki

本插件基于 Andrej Karpathy 的 LLM Wiki 说明实现：https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f 。欢迎试用，也欢迎让用户的 agent 参与 [dsh-llm-wiki](https://github.com/Zbcc0826/dsh-llm-wiki)。

## 核心原则

- 所有写入都必须通过插件工具并由用户批准后按校验过的补丁执行，不要自己直接写 `raw/`、`pages/`、`index.md` 或 `log.md`。
- 没有审批界面时，写入返回 `NOT_APPROVED`，不要挂起，也不要重试着硬写。
- 原料写入 `raw/` 后不再修改。

## 8 个工具与使用规范

插件仅注册以下 8 个工具：`wiki_status`、`wiki_parsers`、`wiki_read`、`wiki_ingest`、`wiki_query`、`wiki_graph`、`wiki_lint`、`wiki_llm`。

- **`wiki_ingest`（摄入材料）**
  - 不要把整份材料贴进对话。参数只有 `path`、`text`、`title`、`mediaType`、`parsed`、`llm`，其中 `path`、`text`、`parsed` 只能三选一。
  - 没有 `offset`、`cursor`、`fromSegment` 或续读参数，也不要自己提前切分。
  - 长材料会按章节和表格切分，各段共用同一份原料和同一条索引头；表格不与表头拆开，位置说明（`locator`）会和紧随的表格留在同一段。
  - 每次最多处理 8 段（每段约 7500 字），超出字符数记在 `omitted`；来源目录页会设 `partial: true`，`summary` 写「后面还有未纳入的文字」，正文写「后面约 N 字这一次没有纳入。」。
  - 同一份全文再次调用仍只展开前 8 段；未纳入的尾巴必须单独拆成一份新材料再调用 `wiki_ingest`。

- **`wiki_query`（检索与提问）**
  - 先取证再回答，不读取 `raw/` 中的原料，只根据取回的证据（最多 10 条）作答。
  - 证据来源：目录卡片（标题、别名优先于正文顺带提及、一句主张）、两跳链接（`[[链接]]` 与 `relations`）、冲突双方以及本地 `multilingual-e5-small` 向量（不调用 DeepSeek 向量接口；权重下载失败时退回词面、目录与链接）。证据句经重排，不从页首硬读。
  - 矛盾的两边都要保留。
  - 只有用户明确要求把答案留下时，`file` 才传 `true`。

- **`wiki_graph`（关系图谱查询）**
  - 不调用模型。从实体、事件、标题或别名出发，沿 `relations` 走（`hops` 为 `0` 到 `4`，默认 `2`；可用 `predicate` 限定一种谓语），支持双向查询（也能从目标页走回来）。
  - 事件写成 `event` 页。关系写在页面的 `relations` 中（格式「谓语 目标页」，如 `works-for entity/acme`），来源哈希也写在页面上。更新页面时必须保留原有 `relations`。

- **`wiki_lint`（体检与修复）**
  - 先查看报告。来源页作为材料入口，没有其他页指向它不算孤立。
  - 对 `partial: true` 的页面会报告 `PARTIAL`。
  - 只有需要修改已有页面时才设 `apply: true`；它不能新建页面、不能删掉已有依据，也不会补读尾巴。

- **只读工具**
  - `wiki_read`：按 `种类/slug` 读取一页。
  - `wiki_status`：查看页数、最近日志以及未被任何页面引用的原料（`orphans`）。
  - `wiki_parsers`：查看当前能解析哪些类型。

- **解析器错误处理**
  - 内建支持图像（只留像素，不编造 OCR）、Markdown、纯文本、JSON、CSV、HTML。
  - 返回 `NO_PARSER` 时说明该类型没有解析器，不要假装已经读过。
  - PDF、Office（Word/Excel/PPT）或音视频返回 `NEED_EXTERNAL_PARSER`，本插件不解析字节；请由外部解析插件把成果放进 `wiki_ingest` 的 `parsed`，或注册到服务 `llm-wiki.parsers`。成果需带 `locator`，表格的 `role` 用 `table`。

- **模型选择与 `wiki_llm`**
  - 还没选定模型做法时，摄入和提问返回 `NEED_LLM_CHOICE`（不写 `llm.json`，也不先存原料）。不要自己猜测，也不要代填 `llm`。
  - 把这三项原样告诉用户：`dsh` 用 DSH 里已有的模型（如 `dsv4flash`）、`key` 用环境变量 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_KEY_FILE`（请求 `deepseek-v4-flash`；字面量 `dsv4.1flash` 会被拒绝）、`off` 不做插件里的模型任务。
  - 用户选定后，下一次调用把 `llm` 设成对应的值；显式 `llm` 会覆盖已记住的做法并立刻生效。选择保存在 `llm.json`（不含密钥）。
  - 用 `wiki_llm` 更改已记住的选择时仍会再请用户批准。
  - 返回 `LLM_OFF` 时不要改用别的方式偷偷调用模型。
