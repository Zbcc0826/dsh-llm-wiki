# LLM Wiki

[![test](https://github.com/Zbcc0826/dsh-llm-wiki/actions/workflows/test.yml/badge.svg)](https://github.com/Zbcc0826/dsh-llm-wiki/actions/workflows/test.yml)

中文说明：[README.md](README.md)

A DeepSeek Harness plugin built from [Andrej Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). It turns scattered materials into a cumulative knowledge wiki instead of re-reading raw files on every question.

Raw files are written to `raw/` once and never modified. Pages, `index.md`, and `log.md` are updated only from validated patches after user approval. When no approval UI is present, writes return `NOT_APPROVED` and do not hang.

This is a local plugin and is not published to npm. The package name is `dsh-llm-wiki`. Clone the repo and install locally; the desktop app and the CLI share one configuration.

Try it, and let your own agent take part: ingest sources, ask questions, improve pages, or bring issues and findings back to [Zbcc0826/dsh-llm-wiki](https://github.com/Zbcc0826/dsh-llm-wiki).

## What the wiki directory looks like

By default the wiki lives at `$DSH_HOME/llm-wiki`, or at the path set in `LLM_WIKI_ROOT`:

```text
llm-wiki/
├── raw/
│   ├── <64-char-hex-hash><original-ext>  # raw bytes, never rewritten; .bin if the extension is not safe
│   └── <same-hash>.meta.json
├── pages/
│   ├── source/<slug>.md
│   ├── entity/<slug>.md
│   ├── event/<slug>.md
│   ├── concept/<slug>.md
│   └── query/<slug>.md
├── index.md
├── contradictions.md
├── log.md
└── schema.md                          # generated once, never overwritten
```

## What one page looks like

Below is a sample `entity` page (for example `pages/entity/chen-lin.md`) in the exact `serializePage` format from `pages.js`, where YAML frontmatter strings and list entries are serialized as JSON strings:

```markdown
---
kind: "entity"
slug: "chen-lin"
title: "Lin Chen"
summary: "Systems engineer at Acme working on the storage engine."
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
  - "L. Chen"
claims:
  - "Lin Chen maintains the storage engine at Acme."
---

Lin Chen has worked as a systems engineer at [[entity/acme]] since 2024, maintaining the storage engine.
```

## Requirements

- DeepSeek Harness `0.2.2-rc.3` or newer, and below `0.3.0`
- A working `dsh` CLI or desktop app
- The desktop app already includes the pnpm used to install plugins, so no extra pnpm install is needed
- When a task needs a model, the plugin asks whether to use a model already available in the DSH session (such as `dsv4flash`), an API key from environment variables, or to turn off model tasks in the plugin

## Install and uninstall

You can install the plugin in any of these three ways:

### 1. Plugins page

Open **Plugins**, click the arrow next to **Add plugin**, and choose **Install a third-party plugin**. Enter this repo's absolute path for a local clone, or enter:

```text
github:Zbcc0826/dsh-llm-wiki
```

Choose **Enable now** when installation finishes. The card appears under **Experimental** → **Installed**, titled LLM Wiki, with a switch on the right. Turning the switch off unloads `dsh-llm-wiki`.

### 2. CLI

```sh
dsh plugin --profile <profile> add github:Zbcc0826/dsh-llm-wiki
```

Here `<profile>` is a CLI profile name, not `desktop`. The desktop profile cannot use `dsh plugin --profile desktop`; install through the Plugins page or `node install.mjs` below, then restart the desktop app.

### 3. Install script in the repo

```sh
node install.mjs
```

The script installs into every existing profile under `DSH_HOME` (default `~/.dsh`) and turns the switch on. Because `dsh plugin --profile desktop` cannot manage the desktop profile, the script edits that directory directly; restart a running desktop app afterward.

For a local-path install, the script also vendors `@deepseek-ai/dsh-tools` into `.dsh-deps`, because linking to a directory outside the repo will not fall back to the copy inside the app. Do not commit `.dsh-deps` or `node_modules`.

### Uninstall and notes

To remove the plugin, turn the card switch off and uninstall. Never write an absolute path into `$DSH_HOME/cordis.patch.yml`. A plugin loaded that way does not show up on the Plugins page, and the switch cannot turn it off.

## The 8 tools

The plugin registers only these 8 tools: `wiki_status`, `wiki_parsers`, `wiki_read`, `wiki_ingest`, `wiki_query`, `wiki_graph`, `wiki_lint`, and `wiki_llm`.

- **`wiki_ingest`**: Parses one source and updates related pages only after user approval (returns `NOT_APPROVED` without hanging if no approval UI is present). Its only parameters are `path`, `text`, `title`, `mediaType`, `parsed`, and `llm` (pass one of `path`, `text`, or `parsed`). There is no `offset`, `cursor`, `fromSegment`, or resume parameter. Aliases should be terms future readers will search. Long sources are split by headings and tables into segments sharing one raw hash and one index heading; tables stay with their headers, and a locator stays in the same segment as the table that follows it. At most 8 segments are processed per call, and unread text is marked on the source index page.
- **`wiki_query`**: Retrieves evidence first and answers strictly from that evidence without reading raw files in `raw/`. The answer is saved as a page only when `file` is `true`.
- **`wiki_graph`**: Queries along `relations` from an entity, event, title, or alias without calling a model. `hops` ranges from `0` to `4` (default `2`), and `predicate` filters to one relation type. Relations (`predicate kind/slug`, such as `works-for entity/acme`) and source hashes (`sources`) are stored directly on pages—not as separate provenance per edge. Traversal works in both directions, including back from a target page to pages that declare the edge. Existing `relations` must be preserved when a page is updated. Events are written as `event` pages.
- **`wiki_lint`**: Reports broken links, orphan pages (source pages with no incoming links are not orphans), missing relations, and incomplete sources (`PARTIAL`). Setting `apply: true` only edits existing pages; it cannot create pages, drop sources, or pull in unread tails.
- **`wiki_read`**: Read-only. Reads a page by `kind/slug`.
- **`wiki_status`**: Read-only. Shows page counts, recent log entries, and `orphans` (raw files not cited by any page).
- **`wiki_parsers`**: Read-only. Lists currently available parsers.
- **`wiki_llm`**: Changes the saved model mode and asks for confirmation before applying.

### Handling the tail after 8 segments

`wiki_ingest` accepts only `path`, `text`, `title`, `mediaType`, `parsed`, and `llm`. There is no `offset`, `cursor`, `fromSegment`, or resume parameter to continue from segment 9. In `split.js`, `MAX_SEGMENTS = 8` with roughly 7500 characters per segment, and the excess character count is returned in `omitted`:

- The source index page sets `partial: true`, writes `后面还有未纳入的文字` in `summary`, and writes `后面约 N 字这一次没有纳入。` in its body (the program writes these exact Chinese strings).
- `wiki_lint` reports `code: PARTIAL` for pages with `partial: true`. Even with `apply: true`, it only edits existing pages and does not pull in the unread tail.
- Calling `wiki_ingest` again on the same full text still starts from the beginning and only expands the first 8 segments.
- To ingest the remaining tail, extract the unread portion into a separate new source (`path` or `text`) and call `wiki_ingest` again. The new source gets its own raw hash, and its pages can link to or update existing pages in the wiki.

## How retrieval finds evidence

1. Retrieval starts at catalog cards: title, aliases, and one claim. An alias match outranks a passing mention in page body text.
2. It then opens a few matching pages, follows `[[links]]` (one hop) and `relations`, and keeps both sides of any contradiction.
3. When words and the catalog do not pull candidates apart, local `multilingual-e5-small` vectors step in (without calling DeepSeek's embedding API). The first query downloads weights into the plugin's `.cache` directory; if that download fails, retrieval falls back to words, the catalog, and links.
4. When catalog and words still do not pull ahead, it tries headings a reader would look up.
5. Evidence sentences are reranked rather than reading blindly from the start of a page.
6. At most 10 pieces of evidence are returned, and `wiki_query` answers only from those pieces.

## Parsers

- **Built-in types**: Images (pixels only; never invent OCR text), Markdown, plain text, JSON, CSV, and HTML.
- **Types requiring an external parser**: PDF, Word, Excel, PowerPoint (PPT), audio, and video are not parsed here and return `NEED_EXTERNAL_PARSER`.
- **Unknown types**: Return `NO_PARSER`.
- **Connecting external parsers**: Another plugin can inject the `llm-wiki.parsers` service (`register` to add a parser, `accept` to preview parsed output), or pass the parsed document directly to `wiki_ingest` via `parsed` (mutually exclusive with `path` and `text`).
- **Parsed document format**: `parts` carry `text`, `table`, `caption`, `transcript`, or `image`, with `locator` for page, slide, or timestamp; original bytes go in `source.base64`. Tables stay with their headers, and a locator stays in the same segment as the table that follows it.
- **Extension and presentation**: `createRegistry` in `parsers.js` accepts extra parsers ahead of built-in ones, implementing `accepts` and `parse`. `presentSource` in `present.js` controls what text and images (up to 4 images) the model sees.

## Model choice and keys

Before a mode is chosen, `wiki_ingest` and `wiki_query` return `NEED_LLM_CHOICE`, and write neither `llm.json` nor raw material. The three modes are:

- `dsh`: Uses a model already available in the current DSH session (such as `dsv4flash`), sending messages as text blocks.
- `key`: Reads `DEEPSEEK_API_KEY` or the file named by `DEEPSEEK_KEY_FILE`. Key mode requests `deepseek-v4-flash` (the literal `dsv4.1flash` is rejected by the API, and responses usually report `deepseek-flash`).
- `off`: Skips model tasks in the plugin. Read-only queries and `wiki_lint` checks remain available, while `wiki_ingest` returns `LLM_OFF` before writing to disk.

An explicit `llm` argument overrides the saved mode and takes effect immediately. Changing the mode with `wiki_llm` asks for confirmation again. The choice is stored in `llm.json` inside the wiki directory and contains no key. Do not commit API keys to the repository.

Failures are appended to `log.md`. `wiki_status` lists unreferenced raw files in `orphans`. Write results include `approved` and `outcome`.
