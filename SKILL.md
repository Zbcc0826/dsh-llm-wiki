---
name: llm-wiki
description: 把材料维护成持续更新的知识维基。摄入、提问和体检都用插件工具，不要自己改 raw、index.md 或 log.md。写入前会请用户批准。
---

# LLM Wiki

原料放进 `wiki_ingest`，不要把整份材料贴进对话，也不要自己写 `pages/`。路径和文本只能给一个。插件先解析，再请模型更新页面。用户不同意就不写。

`wiki_query` 先取证再回答：词面、本地向量、两跳链接和矛盾的另一面都进证据，然后只根据这些证据作答。只有用户要求把答案留下时，`file` 才传 true。冲突的两边都要保留。向量模型是开源的 multilingual-e5-small，不调用 DeepSeek 的向量接口。

`wiki_lint` 先看报告。要改页面时才把 `apply` 设为 true。它不能新建页面，也不能删掉已有依据。

`wiki_read` 按 `种类/slug` 读一页。`wiki_status` 看页数和最近日志。`wiki_parsers` 看现在能解析什么。返回 `NO_PARSER` 时说明这个类型还没有解析器，不要假装已经读过。

要用模型时插件会问用户三选一：使用 DSH 里已有的模型（如 dsv4flash）、另提供环境变量 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_KEY_FILE`、或不做插件里的模型任务。不要替用户选。用户已经说了之后，下一次调用再把 `llm` 设为 `dsh`、`key` 或 `off`。返回 `NEED_LLM_CHOICE` 时先把这三项原样告诉用户。返回 `LLM_OFF` 时不要改用别的方式偷偷调用模型。没有审批界面时写入返回 `NOT_APPROVED`，不要重试着写。
