---
name: seo-radar
description: Build a daily demand picture for a niche from live search data. Use when asked for SEO trends, keyword demand, a niche radar, a daily market brief, or what people are searching for in a topic.
---

# SEO Radar

Turns three live readings into one file per niche per day:

- what people are searching for right now (`get_trending`)
- which keyword candidates the autocomplete engines accept (`get_keyword_research`)
- what the result page for a keyword looks like (`get_serp_snapshot`)

Every number in the file names the source it came from. A trend is not a
volume estimate, and the file keeps that difference visible.

## Run it

```bash
bunx @qexle/seo-mcp radar --niche "<topic>" --out radar-$(date +%F).md
```

Without `--out` the markdown goes to stdout, which is what an agent session
wants. `--seed "<keyword>"` starts the keyword pass from a specific term
instead of the niche phrase, and `--limit` sets how many rows each section
keeps (default 8).

As an MCP server the same three tools are available directly:

```json
{"tool": "get_trending", "arguments": {"niche": "seo tools", "geo": "US"}}
{"tool": "get_keyword_research", "arguments": {"seed": "technical seo audit", "depth": "quick"}}
{"tool": "get_serp_snapshot", "arguments": {"keyword": "technical seo audit"}}
```

## Working method

1. Pick the niche in the words a customer would type. "coffee shops in Berlin"
   beats "local coffee market".
2. Read the trends section first. It says what is moving now, so the keyword
   pass asks about live demand rather than a frozen list.
3. Use the keyword candidates as they are. The autocomplete rank is the
   engine's own order, so a candidate at rank 1 outranks a candidate at rank 6
   without needing a score.
4. Snapshot only the candidates that matter. Each snapshot is a live request.
5. Write the file with the date in the name, so a later run can be compared
   against it.

## Rules

- Name the source for every figure. The file already does, and a summary
  written from it must as well.
- Report the tools that came back silent. An engine that answered nothing is
  missing data, not zero demand.
- Keep the difficulty score labelled as an estimate. It is a score built from
  the visible result page, not a search volume.
- Do not add volume numbers. The keyless path has no volume source, and a
  made-up number is worse than a missing one.

## What it does not do

- It does not track a keyword over time. The daily file is the tracking, and
  the comparison happens between files.
- It does not read the page behind a ranking. `get_technical_audit` does that
  for one URL.
- It does not need a key. A CapSolver key only adds the Ahrefs path for
  backlink and traffic data.
