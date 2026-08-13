/**
 * Host-service accessors for the dsh TUI front door.
 *
 * The TUI is a terminal client over `dsh-base`; it reads the same Cordis
 * services the web client consumes (via Typert RPC), but in-process through
 * `ctx.get`. Every accessor is defensive: a service that a deployment did not
 * mount resolves to `undefined` and its accessor returns an empty/undefined
 * value instead of throwing, so one missing host row cannot take the UI down.
 * @module dsh-tui/host
 */

/** Build the host accessor set around one plugin context. */
export function createHost(ctx) {
  const get = (name) => ctx.get(name);

  return {
    /** Read any Cordis service by key, or undefined when absent. */
    get,

    // ── sessions / workspaces ────────────────────────────────────────────────
    /** Durable session records, newest first, each with a resolved title. */
    async listSessions() {
      const query = get("sessionQuery");
      if (query === void 0) return [];
      const records = await query.listSessions();
      const ids = records.map((record) => record.header.id);
      let byId = new Map();
      try {
        const titles = await query.readTitleSnapshots(ids);
        for (const entry of titles) {
          if (entry.status === "fulfilled" && entry.value.title) {
            byId.set(entry.sessionId, entry.value.title.title);
          }
        }
      } catch { /* titles are best-effort */ }
      return records
        .map((record) => ({
          id: record.header.id,
          cwd: record.header.cwd,
          createdAt: record.header.createdAt,
          live: record.live,
          title: byId.get(record.header.id) ?? record.header.cwd ?? record.header.id,
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    /** Registered workspaces (id → { id, path, title }). */
    listWorkspaces() {
      const registry = get("workspaceRegistry");
      if (registry === void 0) return [];
      return registry.list().map((ws) => ({ id: ws.id, path: ws.path, title: ws.title }));
    },

    // ── models ───────────────────────────────────────────────────────────────
    listProviders() {
      const llm = get("llm");
      return llm === void 0 ? [] : llm.listProviders();
    },

    async listModels(provider) {
      const llm = get("llm");
      if (llm === void 0) return [];
      return llm.listModels(provider);
    },

    async saveSelection(selection) {
      const defaultModel = get("agentDefaultModel");
      if (defaultModel === void 0) return;
      await defaultModel.saveSelection?.(selection);
    },

    // ── goal / plan ──────────────────────────────────────────────────────────
    goal(agent) {
      return get("goals")?.get(agent);
    },

    planMode(agent) {
      return get("planMode")?.get(agent);
    },

    setPlanMode(agent, active) {
      return get("planMode")?.set(agent, active);
    },

    // ── jobs ─────────────────────────────────────────────────────────────────
    listJobs(agent) {
      return get("jobs")?.list(agent) ?? [];
    },

    killJob(id, agent) {
      return get("jobs")?.kill(id, agent);
    },

    // ── subagents ────────────────────────────────────────────────────────────
    async listSubagentChildren(parentSessionId) {
      const subagents = get("subagents");
      if (subagents === void 0) return [];
      return subagents.listChildren(parentSessionId);
    },

    async listSubagentDescendants(rootSessionId) {
      const subagents = get("subagents");
      if (subagents === void 0) return [];
      return subagents.listDescendants(rootSessionId);
    },

    // ── skills / commands ────────────────────────────────────────────────────
    async listSkills() {
      const skills = get("skills");
      if (skills === void 0) return [];
      return skills.list();
    },

    findCommand(agent, name) {
      const commands = get("commands");
      if (commands === void 0) return undefined;
      return commands.find(agent, name);
    },

    // ── settings ─────────────────────────────────────────────────────────────
    settingsDescribe() {
      return get("settings")?.describe() ?? [];
    },

    settingsGet(ns) {
      return get("settings")?.get(ns);
    },
  };
}
