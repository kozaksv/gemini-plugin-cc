# Gemini plugin (ACP port) — design

Date: 2026-06-20
Status: implemented

## Goal

Port the OpenAI **Codex plugin for Claude Code** into an equivalent **Gemini CLI**
plugin with maximum functional parity. Same commands, same job/state machinery,
same UX — only the underlying runtime changes from the Codex app-server to the
Gemini CLI **Agent Client Protocol (ACP)** (`gemini --acp`).

## Decisions

- **Runtime: ACP** (`gemini --acp`, JSON-RPC 2.0 over stdio), not headless. Keeps
  streaming progress, cancellation, and shared-runtime reuse.
- **Repo: full replacement.** `plugins/codex` → `plugins/gemini`; namespace
  `codex:` → `gemini:`; marketplace `gemini-cli`; author `Sergii Kozak`.
- **Permissions: auto-approve.** Mirrors Codex `approvalPolicy: "never"`. Read-only
  work uses session mode `plan`; `--write` uses `yolo`. Any `session/request_permission`
  is auto-allowed.
- **Layering mirrors Codex 1:1.** `acp-client.mjs` (transport) ⇄ `gemini.mjs`
  (protocol/capture) ⇄ broker; the protocol-agnostic libs (state, job-control,
  tracked-jobs, render, git, args, prompts, workspace, fs, process) are reused
  unchanged. The same `onProgress({message, phase})` vocabulary keeps render and
  job tracking untouched.

## Architecture

```
commands/*.md → gemini-companion.mjs (dispatch, jobs, background worker)
                     │
                     ├─ git.mjs (review context)         render.mjs / tracked-jobs / state / job-control
                     └─ gemini.mjs (runReview/runTurn, auth, availability)
                             │  capture: session/update → onProgress phases
                             └─ acp-client.mjs (JSON-RPC over stdio, bidirectional)
                                     ├─ direct: spawn `gemini --acp`
                                     └─ broker: acp-broker.mjs (one warm process, Unix socket)
```

## ACP protocol mapping (gemini-cli 0.47)

- Methods: `initialize`, `session/new`, `session/load` (resume), `session/prompt`,
  `session/cancel` (notification), `session/set_mode`, `session/set_model`,
  `session/close`. (`session/list`/`fork`/`resume` exist but are unused.)
- `session/prompt` is **blocking**: it resolves at end-of-turn with
  `{ stopReason }` (`end_turn` = success). Notifications stream during the await,
  so the request promise *is* the completion signal — no completion inference
  needed (unlike Codex `turn/start` + `turn/completed`).
- `session/update` notification discriminator is **`sessionUpdate`** (not `type`):
  `agent_message_chunk` (final text), `agent_thought_chunk` (reasoning),
  `tool_call` / `tool_call_update` (`{toolCallId, kind, status, title, locations[], content}`),
  `plan`, `available_commands_update`, `current_mode_update`.
- Touched files captured from `tool_call*` `locations[].path` where `kind ∈
  {edit,delete,move,create}`; commands from `kind == execute`.
- ACP is bidirectional: the agent issues `session/request_permission` (and could
  issue `fs/*`) back to the client. `acp-client.mjs` dispatches these to a handler
  (default: auto-approve). The broker relays them to the active socket and pipes
  the reply back.

## Notable behavior differences from Codex

- **No native reviewer.** Gemini has no `review/start`. Both `/gemini:review`
  (free-form Markdown) and `/gemini:adversarial-review` (structured JSON) are
  prompt-driven turns. The adversarial prompt embeds the JSON schema directly,
  since ACP `session/prompt` has no `outputSchema`.
- **Auth.** Google OAuth / `GEMINI_API_KEY` / Vertex AI instead of ChatGPT/OpenAI.
  `getGeminiAuthStatus` probes with a real `session/new` (free, no tokens) and
  classifies the deprecated-individual-login error toward API-key guidance.
- **`--effort`** is accepted for CLI compatibility but not mapped to a Gemini
  control. **Models**: aliases `pro/flash/flash-lite/lite/spark` → concrete ids;
  set via `session/set_model`.
- **Cross-session resume fallback** (`findLatestTaskThread`) returns null; resume
  relies on the plugin's own persisted job records (`threadId == sessionId`).

## Validation

- `npm test` — 38 tests green: protocol-agnostic libs + a fake `gemini --acp`
  fixture driving setup/auth, task capture, write/touched-files, review,
  adversarial JSON, background lifecycle, and broker reuse.
- Live smoke against real `gemini` 0.47.0: ACP turn, `setup --json` (auth ok),
  `status`.
