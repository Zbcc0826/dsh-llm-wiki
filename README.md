# LLM Wiki

[![test](https://github.com/Zbcc0826/dsh-llm-wiki/actions/workflows/test.yml/badge.svg)](https://github.com/Zbcc0826/dsh-llm-wiki/actions/workflows/test.yml)

English guide: [README.en.md](README.en.md)

这是一个基于 [Andrej Karpathy 在 GitHub 上发布的 LLM Wiki 说明](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 实现的 DeepSeek Harness 插件。它把零散材料维护成一份会累积的知识维基，而不是每次提问都重新翻原文。

原料写入 `raw/` 后不再修改。页面、`index.md` 和 `log.md` 只在用户批准后按校验过的补丁更新。没有审批界面时，写入返回 `NOT_APPROVED`，不挂起。

这是一个本地插件，不发布到 npm，包名为 `dsh-llm-wiki`。克隆仓库后在本地运行安装即可，桌面应用和命令行共用同一份配置。

欢迎试用，也欢迎让你自己的 agent 参与这个项目：用它摄入材料、提问、改进页面，或把使用中的问题带回 [Zbcc0826/dsh-llm-wiki](https://github.com/Zbcc0826/dsh-llm-wiki)。

## 目录长什么样

维基默认存放在 `$DSH_HOME/llm-wiki`，也可以通过环境变量 `LLM_WIKI_ROOT` 指定其他目录：

```text
llm-wiki/
├── raw/
│   ├── <64位十六进制哈希><原扩展名>    # 原料字节，写入后不再改；扩展名不合法时用 .bin
│   └── <同一哈希>.meta.json
├── pages/
│   ├── source/<slug>.md
│   ├── entity/<slug>.md
│   ├── event/<slug>.md
│   ├── concept/<slug>.md
│   └── query/<slug>.md
├── index.md
├── contradictions.md
├── log.md
└── schema.md                          # 第一次生成后不再覆盖
```

## 一页长什么样

下面是一份典型的 `entity` 页（例如 `pages/entity/chen-lin.md`），遵循 `pages.js` 中 `serializePage` 的格式，YAML frontmatter 中的字符串和列表项均按 JSON 字符串序列化：

```markdown
---
kind: "entity"
slug: "chen-lin"
title: "陈林"
summary: "Acme 公司的系统工程师，负责存储引擎。"
partial: false
updated: "2026-04-12T08:30:00.000Z"
sources:
  - "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
cites:
  - "source/acme-team-notes"
contradicts: []
relations:
  - "works-for entity/acme"
aliases:
  - "陈工"
claims:
  - "陈林在 Acme 负责存储引擎。"
---

陈林自 2024 年起在 [[entity/acme]] 担任系统工程师，负责存储引擎维护。
```

## 环境要求

- DeepSeek Harness `0.2.2-rc.3` 或更高，且低于 `0.3.0`
- 已能启动 `dsh` 命令行或桌面应用
- 桌面应用已自带安装插件所需的 pnpm，不必另外安装
- 需要调用模型时，插件会先请用户选择：用 DSH 会话里已有的模型（如 `dsv4flash`）、通过环境变量提供 API 密钥，或关闭插件内的模型任务

## 安装与卸载

支持以下三种安装方式：

### 1. 插件页安装

打开 **插件**，点 **添加插件** 旁边的箭头，选择 **安装第三方插件**。本地克隆填这个仓库的绝对路径；从 GitHub 安装则填：

```text
github:Zbcc0826/dsh-llm-wiki
```

安装完成后选择 **立即启用**。插件卡片出现在 **实验性插件** 下的 **已安装插件** 中，标题为 LLM Wiki，右侧带有开关。关掉开关会卸下 `dsh-llm-wiki` 这一层，不再加载。

### 2. 命令行安装

```sh
dsh plugin --profile <profile> add github:Zbcc0826/dsh-llm-wiki
```

这里的 `<profile>` 是命令行 profile 的名称，不是 `desktop`。桌面 profile 不能使用 `dsh plugin --profile desktop`，请改用插件页或下面的 `node install.mjs` 安装，装完后重启桌面应用。

### 3. 在仓库目录运行安装脚本

```sh
node install.mjs
```

脚本会把插件装进 `DSH_HOME`（默认 `~/.dsh`）里已有的各个 profile，并打开开关。由于桌面端 profile 不能用 `dsh plugin --profile desktop`，脚本会直接修改对应目录；安装完成后请重启正在运行的桌面应用。

使用本地路径安装时，脚本还会把 `@deepseek-ai/dsh-tools` 放进 `.dsh-deps`，因为链接到仓库外的目录时，桌面应用不会改用自己包里的那一份。请勿提交 `.dsh-deps` 和 `node_modules`。

### 卸载与注意事项

卸载时先在插件卡片上关闭开关，再卸载。不要把仓库绝对路径写进 `$DSH_HOME/cordis.patch.yml`，那种加载方式不会出现在插件页中，也无法通过开关关闭。

## 8 个工具

插件注册且仅注册以下 8 个工具：`wiki_status`、`wiki_parsers`、`wiki_read`、`wiki_ingest`、`wiki_query`、`wiki_graph`、`wiki_lint`、`wiki_llm`。

- **`wiki_ingest`**：解析一份材料并更新相关页面，写入前必须经过用户批准（无审批界面时返回 `NOT_APPROVED`，不挂起）。参数只有 `path`、`text`、`title`、`mediaType`、`parsed` 和 `llm`，其中 `path`、`text`、`parsed` 三选一；没有 `offset`、`cursor`、`fromSegment` 或续读参数。别名会写成读者日后用来查找的词。长材料按章节和表格切分，各段共用同一份原料和同一条索引头；表格不会和表头拆开，位置说明也会和紧随的表格留在同一段。一次最多展开 8 段，未读部分只标记在来源目录页上。
- **`wiki_query`**：先取证再回答，严格依据证据作答，不读取 `raw/` 中的原料。只有传入 `file: true` 时，才把答案保存为页面。
- **`wiki_graph`**：从实体、事件、标题或别名出发沿关系查询，不调用模型。`hops` 支持 `0` 到 `4`（默认 `2`），`predicate` 可限定只走一种谓语。关系写在页面 `relations` 中（每条为「谓语 目标页」，例如 `works-for entity/acme`），来源哈希也写在页面上，并非每条边单独保存一份溯源。查询可双向行走，能从目标页走回声明该关系的页面；更新页面时必须保留原有关系。事件写成 `event` 页。
- **`wiki_lint`**：检查并报告断链、孤立页、断掉的关系和不完整材料（`PARTIAL`）。来源页作为材料入口，没有其他页指向它不算孤立。只有传入 `apply: true` 时才会修改已有页面，且不能新建页面、不能删除依据，也不会补读尾巴。
- **`wiki_read`**：只读，按 `种类/slug` 读取指定页面。
- **`wiki_status`**：只读，查看页面统计、最近日志，以及没有被任何页面引用的原料（`orphans`）。
- **`wiki_parsers`**：只读，查看当前可用的解析器。
- **`wiki_llm`**：更改并保存模型模式，修改前会再次请用户确认。

### 超过 8 段怎么处理尾巴

`wiki_ingest` 只有 `path`、`text`、`title`、`mediaType`、`parsed`、`llm` 这 6 个参数，没有 `offset`、`cursor`、`fromSegment` 或「从第 9 段继续」的参数。在 `split.js` 中，`MAX_SEGMENTS = 8`，每段大约 7500 字，超出的字符数记在返回的 `omitted` 字段中：

- 来源目录页（source 索引页）的 `summary` 会写「后面还有未纳入的文字」，正文会写「后面约 N 字这一次没有纳入。」，并设置 `partial: true`。
- `wiki_lint` 会对 `partial: true` 的页面报告 `code: PARTIAL`；即使传入 `apply: true`，也只会修改已有页面，不会补读未纳入的尾巴。
- 用同一份全文再次调用 `wiki_ingest`，仍会从头只展开前 8 段，不会接着往后读。
- 要把剩余尾巴纳入维基，必须把未读部分单独做成一份新材料（传入新的 `path` 或 `text`）再调用 `wiki_ingest`。新材料会生成自己的原料哈希，产出页面可以引用或更新维基里已有的页面。

## 检索是怎么找证据的

1. 先查看目录卡片：标题、别名和一句主张。别名命中会排在正文顺带提到的词之前。
2. 再打开少数匹配页面，顺着 `[[链接]]`（一跳）和 `relations` 扩展，同时保留矛盾的另一面。
3. 当词面和目录都拉不开候选时，使用本地的 `multilingual-e5-small` 向量补一档（不调用 DeepSeek 的向量接口）。首次查询会把向量权重下载到插件目录的 `.cache`；若下载失败，则退回词面、目录和链接检索。
4. 若词面和目录仍未拉开，会再尝试读者常查的词条标题。
5. 检索使用证据句重排，而不是从页首硬读。最多返回 10 条证据，`wiki_query` 只根据这些证据作答。

## 解析

- **内建类型**：图像（只留像素，不编造 OCR 识别文字）、Markdown、纯文本、JSON、CSV、HTML。
- **需要外部解析器的类型**：PDF、Word、Excel、PPT、音频和视频不在此处直接解析，遇到时返回 `NEED_EXTERNAL_PARSER`。
- **未知类型**：返回 `NO_PARSER`。
- **接入外部解析器**：其他插件可通过服务 `llm-wiki.parsers` 接入（`register` 注册解析器，`accept` 预览一份成果）；也可以直接把解析成果放进 `wiki_ingest` 的 `parsed` 参数（与 `path`、`text` 三选一）。
- **解析成果格式**：用 `parts` 携带 `text`、`table`、`caption`、`transcript` 或 `image`，并用 `locator` 标注页码、幻灯片或时间点；原始文件字节放在 `source.base64`。表格不和表头拆开，位置说明也会和紧随的表格留在同一段。
- **扩展与呈现**：`parsers.js` 的 `createRegistry` 接受额外解析器并排在内建之前，解析器需实现 `accepts` 和 `parse`。`present.js` 的 `presentSource` 控制模型实际看到的字数和图像数量（最多 4 张图）。

## 模型选择与密钥

在用户选定模型做法前，`wiki_ingest` 和 `wiki_query` 会返回 `NEED_LLM_CHOICE`，既不会写入 `llm.json`，也不会先把原料存下来。三种做法为：

- `dsh`：使用当前 DSH 会话里已有的模型（例如 `dsv4flash`），消息按文本块发送。
- `key`：读取环境变量 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_KEY_FILE` 指向的文件。密钥模式向接口请求 `deepseek-v4-flash`（字面量 `dsv4.1flash` 会被接口拒绝，响应里的模型名通常是 `deepseek-flash`）。
- `off`：不做插件内的模型任务。此时查阅与 `wiki_lint` 检查仍可用，但 `wiki_ingest` 会在写盘前返回 `LLM_OFF`。

显式传入 `llm` 参数会覆盖已记住的做法并立刻生效；用 `wiki_llm` 改选则会再次确认。选定的做法记在维基目录的 `llm.json` 中，里面不包含密钥。请勿把 API 密钥写进仓库。

模型调用失败会记录到 `log.md`。写入结果包含 `approved` 和 `outcome`。
