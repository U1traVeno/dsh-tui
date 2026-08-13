import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import readline from "node:readline";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { theme, colorEnabled, visibleWidth, truncateToWidth } from "./theme.js";
import { renderMarkdown } from "./markdown.js";
import { createHost } from "./host.js";

/**
 * dsh-tui — a Pi-styled interactive terminal chat over dsh-base.
 *
 * The visual language is borrowed from the `@earendil-works/pi-coding-agent`
 * ("Pi") TUI installed on this machine: sage/teal accent for the logo and
 * spinner, blue rules, gray full-width blocks for user messages, status-tinted
 * blocks for tool executions, and a dim two-line footer pinned at the bottom.
 *
 * The surface is a full-screen alternate-buffer TUI when stdin/stdout are a
 * TTY (streaming assistant deltas live via the `session/event` firehose), and
 * falls back to a styled line-oriented REPL when piped.
 * @module dsh-tui
 */

/** Stable Cordis plugin name. */
export const name = "tui-frontdoor";
/** Core services required before the first turn can start. */
export const inject = ["agentDefaultModel", "agents", "sessions"];

/** The process streams the front door writes to; tests substitute captures. */
const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
};

/** Strip ANSI control sequences so display width can be measured. */
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (text) => String(text).replace(ANSI, "");
const w = (text) => visibleWidth(strip(text));

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROMPT = `${theme.fg("accent", "❯")} `;
const PROMPT_WIDTH = 2;

/** Pad `text` with trailing spaces so its background covers the full width. */
function padBg(text, width, bgName) {
  if (!colorEnabled) return text;
  const pad = Math.max(0, width - w(text));
  return theme.bg(bgName, text + " ".repeat(pad));
}

/** Hard-wrap one plain-text line to `width` display cells, styled by `color`. */
function plainWrap(text, width, color) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (line === "") {
      out.push("");
      continue;
    }
    let cur = "";
    let curW = 0;
    for (const ch of line) {
      const cw = visibleWidth(ch);
      if (curW + cw > width && cur !== "") {
        out.push(cur);
        cur = "";
        curW = 0;
      }
      cur += ch;
      curW += cw;
    }
    if (cur !== "") out.push(cur);
  }
  return out.map((line) => (line === "" ? "" : color(line)));
}

/** Extract the visible text from a `tool/result` message. */
function toolResultText(event) {
  const block = event.data.message?.content?.[0];
  if (!block || block.type !== "tool-result") return "";
  const parts = [];
  for (const c of block.content ?? []) {
    if (c.type === "text") parts.push(c.text);
  }
  return parts.join("").trim();
}

