/**
 * 落盘层（docs/06 §七）—— state.db 用 Node 内置 node:sqlite（零依赖）。
 *
 * 表语义：
 * - sessions：会话台账（stats 以 JSON 存列）；cli_ref 是执行器侧的原生会话引用
 *   （zcode 的 --resume id / codex 的 thread id），resumeSession 靠它续命。
 * - messages：对话流（user prompt 与 assistant 完整消息），前端重载会话用。
 * - kv：自动化（Phase 5）/ 权限规则（Phase 4）等小状态的通用落点。
 *
 * 轨迹（traces/<date>.jsonl）与用量（usage.jsonl）是 append-only jsonl，
 * 不进 SQLite —— 追加只写语义与 SQLite 事务语义分开，各自最简单。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { log } from "../log.ts";

export interface SessionRow {
  readonly id: string;
  readonly unitId: string;
  readonly runtimeId: string;
  readonly title: string;
  readonly status: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly cliRef: string | null;
  readonly rootPath: string | null;
  readonly stats: {
    messages: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
  };
}

interface StatsJson {
  messages: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

const EMPTY_STATS: StatsJson = { messages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };

export class Store {
  private readonly db: DatabaseSync;

  constructor(homeDir: string) {
    mkdirSync(homeDir, { recursive: true });
    this.db = new DatabaseSync(path.join(homeDir, "state.db"));    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        unit_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        cli_ref TEXT,
        root_path TEXT,
        stats_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        runtime_id TEXT,
        kind TEXT,
        pattern TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );      CREATE TABLE IF NOT EXISTS automations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        unit_id TEXT NOT NULL,
        unit_name TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT,
        mode TEXT,
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        automation_id INTEGER NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pillar TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_pillar ON memory(pillar, id);

      -- 分发日志（docs/10 WP-3）：用户原话与注入内容分列。
      -- 只在**新会话**记一行（冻结快照：续聊不重复注入，就没有新注入可记）。
      -- 不抄会话原文 —— 原文在各自 CLI 的落盘里，这里只存「我们派了什么」。
      CREATE TABLE IF NOT EXISTS dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        user_text TEXT NOT NULL,
        injected_block TEXT NOT NULL,
        injected_chars INTEGER NOT NULL,
        parts_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatches_session ON dispatches(session_id, id);

      -- curator 遥测（docs/10 WP-9）：v1 只埋表不做状态机。
      -- 这些字段**不能后补** —— 没埋就永远算不出「14 天没用过」。
      CREATE TABLE IF NOT EXISTS memory_meta (
        path TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL DEFAULT 0,
        char_used INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at INTEGER,
        state TEXT NOT NULL DEFAULT 'active',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    // 旧库迁移：root_path 是 Phase 3 之后补的列（resume 需要工作目录重建 workspace）
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN root_path TEXT`);
    } catch {
      // 列已存在
    }
    log.info("store opened", { db: path.join(homeDir, "state.db") });
  }

  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, unit_id, runtime_id, title, status, started_at, ended_at, cli_ref, root_path, stats_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status,
           ended_at=excluded.ended_at, cli_ref=excluded.cli_ref, root_path=excluded.root_path, stats_json=excluded.stats_json`,
      )
      .run(
        row.id,
        row.unitId,
        row.runtimeId,
        row.title,
        row.status,
        row.startedAt,
        row.endedAt,
        row.cliRef,
        row.rootPath,
        JSON.stringify(row.stats),
      );
  }

  setSessionCliRef(id: string, cliRef: string): void {
    this.db.prepare(`UPDATE sessions SET cli_ref = ? WHERE id = ?`).run(cliRef, id);
  }

  setSessionStatus(id: string, status: string, endedAt: number | null, stats: StatsJson): void {
    this.db
      .prepare(`UPDATE sessions SET status = ?, ended_at = ?, stats_json = ? WHERE id = ?`)
      .run(status, endedAt, JSON.stringify(stats), id);
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.toRow(row);
  }

  /** 删除一个会话行及其消息（WP-10 孤儿回收的 forget 面）；轨迹文件不动 */
  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  insertMessage(sessionId: string, at: number, role: "user" | "assistant" | "system", text: string): void {
    this.db.prepare(`INSERT INTO messages (session_id, at, role, text) VALUES (?, ?, ?, ?)`).run(sessionId, at, role, text);
  }

  listMessages(sessionId: string, limit = 500): Array<{ at: number; role: string; text: string }> {
    const rows = this.db
      .prepare(`SELECT at, role, text FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => ({ at: Number(r["at"]), role: String(r["role"]), text: String(r["text"]) }));
  }

  kvSet(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  kvGet(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value?: unknown } | undefined;
    return row === undefined ? undefined : String(row["value"]);
  }

  // ---- 权限规则表（Phase 4）-------------------------------------------------

  addPermissionRule(rule: { runtimeId: string | null; kind: string | null; pattern: string; decision: "allow" | "deny" }): number {
    const result = this.db
      .prepare(`INSERT INTO permissions (runtime_id, kind, pattern, decision, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(rule.runtimeId, rule.kind, rule.pattern, rule.decision, Date.now());
    return Number(result.lastInsertRowid);
  }

  listPermissionRules(): Array<{
    id: number;
    runtimeId: string | null;
    kind: string | null;
    pattern: string;
    decision: string;
    createdAt: number;
  }> {
    const rows = this.db.prepare(`SELECT * FROM permissions ORDER BY id DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      runtimeId: r["runtime_id"] === null ? null : String(r["runtime_id"]),
      kind: r["kind"] === null ? null : String(r["kind"]),
      pattern: String(r["pattern"]),
      decision: String(r["decision"]),
      createdAt: Number(r["created_at"]),
    }));
  }

  deletePermissionRule(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM permissions WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  // ---- 自动化（Phase 5）------------------------------------------------------

  createAutomation(a: {
    unitId: string;
    unitName: string;
    runtimeId: string;
    rootPath: string;
    prompt: string;
    model: string | null;
    mode: string | null;
    cron: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO automations (unit_id, unit_name, runtime_id, root_path, prompt, model, mode, cron, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(a.unitId, a.unitName, a.runtimeId, a.rootPath, a.prompt, a.model, a.mode, a.cron, Date.now());
    return Number(result.lastInsertRowid);
  }

  listAutomations(): Array<{
    id: number;
    unitId: string;
    unitName: string;
    runtimeId: string;
    rootPath: string;
    prompt: string;
    model: string | null;
    mode: string | null;
    cron: string;
    enabled: boolean;
    createdAt: number;
  }> {
    const rows = this.db.prepare(`SELECT * FROM automations ORDER BY id DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      unitId: String(r["unit_id"]),
      unitName: String(r["unit_name"]),
      runtimeId: String(r["runtime_id"]),
      rootPath: String(r["root_path"]),
      prompt: String(r["prompt"]),
      model: r["model"] === null ? null : String(r["model"]),
      mode: r["mode"] === null ? null : String(r["mode"]),
      cron: String(r["cron"]),
      enabled: Number(r["enabled"]) === 1,
      createdAt: Number(r["created_at"]),
    }));
  }

  getAutomation(id: number): { automation: ReturnType<Store["listAutomations"]>[number] } | undefined {
    const hit = this.listAutomations().find((a) => a.id === id);
    return hit === undefined ? undefined : { automation: hit };
  }

  setAutomationEnabled(id: number, enabled: boolean): boolean {
    const result = this.db.prepare(`UPDATE automations SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  deleteAutomation(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM automations WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  startAutomationRun(automationId: number, sessionId: string | null): number {
    const result = this.db
      .prepare(`INSERT INTO automation_runs (automation_id, session_id, status, started_at) VALUES (?, ?, 'running', ?)`)
      .run(automationId, sessionId, Date.now());
    return Number(result.lastInsertRowid);
  }

  setAutomationRunSession(runId: number, sessionId: string): void {
    this.db.prepare(`UPDATE automation_runs SET session_id = ? WHERE id = ?`).run(sessionId, runId);
  }

  finishAutomationRun(runId: number, status: "done" | "failed", detail: string | null): void {
    this.db
      .prepare(`UPDATE automation_runs SET status = ?, finished_at = ?, detail = ? WHERE id = ?`)
      .run(status, Date.now(), detail, runId);
  }

  listAutomationRuns(automationId: number, limit = 20): Array<{
    id: number;
    automationId: number;
    sessionId: string | null;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    detail: string | null;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?`)
      .all(automationId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      automationId: Number(r["automation_id"]),
      sessionId: r["session_id"] === null ? null : String(r["session_id"]),
      status: String(r["status"]),
      startedAt: Number(r["started_at"]),
      finishedAt: r["finished_at"] === null ? null : Number(r["finished_at"]),
      detail: r["detail"] === null ? null : String(r["detail"]),
    }));
  }

  // ---- 记忆三柱（Phase 7，sqlite 后端）---------------------------------------

  insertMemory(pillar: string, content: string, source: string | null): number {
    const result = this.db
      .prepare(`INSERT INTO memory (pillar, content, source, created_at) VALUES (?, ?, ?, ?)`)
      .run(pillar, content, source, Date.now());
    return Number(result.lastInsertRowid);
  }

  listMemory(pillar: string, limit = 200): Array<{ id: number; pillar: string; content: string; source: string | null; createdAt: number }> {
    const rows = this.db
      .prepare(`SELECT * FROM memory WHERE pillar = ? ORDER BY id DESC LIMIT ?`)
      .all(pillar, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      pillar: String(r["pillar"]),
      content: String(r["content"]),
      source: r["source"] === null ? null : String(r["source"]),
      createdAt: Number(r["created_at"]),
    }));
  }

  searchMemory(pillar: string, query: string, limit = 10): Array<{ id: number; content: string; source: string | null; createdAt: number }> {
    // sqlite 端的检索就是 LIKE 兜底（语义检索是 WeKnora 的事；sqlite 后端保"永远可用"）
    const rows = this.db
      .prepare(`SELECT * FROM memory WHERE pillar = ? AND content LIKE ? ORDER BY id DESC LIMIT ?`)
      .all(pillar, `%${query}%`, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      content: String(r["content"]),
      source: r["source"] === null ? null : String(r["source"]),
      createdAt: Number(r["created_at"]),
    }));
  }

  // ---- 分发日志（docs/10 WP-3）------------------------------------------------
  insertDispatch(input: {
    sessionId: string;
    runtimeId: string;
    rootPath: string;
    userText: string;
    injectedBlock: string;
    injectedChars: number;
    parts: ReadonlyArray<{ scope: string; sourcePath: string; chars: number }>;
    createdAt: number;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO dispatches
         (session_id, runtime_id, root_path, user_text, injected_block, injected_chars, parts_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.runtimeId,
        input.rootPath,
        input.userText,
        input.injectedBlock,
        input.injectedChars,
        JSON.stringify(input.parts),
        input.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  listDispatches(sessionId: string): Array<{
    id: number;
    runtimeId: string;
    rootPath: string;
    userText: string;
    injectedBlock: string;
    injectedChars: number;
    parts: Array<{ scope: string; sourcePath: string; chars: number }>;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM dispatches WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      let parts: Array<{ scope: string; sourcePath: string; chars: number }> = [];
      try {
        parts = JSON.parse(String(r["parts_json"] ?? "[]")) as typeof parts;
      } catch {
        // 坏 parts 不该让整条日志读不出来
      }
      return {
        id: Number(r["id"]),
        runtimeId: String(r["runtime_id"]),
        rootPath: String(r["root_path"]),
        userText: String(r["user_text"]),
        injectedBlock: String(r["injected_block"]),
        injectedChars: Number(r["injected_chars"]),
        parts,
        createdAt: Number(r["created_at"]),
      };
    });
  }

  // ---- curator 遥测（docs/10 WP-9）--------------------------------------------

  listMemoryMeta(prefix?: string): Array<{
    path: string; bytes: number; charUsed: number; useCount: number;
    lastUsedAt: number | null; hitCount: number; lastHitAt: number | null;
    state: string; pinned: boolean; createdAt: number;
  }> {
    // 不用 `LIKE '${prefix}%'`：`_` 和 `%` 在 LIKE 里是通配符，
    // 而 Windows 用户目录带下划线极常见（my_project / agent_workbench）——
    // 会把**别的项目**的遥测也捞进来，curator 的项目隔离就破了。
    // `substr(path,1,?)=?` 是纯字符串前缀比较，没有通配符语义。
    const rows = (
      prefix === undefined
        ? this.db.prepare(`SELECT * FROM memory_meta ORDER BY path`).all()
        : this.db.prepare(`SELECT * FROM memory_meta WHERE substr(path, 1, ?) = ? ORDER BY path`).all(prefix.length, prefix)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      path: String(r["path"]),
      bytes: Number(r["bytes"]),
      charUsed: Number(r["char_used"]),
      useCount: Number(r["use_count"]),
      lastUsedAt: r["last_used_at"] === null ? null : Number(r["last_used_at"]),
      hitCount: Number(r["hit_count"]),
      lastHitAt: r["last_hit_at"] === null ? null : Number(r["last_hit_at"]),
      state: String(r["state"]),
      pinned: Number(r["pinned"]) === 1,
      createdAt: Number(r["created_at"]),
    }));
  }

  upsertMemoryMeta(m: {
    path: string; bytes: number; charUsed: number; useCount: number;
    lastUsedAt: number | null; hitCount: number; lastHitAt: number | null;
    state: string; pinned: boolean; createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_meta
         (path, bytes, char_used, use_count, last_used_at, hit_count, last_hit_at, state, pinned, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           bytes=excluded.bytes, char_used=excluded.char_used,
           use_count=excluded.use_count, last_used_at=excluded.last_used_at,
           hit_count=excluded.hit_count, last_hit_at=excluded.last_hit_at,
           state=excluded.state, pinned=excluded.pinned`,
      )
      .run(
        m.path, m.bytes, m.charUsed, m.useCount, m.lastUsedAt,
        m.hitCount, m.lastHitAt, m.state, m.pinned ? 1 : 0, m.createdAt,
      );
  }

  /** 记一次「被注入过」—— curator 判断「多久没用了」的唯一依据 */
  markMemoryUsed(path: string, at: number, charUsed: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_meta (path, bytes, char_used, use_count, last_used_at, state, pinned, created_at)
         VALUES (?, ?, ?, 1, ?, 'active', 0, ?)
         ON CONFLICT(path) DO UPDATE SET
           use_count = use_count + 1, last_used_at = excluded.last_used_at, char_used = excluded.char_used`,
      )
      .run(path, charUsed, charUsed, at, at);
  }

  private toRow(r: Record<string, unknown>): SessionRow {
    let stats: StatsJson = EMPTY_STATS;
    try {
      stats = { ...EMPTY_STATS, ...(JSON.parse(String(r["stats_json"] ?? "{}")) as Partial<StatsJson>) };
    } catch {
      // 坏行按空 stats 处理，不掀翻 listSessions
    }
    return {
      id: String(r["id"]),
      unitId: String(r["unit_id"]),
      runtimeId: String(r["runtime_id"]),
      title: String(r["title"]),
      status: String(r["status"]),
      startedAt: Number(r["started_at"]),
      endedAt: r["ended_at"] === null || r["ended_at"] === undefined ? null : Number(r["ended_at"]),
      cliRef: r["cli_ref"] === null || r["cli_ref"] === undefined ? null : String(r["cli_ref"]),
      rootPath: r["root_path"] === null || r["root_path"] === undefined ? null : String(r["root_path"]),
      stats,
    };
  }

  close(): void {
    this.db.close();
  }
}
