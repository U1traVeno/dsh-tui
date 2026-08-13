# dsh-tui

A Pi-styled, single-pane terminal client for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It rides over `dsh-base` as an out-of-tree profile bundle and drives the same in-process Cordis services the web GUI consumes — no webserver, no browser.

## Features

- Single-pane chat surface (header → transcript → spinner → input → footer).
- Streaming assistant output (text + reasoning) via the `session/event` firehose.
- Markdown rendering, tool-call cards with status-tinted backgrounds, todo list, goal/plan bars.
- Session management: `/session` (list + switch), `/session <id>`, `/session new`, `/rename <title>`.
- Model picker (`/model`), command palette (`Ctrl-X`), skills listing (`/skills`).
- Goals (`/goal …`), plan mode (`/plan`), background jobs (`/jobs`), subagents (`/subagents`).
- Approval prompts and `ask_user_question` dialogs as modal overlays.
- Settings viewer (`/settings`), per-message feedback (`/like` / `/dislike`).
- Host slash commands are routed through the harness command runtime (`/permission`, `/compact`, `/export`, `/feedback`, …).

## Install

Requires a working `dsh` installation and a configured LLM provider (e.g. a `llm-pi-ai` or `llm-deepseek` section in `$DSH_HOME/settings.yaml`).

```sh
# From npm
dsh plugin --profile tui add @v3n0/dsh-tui

# Or directly from git
dsh plugin --profile tui add github:U1traVeno/dsh-tui
```

This initializes the profile, installs the bundle, and appends `@v3n0/dsh-tui` to `dsh.profile.bundles` automatically.

## Usage

```sh
dsh --profile tui                 # start a fresh session
dsh --profile tui --resume <id>   # resume a persisted session
dsh --profile tui --model provider/model
dsh --profile tui --list          # list persisted sessions
```

In-session keys:

- `esc` / `ctrl-c` — interrupt the running turn (quit when idle).
- `ctrl-d` — exit on an empty line.
- `ctrl-x` — command palette.
- `ctrl-u` / `ctrl-w` — clear line / delete word.
- `↑` / `↓` — input history.

## Commands

`/help`, `/session [id|new]`, `/status`, `/model`, `/new`, `/goal <objective|pause|resume|complete|clear>`, `/plan [on|off]`, `/rename <title>`, `/settings`, `/jobs`, `/subagents`, `/skills`, `/like`, `/dislike`, `/clear`, `/exit`. Anything else starting with `/` is dispatched to the harness command runtime.

## Compatibility

`dsh` is pre-release; its core `@deepseek-ai/dsh-*` packages carry no stable API promise. This bundle programs only against documented `ctx` services (`agents`, `sessions`, `sessionQuery`, `sessionTitle`, `goals`, `planMode`, `jobs`, `subagents`, `skills`, `commands`, `settings`, `llm`, `approval`, `userQuestions`, `workspaceRegistry`). Report breakage against a specific `dsh` version.

## License

MIT
