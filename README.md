# pi-extensions

Custom extensions for [pi](https://github.com/earendil-works/pi-mono).

## Extensions

- `efficient-read/` — `read` tool override: bounded line-numbered reads, tail reads (`offset=-50`), read-window dedup, repeated-read nag.
- `tool-call-repair/` — repairs malformed tool calls from open models: field aliases, type coercion, missing-required blocking, `<repair_note>` feedback.
- `continuation-recovery/` — auto-continues turns that end empty, cut off by the output token limit, or with a dangling "I'll do that now…".
- `firecrawl/` — web tools via the [Firecrawl API](https://firecrawl.dev): search, scrape, map, and crawl.

### firecrawl

Four tools the model can call:

- `firecrawl_search` — search the web, returns results with full page content
- `firecrawl_scrape` — extract any URL as markdown/HTML/structured data (handles JS rendering and anti-bot)
- `firecrawl_map` — discover all URLs on a site (useful before crawling)
- `firecrawl_crawl` — recursively crawl a whole site (async, polls until done)

Needs an API key: set `FIRECRAWL_API_KEY`, or run `/firecrawl-key` to set it interactively.
The API base URL comes from `FIRECRAWL_BASE_URL` / `FIRECRAWL_API_URL`, defaulting to a local Firecrawl instance.

## Install

```bash
pi -e ./tool-call-repair/index.ts -e ./continuation-recovery/index.ts -e ./efficient-read/index.ts
```

Or symlink into `~/.pi/agent/extensions/` (hot-reloadable with `/reload`).

## Credits

These extensions were inspired by Command Code's engineering articles:

- [Tool call repairs](https://commandcode.ai/docs/harness-engineering/tool-call-repairs)
- [Read tool](https://commandcode.ai/docs/harness-engineering/read-tool)

I read those two articles, found it interesting how Command Code handles tool-call repairs and the read tool for open models, and thought I'd implement something similar for pi. All credit for the underlying ideas goes to the Command Code team.