/** Best-effort synchronous git branch lookup (no process spawn). */
function gitBranch(cwd) {
  try {
    let headPath = join(cwd, ".git", "HEAD");
    if (existsSync(headPath)) {
      const head = readFileSync(headPath, "utf8").trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      if (ref) return ref[1];
      return head.slice(0, 8);
    }
    // Worktree: `.git` is a file pointing at the real dir.
    const gitFile = join(cwd, ".git");
    if (existsSync(gitFile)) {
      const content = readFileSync(gitFile, "utf8");
      const dir = /^gitdir:\s*(.+)$/m.exec(content);
      if (dir) {
        const head = readFileSync(join(dir[1].trim(), "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) return ref[1];
        return head.slice(0, 8);
      }
    }
  } catch {
    /* not a git repo (or unreadable) — footer omits the branch */
  }
  return undefined;
}

/** Collapse the home directory prefix to `~` for the footer. */
function shortCwd(cwd, home) {
  const resolved = relative(home, cwd);
  if (resolved === "") return "~";
  if (!resolved.startsWith(`..${sep}`) && !resolved.startsWith(sep) && !resolved.includes("..")) {
    return `~${sep}${resolved}`;
  }
  return cwd;
}

function formatTokens(count) {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

// ---------------------------------------------------------------------------
// Transcript: an event-fed, renderable history (shared by both render paths).
// ---------------------------------------------------------------------------

function createTranscript() {
  const t = {
    items: [],
    live: null,
    seenSeq: -1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    turns: 0,
    todoItem: null,
    lastWasDivider: false,
    title: null,
    permission: null,
    lastAssistantMessageId: null,
  };

  function pushDivider() {
    if (t.items.length > 0 && !t.lastWasDivider) {
      t.items.push({ kind: "divider" });
      t.lastWasDivider = true;
    }
  }

  function push(item) {
    t.items.push(item);
    t.lastWasDivider = item.kind === "divider";
  }

  function liveBlock(index, type) {
    if (!t.live) t.live = [];
    if (!t.live[index]) t.live[index] = { type, text: "" };
    return t.live[index];
  }

  function finalizeAssistant(message) {
    t.live = null;
    for (const block of message.content ?? []) {
      if (block.type === "text" && block.text.trim() !== "") {
        push({ kind: "text", text: block.text });
      } else if (block.type === "reasoning" && block.text.trim() !== "") {
        push({ kind: "thinking", text: block.text });
      }
    }
  }

  function ingest(event) {
    if (event.seq <= t.seenSeq) return;
    t.seenSeq = event.seq;
    switch (event.type) {
      case "user/message": {
        if (event.data.source?.kind !== "user") break; // skip injected runtime context
        const text = event.data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (text.trim() === "") break;
        pushDivider();
        push({ kind: "user", text });
        break;
      }
      case "step/start": {
        t.live = [];
        break;
      }
      case "assistant/chunk": {
        const chunk = event.data.chunk;
        if (chunk.type === "text-delta") {
          liveBlock(chunk.index, "text").text += chunk.text;
        } else if (chunk.type === "reasoning-delta") {
          liveBlock(chunk.index, "reasoning").text += chunk.text;
        }
        break;
      }
      case "assistant/message": {
        finalizeAssistant(event.data.message);
        t.lastAssistantMessageId = event.data.message.id;
        const usage = event.data.usage;
        if (usage) {
          t.usage.input += usage.inputTokens ?? 0;
          t.usage.output += usage.outputTokens ?? 0;
          t.usage.cacheRead += usage.cacheReadTokens ?? 0;
          t.usage.cacheWrite += usage.cacheWriteTokens ?? 0;
          t.usage.reasoning += usage.reasoningTokens ?? 0;
        }
        break;
      }
      case "tool/call": {
        push({
          kind: "tool",
          callId: event.data.callId,
          name: event.data.name,
          args: event.data.arguments,
          status: "pending",
          output: "",
          isError: false,
        });
        break;
      }
      case "tool/result": {
        const callId = event.data.message?.source?.callId;
        const block = event.data.message?.content?.[0];
        const isError = Boolean(block?.isError || event.data.error);
        const output = toolResultText(event);
        for (let i = t.items.length - 1; i >= 0; i--) {
          const item = t.items[i];
          if (item.kind === "tool" && item.callId === callId) {
            item.status = isError ? "error" : "success";
            item.isError = isError;
            item.output = output;
            break;
          }
        }
        break;
      }
      case "todo/write": {
        if (!t.todoItem) {
          t.todoItem = { kind: "todo", todos: [] };
          push(t.todoItem);
        }
        t.todoItem.todos = event.data.todos ?? [];
        break;
      }
      case "turn/end": {
        t.turns += 1;
        const reason = event.data.reason;
        if (reason?.kind === "error") {
          const code = reason.error?.code ?? "unknown";
          push({ kind: "error", message: `turn ended with error: ${code}` });
        }
        break;
      }
      case "goal/change": {
        const meta = event.data;
        const goal = meta.goal ?? meta;
        const phase = goal.phase ?? meta.phase;
        const objective = goal.objective ?? meta.objective;
        if (objective !== undefined) {
          push({ kind: "goal", objective, phase });
        }
        break;
      }
      case "plan/mode": {
        push({ kind: "notice", message: event.data.active ? "◑ plan mode on — the agent will plan, not implement" : "◑ plan mode off" });
        break;
      }
      case "permission/preset": {
        t.permission = event.data.preset;
        break;
      }
      case "session/title": {
        t.title = event.data.title ?? event.data;
        break;
      }
      case "compaction/start": {
        push({ kind: "notice", message: "compacting context…" });
        break;
      }
      case "compaction/end": {
        push({ kind: "notice", message: "compaction complete" });
        break;
      }
      case "command/run": {
        push({ kind: "notice", message: `⌘ ${event.data.name}${event.data.args ? ` ${event.data.args}` : ""}` });
        break;
      }
      case "schedule/change": {
        push({ kind: "notice", message: "reminder scheduled" });
        break;
      }
      case "feedback/record": {
        push({ kind: "notice", message: `feedback: ${event.data.text ?? ""}`.trim() });
        break;
      }
      default:
        break;
    }
  }

  t.ingest = ingest;
  t.push = push;
  t.pushDivider = pushDivider;
  return t;
}

// ---------------------------------------------------------------------------
// Item → line rendering (cached per width for stable items).
// ---------------------------------------------------------------------------

function itemLines(item, width) {
  if (item._cacheW === width && item._cacheLines) return item._cacheLines;
  let lines;
  switch (item.kind) {
    case "divider":
      lines = [theme.fg("darkGray", "─".repeat(Math.max(1, width)))];
      break;
    case "user": {
      const body = renderMarkdown(item.text, Math.max(1, width - 2));
      lines = ["", ...body.map((ln) => padBg(`  ${ln}`, width, "userMsgBg")), ""];
      break;
    }
    case "text": {
      lines = renderMarkdown(item.text, Math.max(1, width - 2)).map((ln) => (ln === "" ? "" : `  ${ln}`));
      break;
    }
    case "thinking": {
      lines = plainWrap(item.text, Math.max(1, width - 2), (ln) => theme.italic(theme.fg("gray", ln))).map((ln) => (ln === "" ? "" : `  ${ln}`));
      break;
    }
    case "tool": {
      lines = toolLines(item, width);
      break;
    }
    case "todo": {
      lines = todoLines(item, width);
      break;
    }
    case "goal": {
      const phaseIcon = item.phase === "completed" ? theme.fg("green", "◆")
        : item.phase === "blocked" ? theme.fg("red", "◆")
        : theme.fg("accent", "◆");
      const label = `${phaseIcon} goal (${item.phase ?? "active"})`;
      lines = [theme.dim(`  ${label}`), ...plainWrap(item.objective, Math.max(1, width - 4), (ln) => theme.fg("accent", ln)).map((ln) => `    ${ln}`)];
      break;
    }
    case "error":
      lines = [theme.fg("red", `  ✗ ${item.message}`)];
      break;
    case "notice":
      lines = plainWrap(item.message, Math.max(1, width - 2), (ln) => theme.dim(ln)).map((ln) => (ln === "" ? "" : `  ${ln}`));
      break;
    default:
      lines = [""];
  }
  if (item.kind !== "tool" && item.kind !== "user") {
    // markdown/plain renderers are the only ones we cache; tool blocks recompute
    // cheaply on resize.
    item._cacheW = width;
    item._cacheLines = lines;
  }
  return lines;
}

function toolLines(item, width) {
  const bg = item.status === "pending" ? "toolPendingBg" : item.isError ? "toolErrorBg" : "toolSuccessBg";
  const icon =
    item.status === "pending" ? theme.fg("yellow", "⚙")
    : item.isError ? theme.fg("red", "✗")
    : theme.fg("green", "✓");
  const title = `${icon} ${theme.fg("toolTitle", theme.bold(item.name))}`;
  const args = item.args.replace(/\s+/g, " ").trim();
  const titleLine = padBg(`  ${title}${args ? `  ${theme.dim(truncateToWidth(args, Math.max(8, width - w(title) - 4)))}` : ""}`, width, bg);
  const out = [];
  const maxOut = 24;
  let raw = item.output;
  let truncated = false;
  if (raw.length > 4000) {
    raw = raw.slice(0, 4000);
    truncated = true;
  }
  const body = plainWrap(raw, Math.max(1, width - 4), (ln) => theme.fg("toolOutput", ln));
  const shown = body.slice(0, maxOut);
  for (const ln of shown) out.push(padBg(`  ${ln}`, width, bg));
  if (body.length > maxOut || truncated) {
    out.push(padBg(`  ${theme.dim("… output truncated")}`, width, bg));
  }
  return [titleLine, ...out];
}

function todoLines(item, width) {
  const out = [theme.dim(`  ${theme.fg("accent", "▸")} plan`)];
  for (const todo of item.todos) {
    const mark =
      todo.status === "completed" ? theme.fg("green", "✓")
      : todo.status === "in_progress" ? theme.fg("yellow", "~")
      : theme.fg("darkGray", "·");
    const body = todo.status === "completed" ? theme.dim(todo.content) : todo.content;
    out.push(`  ${mark} ${body}`);
  }
  return out;
}

function liveLines(live, width) {
  if (!live) return [];
  const out = [];
  for (const block of live) {
    if (!block) continue;
    if (block.type === "reasoning") {
      out.push(...plainWrap(block.text, Math.max(1, width - 2), (ln) => theme.italic(theme.fg("gray", ln))).map((ln) => (ln === "" ? "" : `  ${ln}`)));
    } else {
      out.push(...renderMarkdown(block.text, Math.max(1, width - 2)).map((ln) => (ln === "" ? "" : `  ${ln}`)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full-screen interactive TUI.
// ---------------------------------------------------------------------------

function runInteractive(ctx, handle, selection, resumed, io) {
  const host = createHost(ctx);
  const tr = createTranscript();
  const cwd = process.cwd();
  const branch = gitBranch(cwd);
  const home = process.env.HOME || process.env.USERPROFILE || cwd;
  const footerPwd = `${shortCwd(cwd, home)}${branch ? ` (${branch})` : ""}`;

  let width = io.stdout.columns || 80;
  let height = io.stdout.rows || 24;
  let spin = 0;
  let finished = false;
  let running = false;
  let renderPending = false;
  const inputQueue = [];
  const inputHistory = [];
  let histIndex = 0;
  let input = "";

  // Mutable agent state (session switching).
  let agent = handle.agent;
  let agentHandle = handle;
  let currentResumed = resumed;
  let disposeEvent = null;

  // UI state.
  let modal = null; // { title, body?, items: [{label, detail?}], hint, selected, onSelect, onCancel }

  const agentsService = ctx.get("agents");
  const agentOptions = { provider: selection.provider, model: selection.model };
  const setup = (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: void 0 });
  };

  // Rebuild the transcript from the current agent's log and (re)subscribe.
  function bindSession() {
    tr.items = [];
    tr.live = null;
    tr.todoItem = null;
    tr.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    tr.turns = 0;
    tr.title = null;
    tr.lastWasDivider = false;
    tr.seenSeq = -1;
    for (const event of agent.session.events) tr.ingest(event);
    if (typeof disposeEvent === "function") disposeEvent();
    disposeEvent = ctx.on("session/event", (session, event) => {
      if (session.id !== agent.session.id) return;
      tr.ingest(event);
      requestRender();
    });
  }
  bindSession();

  const header = [
    `${theme.bold(theme.fg("accent", "dsh tui"))}${theme.dim(" — DeepSeek Harness terminal")}`,
    theme.dim(`  /session switch · ctrl-x commands · /model · /goal · /plan · esc interrupt · ctrl-d exit · /help`),
  ];

  function requestRender() {
    if (renderPending || finished) return;
    renderPending = true;
    setImmediate(() => {
      renderPending = false;
      render();
    });
  }

  function spinnerLine() {
    const frame = SPINNER[spin % SPINNER.length];
    return `  ${theme.fg("accent", frame)} ${theme.fg("gray", "working…")}${theme.dim("  (esc to interrupt)")}`;
  }

  function footer(width) {
    const stats = [`↑${formatTokens(tr.usage.input)}`, `↓${formatTokens(tr.usage.output)}`];
    if (tr.usage.cacheRead) stats.push(`R${formatTokens(tr.usage.cacheRead)}`);
    stats.push(`${tr.turns} turn${tr.turns === 1 ? "" : "s"}`);
    const left = stats.join("  ");
    const right = `${selection.provider}/${selection.model}`;
    const pad = Math.max(2, width - w(left) - w(right));
    const pwd = `${footerPwd}${tr.permission ? ` · ${tr.permission}` : ""}${tr.title ? ` · ${truncateToWidth(tr.title, 24)}` : ""}`;
    return [
      theme.dim(truncateToWidth(pwd, width)),
      theme.dim(truncateToWidth(left + " ".repeat(pad) + right, width)),
    ];
  }

  // Persistent goal/plan context bar (read live from services each frame).
  function contextBar(width) {
    const lines = [];
    const goal = host.goal(agent);
    if (goal?.objective) {
      const icon = goal.phase === "completed" ? theme.fg("green", "◆") : goal.phase === "blocked" ? theme.fg("red", "◆") : theme.fg("accent", "◆");
      lines.push(`  ${icon} ${theme.fg("accent", `goal (${goal.phase ?? "active"})`)}  ${truncateToWidth(goal.objective, Math.max(8, width - 24))}`);
      if (goal.blockedReason) lines.push(`  ${theme.fg("red", `blocked: ${goal.blockedReason}`)}`);
    }
    const plan = host.planMode(agent);
    if (plan?.active) {
      lines.push(`  ${theme.fg("mdHeading", "◑ plan mode")}  ${theme.dim("planning only — exit_plan_mode to implement")}`);
    }
    return lines;
  }

  function buildModal(width) {
    const boxW = Math.min(width - 4, 62);
    const pad = " ".repeat(Math.max(0, Math.floor((width - boxW) / 2)));
    const line = (content) => {
      const padded = content + " ".repeat(Math.max(0, boxW - w(content)));
      return pad + theme.bg("selectedBg", padded);
    };
    const lines = [];
    lines.push(line(theme.bold(theme.fg("accent", ` ${modal.title} `))));
    if (modal.body) {
      for (const bl of modal.body) {
        for (const l of plainWrap(bl, boxW - 2, (x) => x)) lines.push(line(` ${l}`));
      }
    }
    for (let i = 0; i < modal.items.length; i++) {
      const it = modal.items[i];
      const sel = i === modal.selected;
      const label = `${sel ? "❯ " : "  "}${it.label}${it.detail ? theme.dim(`  ${it.detail}`) : ""}`;
      lines.push(line(sel ? theme.fg("accent", label) : theme.dim(label)));
    }
    lines.push(line(theme.dim(modal.hint ?? "↑↓ navigate · enter select · esc cancel")));
    return lines.map((l) => l + " ".repeat(Math.max(0, width - w(l))));
  }

  function render() {
    if (finished) return;
    width = io.stdout.columns || width;
    height = io.stdout.rows || height;

    const footerLines = footer(width);
    const statusLine = tr.busy ? spinnerLine() : null;
    const inputBox = [
      theme.fg("blue", "─".repeat(Math.max(1, width))),
      PROMPT + input,
    ];
    const context = contextBar(width);
    const reserved = footerLines.length + inputBox.length + (statusLine ? 1 : 0) + context.length;
    const scrollHeight = Math.max(1, height - reserved);

    const scroll = [];
    scroll.push(...header);
    scroll.push("");
    for (const item of tr.items) scroll.push(...itemLines(item, width));
    scroll.push(...liveLines(tr.live, width));
    const visible = scroll.slice(-scrollHeight);
    while (visible.length < scrollHeight) visible.push("");

    let frame = [...context, ...visible, ...(statusLine ? [statusLine] : []), ...inputBox, ...footerLines];
    frame = frame.map((line) => {
      const lw = w(line);
      return lw >= width ? line : line + " ".repeat(width - lw);
    });
    if (modal) {
      const box = buildModal(width);
      const startRow = Math.max(0, Math.floor((frame.length - box.length) / 2));
      for (let i = 0; i < box.length && startRow + i < frame.length; i++) frame[startRow + i] = box[i];
    }

    const inputRow = frame.length - footerLines.length; // 1-indexed
    const cursorCol = 1 + PROMPT_WIDTH + visibleWidth(input);

    let out = "\x1b[?25l\x1b[H";
    out += frame.join("\n");
    out += "\x1b[J";
    out += `\x1b[${inputRow};${cursorCol}H\x1b[?25h`;
    io.stdout.write(out);
  }

  function startBusyLoop() {
    (async () => {
      try {
        while (inputQueue.length) {
          const text = inputQueue.shift();
          tr.busy = true;
          render();
          agent.followup(createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "user" },
          }));
          await agent.whenIdle();
          tr.busy = false;
          render();
        }
      } catch (error) {
        tr.busy = false;
        tr.push({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        running = false;
        tr.busy = false;
        render();
        if (state.exitRequested) void finish(0);
      }
    })();
  }

  function submit() {
    const text = input.trim();
    input = "";
    if (text === "") {
      render();
      return;
    }
    if (text.startsWith("/")) {
      handleCommand(text);
      render();
      return;
    }
    inputHistory.push(text);
    histIndex = inputHistory.length;
    inputQueue.push(text);
    render();
    if (!running) {
      running = true;
      startBusyLoop();
    }
  }

  const state = { exitRequested: false };

  function openListModal(title, items, onSelect, opts = {}) {
    modal = { title, items, selected: 0, onSelect, onCancel: opts.onCancel ?? (() => { modal = null; }), body: opts.body, hint: opts.hint };
    render();
  }

  function openCommandPalette() {
    const commands = ctx.get("commands");
    const defs = commands?.list(agent) ?? [];
    if (defs.length === 0) {
      tr.push({ kind: "notice", message: "no commands registered" });
      render();
      return;
    }
    openListModal("commands", defs.map((d) => ({ label: `/${d.name}`, detail: d.description })), (idx) => {
      const d = defs[idx];
      input = `/${d.name} `;
      render();
    }, { hint: "enter to fill the input line" });
  }

  async function openModelPicker() {
    const providers = host.listProviders();
    if (providers.length === 0) {
      tr.push({ kind: "notice", message: "no model providers registered" });
      render();
      return;
    }
    openListModal("select provider", providers.map((p) => ({ label: p.name ?? p.id, detail: p.id })), async (idx) => {
      const provider = providers[idx];
      modal = null;
      let models = [];
      try {
        models = await host.listModels(provider.id);
      } catch {
        models = [];
      }
      if (models.length === 0) {
        tr.push({ kind: "notice", message: `no models for ${provider.id}` });
        render();
        return;
      }
      openListModal(`select model — ${provider.name ?? provider.id}`, models.map((m) => ({ label: m.name ?? m.id, detail: m.contextWindow ? `${m.contextWindow} ctx` : m.id })), (mi) => {
        const model = models[mi];
        modal = null;
        selection.provider = model.provider;
        selection.model = model.id;
        void host.saveSelection({ ...selection });
        tr.push({ kind: "notice", message: `model → ${model.provider}/${model.id}` });
        render();
      });
    });
  }

  function handleCommand(text) {
    if (text === "/exit" || text === "/quit") {
      state.exitRequested = true;
      if (!running) void finish(0);
      return;
    }
    if (text === "/help") {
      tr.push({ kind: "notice", message: "commands:\n  /help      show this help\n  /session   switch session (or /session <id>, /session new)\n  /status    session, model, and turn summary\n  /model     switch model\n  /goal <s>  set the goal objective\n  /plan      toggle plan mode\n  /clear     clear the transcript\n  /exit      flush the session and exit\n\neverything else is sent to the agent" });
      return;
    }
    if (text === "/status") {
      tr.push({ kind: "notice", message: `session : ${agent.session.id}${currentResumed ? " (resumed)" : ""}\nseq     : ${agent.session.seq}\nturns   : ${tr.turns}\nmodel   : ${selection.provider}/${selection.model}\nusage   : ↑${formatTokens(tr.usage.input)} ↓${formatTokens(tr.usage.output)}\ncwd     : ${cwd}` });
      return;
    }
    if (text === "/session" || text.startsWith("/session ")) {
      const arg = text.slice(9).trim();
      if (arg === "new") {
        void newSession();
        return;
      }
      if (arg !== "") {
        void switchSession(arg);
        return;
      }
      void (async () => {
        const list = await host.listSessions();
        if (list.length === 0) {
          tr.push({ kind: "notice", message: "no sessions" });
          render();
          return;
        }
        openListModal("sessions", list.map((s) => ({
          label: s.id === agent.session.id ? `● ${truncateToWidth(s.title, 40)}` : truncateToWidth(s.title, 40),
          detail: s.id === agent.session.id ? "current" : s.id,
        })), (idx) => {
          const s = list[idx];
          modal = null;
          if (s.id !== agent.session.id) void switchSession(s.id);
        }, { hint: "enter to switch session · esc cancel" });
      })();
      return;
    }
    if (text === "/model") {
      void openModelPicker();
      return;
    }
    if (text === "/new") {
      void newSession();
      return;
    }
    if (text === "/clear") {
      tr.items = [];
      tr.todoItem = null;
      return;
    }
    if (text === "/plan" || text.startsWith("/plan ")) {
      const planMode = ctx.get("planMode");
      if (planMode === void 0) {
        tr.push({ kind: "notice", message: "plan mode unavailable" });
        return;
      }
      const arg = text.slice(5).trim();
      const current = planMode.get(agent)?.active ?? false;
      const want = arg === "" ? !current : arg !== "off" && arg !== "0";
      const result = planMode.set(agent, want);
      tr.push({ kind: "notice", message: `plan mode ${want ? "on" : "off"} (${result})` });
      return;
    }
    if (text === "/like" || text === "/dislike") {
      const rating = text === "/like" ? "positive" : "negative";
      const feedback = ctx.get("messageFeedback");
      const messageId = tr.lastAssistantMessageId;
      if (feedback === void 0 || messageId === undefined) {
        tr.push({ kind: "notice", message: "nothing to rate yet" });
        return;
      }
      void (async () => {
        try {
          await feedback.put({ sessionId: agent.session.id, messageId, rating });
          tr.push({ kind: "notice", message: `rated ${rating === "positive" ? "👍" : "👎"} (${rating})` });
        } catch (error) {
          tr.push({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }
        render();
      })();
      return;
    }
    if (text === "/settings") {
      const settings = ctx.get("settings");
      const descriptors = settings?.describe() ?? [];
      if (descriptors.length === 0) {
        tr.push({ kind: "notice", message: "no settings namespaces" });
        return;
      }
      openListModal("settings", descriptors.map((d) => ({ label: String(d.ns), detail: d.value === undefined ? "—" : typeof d.value === "object" ? "(object)" : truncateToWidth(String(d.value), 32) })), (idx) => {
        const d = descriptors[idx];
        const shown = typeof d.value === "object" ? JSON.stringify(d.value, null, 2) : String(d.value ?? "(unset)");
        tr.push({ kind: "notice", message: `${d.ns} = ${shown}` });
        render();
      }, { hint: "read-only view · enter to show value" });
      return;
    }
    if (text === "/jobs") {
      const jobs = ctx.get("jobs");
      const list = jobs?.list(agent) ?? [];
      if (list.length === 0) tr.push({ kind: "notice", message: "no background jobs" });
      else tr.push({ kind: "notice", message: list.map((j) => `${j.status === "running" ? "▶" : j.status === "stopping" ? "■" : "✓"} ${j.label} (${j.status})`).join("\n") });
      return;
    }
    if (text === "/subagents") {
      void (async () => {
        const children = await host.listSubagentChildren(agent.session.id);
        if (children.length === 0) tr.push({ kind: "notice", message: "no child subagents" });
        else tr.push({ kind: "notice", message: children.map((c) => `⬢ ${c.label ?? c.sessionId ?? c.id ?? "?"}`).join("\n") });
        render();
      })();
      return;
    }
    if (text === "/skills") {
      void (async () => {
        const skills = await host.listSkills();
        if (skills.length === 0) tr.push({ kind: "notice", message: "no skills available" });
        else tr.push({ kind: "notice", message: skills.map((s) => `${s.name} — ${s.description ?? ""}`.trim()).join("\n") });
        render();
      })();
      return;
    }
    if (text.startsWith("/goal")) {
      const goals = ctx.get("goals");
      const arg = text.slice(5).trim();
      if (goals === void 0) {
        tr.push({ kind: "notice", message: "goal service unavailable" });
        return;
      }
      if (["pause", "resume", "complete", "clear"].includes(arg)) {
        const g = goals.get(agent);
        if (g === undefined) {
          tr.push({ kind: "notice", message: "no active goal" });
          return;
        }
        try {
          goals[arg](agent, { id: g.id, revision: g.revision });
          tr.push({ kind: "notice", message: `goal ${arg}${arg === "clear" ? "ed" : arg === "complete" ? "d" : "d"}` });
        } catch (error) {
          tr.push({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (arg === "") {
        tr.push({ kind: "notice", message: "usage: /goal <objective> | pause | resume | complete | clear" });
        return;
      }
      try {
        goals.create(agent, { objective: arg });
        tr.push({ kind: "notice", message: `goal set: ${arg}` });
      } catch (error) {
        tr.push({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (text.startsWith("/rename ")) {
      const title = text.slice(8).trim();
      const sessionTitle = ctx.get("sessionTitle");
      if (sessionTitle === void 0 || title === "") {
        tr.push({ kind: "notice", message: title === "" ? "usage: /rename <title>" : "title service unavailable" });
        return;
      }
      try {
        sessionTitle.rename(agent.session, title);
        tr.push({ kind: "notice", message: `retitled: ${title}` });
      } catch (error) {
        tr.push({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // Fall through to the host command runtime (e.g. /permission, /compact,
    // /export, /feedback) — the same dispatch the web client uses.
    const commands = ctx.get("commands");
    if (commands === void 0) {
      tr.push({ kind: "notice", message: `unknown command: ${text} (try /help or ctrl-x)` });
      return;
    }
    void (async () => {
      const signal = new AbortController().signal;
      try {
        const execution = await commands.execute(agent, text, signal);
        if (execution === undefined) {
          tr.push({ kind: "notice", message: `unknown command: ${text} (try /help or ctrl-x)` });
        } else if (execution.result.text) {
          tr.push({ kind: execution.result.kind === "error" ? "error" : "notice", message: execution.result.text });
        }
      } catch (error) {
        tr.push({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
      render();
    })();
  }

  function interrupt() {
    if (tr.busy) {
      agent.cancel({ kind: "user" });
      tr.push({ kind: "error", message: "interrupted" });
      tr.busy = false;
      render();
    } else {
      state.exitRequested = true;
      if (!running) void finish(0);
    }
  }

  async function newSession() {
    if (tr.busy || agentsService === void 0) return;
    if (agentHandle) await agentHandle.dispose().catch(() => {});
    agentHandle = await agentsService.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    });
    agent = agentHandle.agent;
    currentResumed = false;
    await agent.whenIdle();
    bindSession();
    render();
  }

  async function switchSession(sessionId) {
    if (tr.busy || agentsService === void 0 || sessionId === agent.session.id) return;
    if (agentHandle) await agentHandle.dispose().catch(() => {});
    agentHandle = await agentsService.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions,
      setup,
    });
    agent = agentHandle.agent;
    currentResumed = true;
    await agent.whenIdle();
    bindSession();
    render();
  }

  function backspace() {
    const chars = Array.from(input);
    chars.pop();
    input = chars.join("");
  }

  function handleKey(ch) {
    if (modal) {
      if (ch === "\x1b") { modal.onCancel?.(); modal = null; render(); return; }
      if (ch === "\r" || ch === "\n") { const m = modal; modal = null; m.onSelect(m.selected); return; }
      if (ch === "\t") { if (modal.items.length) modal.selected = (modal.selected + 1) % modal.items.length; render(); return; }
      return;
    }
    if (ch === "\x03") return interrupt(); // Ctrl-C
    if (ch === "\x04") {
      if (input === "" && !tr.busy) {
        state.exitRequested = true;
        if (!running) void finish(0);
      }
      return;
    }
    if (ch === "\r" || ch === "\n") return submit();
    if (ch === "\x7f" || ch === "\x08") return backspace();
    if (ch === "\x15") { input = ""; return; } // Ctrl-U
    if (ch === "\x17") { input = input.replace(/\S+\s*$/, ""); return; } // Ctrl-W
    if (ch === "\x0c") { render(); return; } // Ctrl-L repaint
    if (ch === "\x18") { openCommandPalette(); return; } // Ctrl-X command palette
    if (ch >= " ") input += ch;
  }

  function handleEscape(seq) {
    if (modal) {
      switch (seq) {
        case "\x1b[A": if (modal.selected > 0) modal.selected -= 1; render(); break;
        case "\x1b[B": if (modal.selected < modal.items.length - 1) modal.selected += 1; render(); break;
        case "\x1b": { const m = modal; modal = null; m.onCancel?.(); render(); break; }
        default: break;
      }
      return;
    }
    switch (seq) {
      case "\x1b[A": // up
        if (histIndex > 0) {
          histIndex -= 1;
          input = inputHistory[histIndex] ?? "";
        }
        break;
      case "\x1b[B": // down
        if (histIndex < inputHistory.length) {
          histIndex += 1;
          input = histIndex === inputHistory.length ? "" : inputHistory[histIndex];
        }
        break;
      case "\x1b": // bare Esc = interrupt
        interrupt();
        break;
      default:
        break;
    }
  }

  function onData(chunk) {
    const s = chunk.toString();
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\x1b") {
        if (s[i + 1] === "[") {
          let end = i + 2;
          while (end < s.length && !(s.charCodeAt(end) >= 0x40 && s.charCodeAt(end) <= 0x7e)) end++;
          const seq = s.slice(i, end + 1);
          handleEscape(seq);
          i = end + 1;
        } else {
          handleEscape("\x1b");
          i += 1;
        }
      } else {
        handleKey(ch);
        i += 1;
      }
    }
    render();
  }

  // Approval answerer: present each permission question as a modal.
  const disposeApproval = ctx.on("approval/request", (req, next) => {
    const toolName = req.toolName ?? "action";
    return new Promise((resolve) => {
      openListModal(`approve ${toolName}?`, [
        { label: "allow once" },
        { label: "reject" },
      ], (idx) => resolve(idx === 0 ? "allowed-once" : "rejected"), {
        onCancel: () => resolve("cancelled"),
        body: req.reason ? [req.reason] : undefined,
        hint: "a tool needs permission · allow/reject",
      });
    });
  });

  // User-question provider: present questions sequentially as modals.
  const userQuestions = ctx.get("userQuestions");
  const disposeQuestions = userQuestions?.registerProvider({
    ask(request) {
      const items = request.questions ?? [];
      const answers = [];
      const askOne = (index) => new Promise((resolve) => {
        if (index >= items.length) return resolve(answers);
        const item = items[index];
        const options = item.options ?? [];
        const body = item.detail ? [item.detail] : undefined;
        openListModal(item.question ?? "choose", options.map((o) => ({ label: o.label, detail: o.description })), (idx) => {
          answers.push({ id: item.id, selected: [options[idx].label] });
          resolve(askOne(index + 1));
        }, { onCancel: () => resolve(null), body, hint: item.header });
      });
      return askOne(0).then((result) => {
        if (result === null) throw new Error("ask_user_question was aborted before the user answered");
        return { answers: result };
      });
    },
  });

  const shortId = (id) => String(id).slice(0, 10);

  // Live orchestration events → transcript notices (subagents + workflows).
  const activityDisposers = [];
  activityDisposers.push(ctx.on("subagent/start", (info) => {
    tr.push({ kind: "notice", message: `⬢ subagent ${info.provider ?? "?"} → ${shortId(info.id)} started` });
    requestRender();
  }));
  activityDisposers.push(ctx.on("subagent/end", (info) => {
    tr.push({ kind: "notice", message: `⬢ subagent ${info.provider ?? "?"} → ${shortId(info.id)} ${info.stopReason ?? "done"}` });
    requestRender();
  }));
  activityDisposers.push(ctx.on("workflow/start", (info) => {
    tr.push({ kind: "notice", message: `▦ workflow ${info.meta?.name ?? shortId(info.id)} started` });
    requestRender();
  }));
  activityDisposers.push(ctx.on("workflow/phase", (_info, title) => {
    tr.push({ kind: "notice", message: `▦ phase — ${title}` });
    requestRender();
  }));
  activityDisposers.push(ctx.on("workflow/end", (info) => {
    tr.push({ kind: "notice", message: `▦ workflow ${info.meta?.name ?? shortId(info.id)} finished` });
    requestRender();
  }));

  const spinnerTimer = setInterval(() => {
    if (tr.busy) {
      spin += 1;
      requestRender();
    }
  }, 80);

  function teardown() {
    clearInterval(spinnerTimer);
    if (typeof disposeEvent === "function") disposeEvent();
    if (typeof disposeApproval === "function") disposeApproval();
    if (typeof disposeQuestions === "function") disposeQuestions();
    for (const d of activityDisposers) if (typeof d === "function") d();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch { /* already restored */ }
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    }
    io.stdout.write("\x1b[?25h\x1b[0m\x1b[?1049l");
  }

  async function finish(code) {
    if (finished) return;
    finished = true;
    teardown();
    io.stdout.write("\n");
    try {
      await ctx.get("sessions")?.flush(agent.session);
    } catch { /* teardown owns the session; the exit code wins */ }
    await io.exit(code);
  }

  // Enter the alternate screen + raw mode.
  io.stdout.write("\x1b[?1049h\x1b[?25l");
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  }
  process.stdout.on("resize", () => requestRender());

  render();
}

// ---------------------------------------------------------------------------
// Non-TTY fallback: styled line-oriented REPL (piped input / scripts).
// ---------------------------------------------------------------------------

async function runPlain(ctx, agent, selection, resumed, io) {
  const tr = createTranscript();
  for (const event of agent.session.events) tr.ingest(event);
  const disposeEvent = ctx.on("session/event", (session, event) => {
    if (session.id !== agent.session.id) return;
    tr.ingest(event);
  });
  const width = io.stdout.columns || 80;

  io.stdout.write(`${theme.bold(theme.fg("accent", "dsh tui"))}${theme.dim(" — DeepSeek Harness terminal chat")}\n`);
  io.stdout.write(`  session : ${agent.session.id}${resumed ? " (resumed)" : ""}\n`);
  io.stdout.write(`  model   : ${selection.provider}/${selection.model}\n`);
  io.stdout.write(theme.dim("  /help for commands") + "\n\n");

  let written = 0;
  const flushItems = () => {
    for (let i = written; i < tr.items.length; i++) {
      for (const line of itemLines(tr.items[i], width)) io.stdout.write(`${line}\n`);
    }
    written = tr.items.length;
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: io.stdout,
    terminal: false,
    prompt: "❯ ",
  });
  let closed = false;
  let busy = false;
  let eofSeen = false;
  const prompt = () => {
    if (!closed && !eofSeen) rl.prompt();
  };

  const finish = async (code) => {
    if (closed) return;
    closed = true;
    if (typeof disposeEvent === "function") disposeEvent();
    try {
      rl.close();
    } catch { /* already closed */ }
    io.stdout.write("\n");
    try {
      await ctx.get("sessions")?.flush(agent.session);
    } catch { /* ignore */ }
    await io.exit(code);
  };

  rl.on("close", () => {
    // Piped stdin reaches EOF while a turn may still be streaming; only finish
    // once the in-flight turn has settled (the loop checks `eofSeen` below).
    eofSeen = true;
    if (!busy) void finish(0);
  });

  flushItems();
  prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (text === "") {
      prompt();
      continue;
    }
    if (text.startsWith("/")) {
      if (text === "/exit" || text === "/quit") {
        await finish(0);
        break;
      }
      if (text === "/help") {
        io.stdout.write("commands:\n  /help    show this help\n  /status  session summary\n  /exit    exit\n");
        prompt();
        continue;
      }
      if (text === "/status") {
        io.stdout.write(`session : ${agent.session.id}\nseq     : ${agent.session.seq}\nmodel   : ${selection.provider}/${selection.model}\ncwd     : ${process.cwd()}\n`);
        prompt();
        continue;
      }
      io.stdout.write(`unknown command: ${text}\n`);
      prompt();
      continue;
    }
    io.stdout.write("\n");
    busy = true;
    agent.followup(createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();
    busy = false;
    flushItems();
    io.stdout.write("\n");
    if (eofSeen) {
      await finish(0);
      break;
    }
    prompt();
  }
  await finish(0);
}

// ---------------------------------------------------------------------------
// Agent creation (mirrors the shipped dsh-headless runner).
// ---------------------------------------------------------------------------

async function createAgent(ctx, start) {
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  if (agents === void 0 || defaultModel === void 0) return void 0;
  let selection = defaultModel.currentSelection();
  if (start.model !== void 0) {
    const [provider, model] = start.model.split("/");
    if (provider === void 0 || model === void 0) {
      throw new Error(`--model expects provider/model, got ${JSON.stringify(start.model)}`);
    }
    selection = { provider, model };
  }
  const agentOptions = { provider: selection.provider, model: selection.model };
  const setup = (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: void 0 });
  };
  if (start.resume !== void 0) {
    const handle = await agents.resume({
      resumeSessionId: SessionId(start.resume),
      agentOptions,
      setup,
    });
    return { handle, selection, resumed: true };
  }
  const handle = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions,
    setup,
  });
  return { handle, selection, resumed: false };
}

/** List persisted sessions through the durable store and exit. */
async function listSessions(ctx, io) {
  const persistence = ctx.get("sessionPersistence");
  if (persistence === void 0) {
    io.stderr.write("dsh: sessionPersistence service is unavailable\n");
    io.exit(1);
    return;
  }
  const headers = await persistence.list();
  headers.sort((a, b) => b.createdAt - a.createdAt);
  for (const header of headers) {
    const when = new Date(header.createdAt).toISOString().replace("T", " ").slice(0, 19);
    io.stdout.write(`${header.id}  ${when}  ${header.cwd ?? ""}\n`);
  }
  io.exit(0);
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
  io.exit(1);
}

/**
 * Mount the interactive terminal front door.
 * @param ctx - plugin context carrying core services and launcher-provided IO.
 */
export function apply(ctx) {
  const exit = ctx.get("appExit");
  if (exit === void 0) {
    throw new Error("tui-frontdoor: the launcher must provide ctx.appExit before the tree mounts");
  }
  const start = ctx.get("tuiStartup");
  if (start === void 0) return; // --help path: nothing was published, tree stays dormant
  const io = { stdout: internals.stdout, stderr: internals.stderr, exit };

  (async () => {
    await ctx.get("loader")?.await();
    if (start.list) {
      await listSessions(ctx, io);
      return;
    }
    const created = await createAgent(ctx, start);
    if (created === void 0) {
      fail(io, new Error("agent services unavailable"));
      return;
    }
    const agent = created.handle.agent;
    await agent.whenIdle();
    if (process.stdin.isTTY && process.stdout.isTTY) {
      runInteractive(ctx, created.handle, created.selection, created.resumed, io);
    } else {
      runPlain(ctx, agent, created.selection, created.resumed, io);
    }
  })().catch((error) => {
    fail(io, error);
  });
}
