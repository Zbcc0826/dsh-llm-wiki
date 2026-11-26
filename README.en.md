# LLM Wiki

A DeepSeek Harness plugin that keeps a persistent wiki between you and the raw sources, following the [llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern. Raw files are copied once and never rewritten. Pages, the index, and the log are updated only from a validated patch after approval.

This is a local plugin and is not published to npm. Clone the repo and run the install script on your machine. The desktop app and the CLI share one configuration. The package name is `dsh-llm-wiki`.

## Requirements

- DeepSeek Harness `0.2.2-rc.3` or newer, and below `0.3.0`
- A working `dsh` CLI or desktop app
- The desktop app already includes the pnpm used to install plugins
- On a model call, the plugin asks whether to use a model already available in DSH (such as dsv4flash), to provide an environment-variable key, or to skip the plugin’s model tasks

## Install

Open **Plugins**, click the arrow next to **Add plugin**, and choose **Install a third-party plugin**. For a local clone, enter this repo's absolute path. From GitHub, enter:

```text
github:Zbcc0826/dsh-llm-wiki
```

Choose **Enable now** when installation finishes. The card appears under **Installed** in **Experimental**, titled LLM Wiki, with a switch on the right. Turning the switch off unloads the `dsh-llm-wiki` bundle.

You can also run this in the repo:

```sh
node install.mjs
```

The script installs into every existing profile under `DSH_HOME` (default `~/.dsh`) and turns the switch on. The desktop profile cannot be managed with `dsh plugin --profile desktop`, so the script edits that directory directly. Restart a running desktop app afterward. A local-path install also vendors `@deepseek-ai/dsh-tools` into `.dsh-deps`, because a directory outside the repo will not fall back to the copy inside the app. Do not commit `.dsh-deps` or `node_modules`.

To remove it, turn the card off, then uninstall. Do not write an absolute path into `$DSH_HOME/cordis.patch.yml`. That insert does not show up on the plugin page and the switch cannot turn it off.

## What you get

Sources land in `raw/` and stay unchanged. Pages live in `pages/`. The plugin writes `index.md` and `log.md`. `schema.md` is written once and then left alone. The wiki lives at `$DSH_HOME/llm-wiki` unless `LLM_WIKI_ROOT` is set.

A question starts at the catalog cards: title, aliases, and one claim. An alias match outranks a passing mention in a body. The plugin then opens a few pages, follows one `[[link]]`, and keeps the other side of a contradiction. When the question and the page share no words, local multilingual-e5-small vectors fill the gap. When neither the catalog nor the words pull ahead, it tries headings a reader would look up. Reranking sees the evidence sentence, not the start of the page. At most ten pieces of evidence are returned, and the answer has to come from those pieces.

- `wiki_ingest` parses one source and updates the pages that should mention it. Pass either a path or text, not both. Nothing is written before approval. Aliases are the words a later reader would search. Text longer than one page is split on headings and tables. Every part keeps the same raw hash and the same index heading, and a table stays with its header. At most 8 parts are filed; the index page marks anything left unread.
- `wiki_query` retrieves evidence, then answers. It does not read raw files. The answer is filed only when `file` is true. Retrieval also follows `relations`.
- `wiki_graph` walks entity, event, and relation edges without a model. `hops` is 0 to 4. `predicate` keeps one relation type.
- `wiki_lint` reports broken links, orphan pages, missing relations, and incomplete sources. `apply` edits existing pages only. It cannot create a page or drop a source.
- `wiki_read`, `wiki_status`, and `wiki_parsers` are read-only.

If there is no approval UI, a write returns `NOT_APPROVED` and does not hang.

## Parsers

`createRegistry` accepts extra parsers ahead of the built-in image, markdown, text, JSON, CSV, and HTML parsers. Image parsers keep pixels and do not invent OCR text. `presentSource` is what the model is allowed to see, including up to four images. Unknown types return `NO_PARSER`.

PDF, Word, Excel, PowerPoint, audio, and video are not parsed here. Those paths return `NEED_EXTERNAL_PARSER`. Another plugin can inject the `llm-wiki.parsers` service and call `register` or `accept`, or pass the finished document as the `parsed` argument to `wiki_ingest`. Parts use `text`, `table`, `caption`, `transcript`, or `image`, with a `locator` for a page, slide, or timestamp. Original bytes go in `source.base64`. A locator stays with the table that follows it.

Events are `event` pages. Each `relations` entry is `predicate kind/slug`, for example `works-for entity/acme`. An update must keep relations that were already there. `wiki_graph` walks those edges in both directions.

The first query downloads the embedding weights into the plugin `.cache` directory. If that download fails, retrieval continues with words, the catalog, and links.

Before a mode is chosen, ingest and query return `NEED_LLM_CHOICE` and write neither `llm.json` nor raw material. An explicit `llm` argument overrides the saved mode and takes effect immediately. `wiki_llm` still asks before changing it. DSH mode uses the model already selected in the session, such as dsv4flash, and sends text blocks. Key mode requests `deepseek-v4-flash`; the literal id `dsv4.1flash` is rejected, and the response usually reports `deepseek-flash`. Skipping model tasks leaves reading and checks available; ingest returns `LLM_OFF` before anything is stored. Failures are appended to `log.md`. `wiki_status.orphans` lists raw files that no page cites. Write results include `approved` and `outcome`.

## Keys

Do not commit API keys. The plugin reads `DEEPSEEK_API_KEY`, or the file named by `DEEPSEEK_KEY_FILE`, only after the user chooses key mode. The choice is stored in `llm.json` inside the wiki directory and contains no key. Change it with `wiki_llm`.
