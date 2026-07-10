# ⚡ AI Limit

A Chrome extension that tracks **how much of your AI subscription limits remain** — all in
one place. Color-coded gauges that shift as your limit drops, a slim in-page strip plus a
right-edge panel on the site you're working on, and a **Token Reactor** dashboard that
*explodes* when you burn too fast. The UI is localized (English/Turkish) and follows your
browser language via `chrome.i18n`.

## Supported interfaces

The extension only reads the **usage numbers from your own session** — it never collects
passwords, cookies, or conversation content. Each provider has its own adapter
(`extension/adapters/`):

| Provider | Site | Data read | Source |
|----------|------|-----------|--------|
| **Claude** | `claude.ai` | Session (5h) + weekly + sub-limits (scoped/Opus/Sonnet); surface breakdown (Chat/Code); real Claude Code token usage (local collector) | `GET /api/organizations/{uuid}/usage` |
| **ChatGPT** | `chatgpt.com` | Usage percentage + reset + plan; feature allowances (Deep Research, file upload, image gen… remaining counts) | `wham/usage` + `conversation/init` |
| **Gemini** | `gemini.google.com` | Current window + weekly usage percentage + reset | `/usage` page RPC (`jSf9Qc`) |

The same UI runs on every site (`content/bar.js`, provider-agnostic):

- **Top strip** — color-coded gauges (by remaining %: blue → green → yellow → orange → red)
  with reset countdowns. 60% width, centered, rounded bottom corners; never blocks the page.
- **Right-edge handle** — vertical session % + weekly % + plan badge; click to slide the panel out.
- **Sliding detail panel** — all limit cards; feature allowance chips on ChatGPT; on Claude,
  the surface breakdown (how much of your session went to Chat vs Claude Code).
- **Popup** — summarizes all three providers in separate sections (toolbar icon).

## Color thresholds

By remaining limit (fixed in the product): **≥80** 🔵 blue · **60–80** 🟢 green ·
**40–60** 🟡 yellow · **20–40** 🟠 orange · **<20** 🔴 red.

## Install (developer)

1. `chrome://extensions` → Developer mode → **Load unpacked** → the `extension/` folder
2. If you're signed in to claude.ai / chatgpt.com / gemini.google.com, limits appear
   automatically (background sync roughly every 60s; no 5s polling — bot-flag risk).

## Structure

```
extension/
  adapters/      claude.js · chatgpt.js · gemini.js — one usage adapter per provider
  background.js  ~60s sync (three providers in parallel) + badge + delta attribution
  content/bar.js provider-agnostic in-page strip + handle + panel
  popup/         toolbar summary (three providers)
  dashboard/     Token Reactor — full-page panel (live burn rate)
  _locales/      en · tr (chrome.i18n, follows browser language)
```

## Principles

- **Never collect passwords, cookies, or conversations** — only the *numbers* from your own session.
- Fetch roughly every 60s / passively; no 5s polling.
- One adapter module per provider (when a format changes, only that file needs an update).
- Every source file starts with a `///` header index.
