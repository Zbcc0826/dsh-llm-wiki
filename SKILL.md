---
name: llm-wiki
description: 把材料维护成持续更新的知识维基。摄入、提问和体检都用插件工具，不要自己改 raw、index.md 或 log.md。写入前会请用户批准。
---

# LLM Wiki

原料放进 `wiki_ingest`，不要把整份材料贴进对话，也不要自己写 `pages/`。路径和文本只能给一个。插件先解析，再请模型更新页面。用户不同意就不写。很长的材料会按章节和表格分成多段，各段共用同一份原料和同一条索引头；一次最多 8 段，没纳入的部分标在目录页上，不要自己再切一遍。

`wiki_query` 先取证再回答：词面、本地向量、两跳链接和矛盾的另一面都进证据，然后只根据这些证据作答。只有用户要求把答案留下时，`file` 才传 true。冲突的两边都要保留。向量模型是开源的 multilingual-e5-small，不调用 DeepSeek 的向量接口。

`wiki_lint` 先看报告。来源页是材料入口，没有别的页指向它不算孤立。要改页面时才把 `apply` 设为 true。它不能新建页面，也不能删掉已有依据。

`wiki_read` 按 `种类/slug` 读一页。`wiki_status` 看页数和最近日志。`wiki_parsers` 看现在能解析什么。返回 `NO_PARSER` 时说明这个类型还没有解析器，不要假装已经读过。返回 `NEED_EXTERNAL_PARSER` 时，这是 PDF、Office 或音视频，本插件不解析字节。让对应的解析插件把成果放进 `wiki_ingest` 的 `parsed`，或注册到服务 `llm-wiki.parsers`。成果要带 `locator`，表格用 `role: table`。

`wiki_graph` 不调用模型。从实体、事件、标题或别名出发，沿 `relations` 走，默认两跳。事件写成 `event` 页。关系写成「谓语 目标页」，例如 `works-for entity/acme`。更新一页时，原来的 relations 必须保留。

还没选定模型做法时，摄入和提问返回 `NEED_LLM_CHOICE`，不要自己猜，也不要代填 `llm`。把这三项原样告诉用户：`dsh` 用 DSH 里已有的模型（如 dsv4flash），`key` 用环境变量 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_KEY_FILE`，`off` 不做插件里的模型任务。用户说了之后，下一次调用把 `llm` 设成对应的值；这个参数会覆盖已经记住的做法并立刻按它执行。用 `wiki_llm` 改选择时仍会再请用户批准。返回 `LLM_OFF` 时不要改用别的方式偷偷调用模型。没有审批界面时写入返回 `NOT_APPROVED`，不要重试着写。`wiki_status` 的 `orphans` 是没有任何页面引用的原料。
