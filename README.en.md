<div align="center">

<img src=".github/assets/hero.svg" alt="StoryEngine — you write the novel, the AI keeps the books" width="760" />

<p>
  <a href="https://github.com/OrderG-X/StoryEngine/actions/workflows/ci.yml"><img src="https://github.com/OrderG-X/StoryEngine/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/OrderG-X/StoryEngine/releases/latest"><img src="https://img.shields.io/github/v/release/OrderG-X/StoryEngine?label=download" alt="Download" /></a>
  <img src="https://img.shields.io/badge/license-AGPL--3.0-8b5cf6" alt="License: AGPL-3.0" />
  <img src="https://img.shields.io/badge/data-100%25%20local-f59e0b" alt="100% local data" />
</p>

<p>
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md"><b>English</b></a>
</p>

</div>

---

> 🚧 **Under active development.** Found a problem or want a feature? Open an [issue](https://github.com/OrderG-X/StoryEngine/issues).

**A desktop app for writing long-form fiction: you write the prose, and the AI beside you keeps the books — what happened in each chapter, whether it still agrees with earlier chapters, and your story bible. It can draft for you too, if you want.**

The interface is currently in Chinese.

## What it does

- **Per-chapter ledger**: when you commit a chapter, the AI records who appeared, what happened, open threads, and the in-story date — every entry quotes the text, and anything it can't back with a quote is reported as not recorded
- **Continuity check**: it reads the whole book and points out where this chapter contradicts earlier ones, quoting both sides
- **Story bible**: characters, places, items, and rules as cards you edit in place; the AI may only fill blanks or add new cards — changing anything you wrote needs your click
- **AI drafting if you want it**: brainstorm the next chapter, draft, revise on request, strip the "AI voice"
- **Everything is undoable**: the AI snapshots before every change; only you can commit a chapter, by clicking a button
- **Import an existing book**: a .txt is split into chapters and the AI fills in the ledger in the background
- **Web research** (optional): ask it to look things up; results come with sources and are used as reference only

## Install (macOS)

1. Download `StoryEngine-<version>-arm64.dmg` from [Releases](https://github.com/OrderG-X/StoryEngine/releases/latest) (Apple silicon Macs)
2. Open the dmg and drag StoryEngine into Applications
3. **macOS will block the first launch** (the app is not signed with an Apple Developer ID yet):
   - Double-click StoryEngine and click "Done" in the dialog
   - Open System Settings → Privacy & Security, scroll to the line saying StoryEngine was blocked, click "Open Anyway", and confirm with your password
   - It opens normally from then on

   Or, from a terminal:

   ```bash
   xattr -dr com.apple.quarantine /Applications/StoryEngine.app
   ```

There is no installer for Intel Macs or Windows yet — [run from source](#run-from-source) instead.

## Getting started

1. **Connect an AI**: the shelf shows "AI 还没接上" (AI not connected) — click "去接上", pick a provider (DeepSeek, Qwen, GLM, Kimi, OpenAI, … any OpenAI-compatible endpoint), paste your own API key, test the connection, and pick a model
2. **Open a book**: create a new one, or import one you've already written
3. **Web search** (optional): Settings → 搜索 (Search), add a [Bocha](https://open.bochaai.com) or [Tavily](https://app.tavily.com) key

Without an AI connected you can still write, save, and export.

## Your data

- Books, story bibles, and chat history stay on your machine (library at `~/StoryEngine-NG`)
- API keys are stored only in `~/.story-engine/`, readable only by your user account
- When you use the AI, chapter text and settings are sent to **the model provider you chose**; web searches send the query to **the search provider you chose**
- Nothing else goes over the network: no account, no analytics, no data collection

## Run from source

Requires Node.js `^20.20.0` / `^22.22.0` / `>=24.0.0` and pnpm 11:

```bash
pnpm install   # installs deps (auto-builds the core package)
pnpm dev       # starts the writing workbench
```

Then open the address shown in the terminal (default `http://127.0.0.1:5173`).

## Development

| Package | What it is |
|---|---|
| `packages/story-core` | The core: truth (per-chapter ledgers, author decisions, bible cards, chapter text), write commands (commit, record decision, save draft, import), and projections; pure TypeScript, no model calls |
| `packages/story-engine-ui` | React workbench plus the local HTTP/SSE server (chat agent, editorial room, drafting flows) |
| `packages/story-engine-desktop` | Electron shell and packaging (ships a slim git on macOS, so undo doesn't need the system git) |

```bash
pnpm test
pnpm typecheck
pnpm build
```

GitHub CI runs these on Node.js 22 and pnpm 11.

Desktop build: `packages/story-engine-desktop/build-desktop.sh --mac`. The default build ships **without** any model config, and a post-pack probe verifies no keys ended up in the artifact. A build with bundled model presets is an internal-testing mode that requires `SE_ALLOW_SECRET_BUNDLE=I_UNDERSTAND_KEYS_ARE_EXTRACTABLE`, gets a `-with-model-preset` suffix, and **must never be distributed**.

## License

[AGPL-3.0](LICENSE). If you modify it and offer it as a network service, you must publish your modified source. Third-party licenses are listed in the app under Settings → 关于 (About) → 第三方软件许可.
