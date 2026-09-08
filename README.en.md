<div align="center">

<img src=".github/assets/hero.svg" alt="StoryEngine — chat-driven long-form novel writing" width="760" />

<p>
  <a href="https://github.com/OrderG-X/StoryEngine/actions/workflows/ci.yml"><img src="https://github.com/OrderG-X/StoryEngine/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/license-AGPL--3.0-8b5cf6" alt="License: AGPL-3.0" />
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-43853d?logo=node.js&logoColor=white" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/pnpm-11-f69220?logo=pnpm&logoColor=white" alt="pnpm 11" />
  <img src="https://img.shields.io/badge/data-100%25%20local-f59e0b" alt="100% local data" />
</p>

<p>
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md"><b>English</b></a>
</p>

</div>

---

# StoryEngine

> 🚧 **Under active development**: the project is iterating quickly. Found a problem or want a feature? Open an [issue](https://github.com/OrderG-X/StoryEngine/issues) and we will take it seriously.

**Chat-driven long-form fiction writing. You talk to the AI; the AI calls tools to read/write story state, generate drafts, and review before committing — every state change goes through deterministic engine checks, previewable and reversible at each step.**

## What this is

Not "an AI that writes novels for you", but an **AI writing team that takes your direction**: you direct, the AI writes, self-checks, and keeps the books.

- **Dialogue-driven**: you talk, it writes. You always see what is being written and how it changes
- **Long-form without collapse**: it does not lose memory or mix up settings by chapter 200 — a hook planted in chapter 3 is still remembered in chapter 30
- **Anti-AI-flavor**: specifically strips the "this was written by AI" feel
- **Web research**: say "look up X" and the AI searches the web with cited sources — treated as reference material, never fabricated
- **Local-first**: your books, drafts, and settings live on your own machine

## Packages

- `packages/story-engine`: core state engine (draft / commit / review / threads / hooks / arc goals)
- `packages/story-engine-cli`: CLI for draft, commit, review, maintenance, and diagnostics flows
- `packages/story-engine-ui`: React author workbench plus the standalone local HTTP/SSE server (chat agent)
- `packages/story-engine-desktop`: Electron shell and guarded desktop packaging workflow

## Quick start

Requires Node.js `^20.20.0` / `^22.22.0` / `>=24.0.0` and pnpm 11:

```bash
pnpm install   # installs deps (auto-builds the core engine)
pnpm dev       # starts the writing workbench
```

Then open the address shown in the terminal (default `http://127.0.0.1:5173`).

**Model setup (BYO-key)**: open "AI 设置" (AI Settings) in the app sidebar, add a provider and paste your API key
(any OpenAI-compatible endpoint works: DeepSeek, GLM, Kimi, OpenAI, …). Keys stay on your machine
(`~/.story-engine/`); never commit keys to any repository.

## Currently disabled (no automation)

These paths are deliberately disabled or treated as unsafe — no automation is provided:

- `merge_threads` confirmation
- `drop_thread` confirmation
- Automatic cleanup / automatic intent expiry
- Automatic `mark_thread_done` / automatic `apply-review-plan --confirm`

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

GitHub CI runs these workspace commands on Node.js 22 and pnpm 11.

## Desktop

Desktop builds ship **without** any bundled model config (`preset-model-config`), and a post-pack probe verifies the artifacts contain no keys. A build with model presets is an explicitly dangerous internal-testing mode: it requires all three preset files plus the explicit confirmation env var `SE_ALLOW_SECRET_BUNDLE=I_UNDERSTAND_KEYS_ARE_EXTRACTABLE`, produces artifacts with a `-with-model-preset` suffix, and keeps outputs isolated as `dist-electron/clean/` vs `dist-electron/with-model-preset/`.

Desktop builds are currently **unsigned, internal-testing artifacts**. Code signing, notarization, and public distribution are not in place yet.

## Security notes

- Never distribute a desktop artifact built with model presets as a clean/public build — the bundled keys are extractable; discard it after internal testing

## License

AGPL-3.0.
