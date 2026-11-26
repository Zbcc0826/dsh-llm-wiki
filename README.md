# LLM Wiki

DeepSeek Harness plugin that keeps a persistent wiki between you and the raw sources, following the [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern. Raw files are copied once and never rewritten. Pages are updated only from a validated patch after approval. Full English guide: [README.en.md](README.en.md).

# LLM Wiki

把零散材料维护成一份会累积的知识维基，而不是每次提问都重新翻原文。依据是 [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。

这是一个本地插件，不需要发布到 npm。克隆后在你自己的机器上运行安装脚本即可。桌面应用和命令行共用一份配置。包名是 `dsh-llm-wiki`。

## 环境

- DeepSeek Harness `0.2.2-rc.3` 或更高，且低于 `0.3.0`
- 已能启动 `dsh` 或桌面应用
- 桌面应用自带安装插件用的 pnpm，不必再装一个
- 需要模型时，插件会先问：用 DSH 里已有的模型（如 dsv4flash）、另提供环境变量密钥，或不做插件里的模型任务

## 安装

打开 **插件**，点 **添加插件** 旁边的箭头，选择 **安装第三方插件**。本地克隆填这个仓库的绝对路径；从 GitHub 安装则填：

```text
github:Zbcc0826/dsh-llm-wiki
```

安装结束后选择 **立即启用**。卡片出现在 **实验性插件** 下面的 **已安装插件**，标题是 LLM Wiki，右侧是开关。关掉开关会卸下 `dsh-llm-wiki` 这一层，不再加载。

也可以在仓库目录运行：

```sh
node install.mjs
```

脚本装进 `DSH_HOME`（默认 `~/.dsh`）里已有的各个 profile，并打开开关。桌面端的 profile 不能用 `dsh plugin --profile desktop`，所以脚本直接改那个目录。装完后重启正在运行的桌面应用。用本地路径安装时，脚本还会把 `@deepseek-ai/dsh-tools` 放进 `.dsh-deps`，因为链接到仓库外的目录时，桌面应用不会改用自己包里的那一份。`.dsh-deps` 和 `node_modules` 不要提交。

卸掉时在这张卡片上关闭开关，再卸载。不要把绝对路径写进 `$DSH_HOME/cordis.patch.yml`，那种插法不会出现在插件页，开关也关不掉。

## 会得到什么

原料进 `raw/`，写入后不改。页面在 `pages/`。`index.md` 和 `log.md` 由插件生成。`schema.md` 第一次生成后不再覆盖。维基默认在 `$DSH_HOME/llm-wiki`，可以用 `LLM_WIKI_ROOT` 换目录。

提问时先看目录卡片：标题、别名、一句主张。别名对上了，就比正文里顺带出现的同一个词更靠前。然后打开少数几页，顺着 `[[链接]]` 再看一页，并留下矛盾的另一面。没有共同词时，用本地的 multilingual-e5-small 向量补一档；词面和目录都拉不开时，再换一组读者会去查的词条名。证据句用来重排，不从页首硬读。最多返回 10 条证据，然后只根据这些证据作答。

- `wiki_ingest`：解析一份材料并更新相关页面。路径和文本只能给一个。批准后才写。别名写成读者以后会拿来查找的词。
- `wiki_query`：先取证再回答。不读取原料。`file` 为 true 才把答案留下。
- `wiki_lint`：报告断链、孤立页和不完整材料。`apply` 为 true 才改已有页面，不新建，也不删除依据。
- `wiki_read` / `wiki_status` / `wiki_parsers`：只读。

没有审批界面时，写入返回 `NOT_APPROVED`，不挂起。

## 解析

`parsers.js` 的 `createRegistry` 接受额外解析器，放在内建之前。解析器实现 `accepts` 和 `parse`。图像解析器留下像素，不编造识别结果。`present.js` 的 `presentSource` 决定模型实际看见多少字，以及最多 4 张图。不认识的类型返回 `NO_PARSER`。

内建类型：图像、markdown、纯文本、JSON、CSV、HTML。第一次查询会下载向量权重，缓存在插件目录的 `.cache`。下载失败就退回词面、目录和链接。

还没选定做法时，摄入和提问返回 `NEED_LLM_CHOICE`，不会写 `llm.json`，也不会先把原料存下来。显式传入的 `llm` 会覆盖已记住的做法并立刻生效。`wiki_llm` 更改仍会再确认一次。选 DSH 时用当前会话里的模型，例如 dsv4flash，消息按文本块发送。选密钥时才请求 `deepseek-v4-flash`；字面量 `dsv4.1flash` 会被接口拒绝，响应里的模型名通常是 `deepseek-flash`。选不做时，查阅和检查仍然可用，摄入在写盘前就返回 `LLM_OFF`。失败记在 `log.md`。`wiki_status` 的 `orphans` 列出没有页面引用的原料。写入结果带 `approved` 和 `outcome`。

## 密钥

不要把 API 密钥写进仓库。只有用户选择密钥时，插件才读 `DEEPSEEK_API_KEY`，或 `DEEPSEEK_KEY_FILE` 指向的文件。选择记在维基目录的 `llm.json`，里面没有密钥。要用 `wiki_llm` 改选择。
