# Gemini plugin for Claude Code

Use Gemini CLI from inside Claude Code for code reviews or to delegate tasks to Gemini.

This plugin is for Claude Code users who want an easy way to start using Google's Gemini CLI from the
workflow they already have. It is a community port of the official OpenAI Codex plugin for Claude Code,
re-targeted at the [Gemini CLI](https://github.com/google-gemini/gemini-cli) runtime.

## What You Get

- `/gemini:review` for a read-only Gemini code review
- `/gemini:adversarial-review` for a steerable challenge review
- `/gemini:rescue`, `/gemini:status`, `/gemini:result`, and `/gemini:cancel` to delegate work and manage background jobs

## Requirements

- **A Gemini CLI sign-in.** Either authenticate with a Google account, or set a `GEMINI_API_KEY`
  (Gemini Developer API) or `GOOGLE_API_KEY` (Vertex AI). Usage counts against your Gemini limits.
- **Node.js 18.18 or later**

> [!NOTE]
> Recent Gemini CLI versions no longer support the free "Gemini Code Assist for individuals" Google login
> for this kind of programmatic use. If `/gemini:setup` reports that your login is no longer supported,
> authenticate with a `GEMINI_API_KEY` instead.

## How It Works

The plugin drives Gemini CLI through its [Agent Client Protocol (ACP)](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)
runtime (`gemini --acp`): a JSON-RPC 2.0 connection over stdio. It opens a session, streams progress, and
captures Gemini's final answer. Permission prompts are auto-approved so runs are non-interactive (matching a
read-only review or a write-capable rescue), and one shared Gemini runtime is reused across a Claude session.

## Install

These commands are typed inside Claude Code (not in a shell).

Add the marketplace (`gemini-cli` is the marketplace name; `gemini` is the plugin):

```text
/plugin marketplace add kozaksv/gemini-plugin-cc
```

Install the plugin and reload:

```text
/plugin install gemini@gemini-cli
/reload-plugins
```

Then verify everything is ready:

```text
/gemini:setup
```

> [!TIP]
> Installing from your own fork? Swap `kozaksv` for your GitHub user. The marketplace add pulls the
> repository's **default branch**, so make sure the plugin is on that branch first.
>
> To install from a local clone instead of GitHub, point the marketplace at the folder that contains
> `.claude-plugin/marketplace.json`:
>
> ```text
> /plugin marketplace add /absolute/path/to/gemini-plugin-cc
> /plugin install gemini@gemini-cli
> ```

`/gemini:setup` will tell you whether Gemini is ready. If Gemini is missing and npm is available, it can
offer to install Gemini for you.

If you prefer to install Gemini yourself, use:

```bash
npm install -g @google/gemini-cli
```

If Gemini is installed but not authenticated yet, run `!gemini` once and pick a sign-in method, or set
`GEMINI_API_KEY` in your environment.

After install, you should see:

- the slash commands listed below
- the `gemini:gemini-rescue` subagent in `/agents`

One simple first run is:

```bash
/gemini:review --background
/gemini:status
/gemini:result
```

## Usage

### `/gemini:review`

Runs a read-only Gemini review on your current work and returns a clear, free-form review.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and
does not take custom focus text. Use [`/gemini:adversarial-review`](#geminiadversarial-review) when you want
to challenge a specific decision or risk area.

Examples:

```bash
/gemini:review
/gemini:review --base main
/gemini:review --background
```

This command is read-only and will not perform any changes.

### `/gemini:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design, and returns structured findings.

It uses the same review target selection as `/gemini:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/gemini:review`, it can take extra focus text after the flags.

Examples:

```bash
/gemini:adversarial-review
/gemini:adversarial-review --base main challenge whether this was the right caching and retry design
/gemini:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/gemini:rescue`

Hands a task to Gemini through the `gemini:gemini-rescue` subagent.

Use it when you want Gemini to investigate a bug, try a fix, continue a previous Gemini task, or take a
faster pass with a smaller model.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the
plugin can offer to continue a previous Gemini task for this repo.

Examples:

```bash
/gemini:rescue investigate why the tests started failing
/gemini:rescue fix the failing test with the smallest safe patch
/gemini:rescue --resume apply the top fix from the last run
/gemini:rescue --model gemini-2.5-pro --effort medium investigate the flaky integration test
/gemini:rescue --model spark fix the issue quickly
/gemini:rescue --background investigate the regression
```

**Notes:**

- if you do not pass `--model` or `--effort`, Gemini chooses its own defaults.
- if you say `spark`, the plugin maps that to `gemini-3.1-flash-lite`. Other aliases: `pro`, `flash`, `flash-lite`.
- `--effort` is accepted for compatibility but is not mapped to a Gemini control yet.
- follow-up rescue requests can continue the latest Gemini task in the repo.

### `/gemini:status`

Shows running and recent Gemini jobs for the current repository.

```bash
/gemini:status
/gemini:status task-abc123
```

### `/gemini:result`

Shows the final stored Gemini output for a finished job. When available, it also includes the Gemini session
ID so you can reopen that run with `gemini --resume <session-id>`.

```bash
/gemini:result
/gemini:result task-abc123
```

### `/gemini:cancel`

Cancels an active background Gemini job.

```bash
/gemini:cancel
/gemini:cancel task-abc123
```

### `/gemini:setup`

Checks whether Gemini is installed and authenticated. If Gemini is missing and npm is available, it can
offer to install Gemini for you.

You can also use `/gemini:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/gemini:setup --enable-review-gate
/gemini:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Gemini review based on
Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Gemini loop and may drain usage limits quickly. Only
> enable it when you plan to actively monitor the session.

## FAQ

### Do I need a separate Gemini account for this plugin?

If you are already signed into Gemini CLI on this machine, that auth is reused here too. If you only use
Claude Code today, sign in with `!gemini` or set `GEMINI_API_KEY` / `GOOGLE_API_KEY`. Run `/gemini:setup`
to check whether Gemini is ready.

### Does the plugin use a separate Gemini runtime?

No. It delegates through your local Gemini CLI (`gemini --acp`) on the same machine, using the same install,
the same authentication state, and the same repository checkout.

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Gemini CLI, your existing sign-in method and config still apply.

## Credits

This is a community port of OpenAI's [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc),
re-targeted at Gemini CLI. Licensed under Apache-2.0.
