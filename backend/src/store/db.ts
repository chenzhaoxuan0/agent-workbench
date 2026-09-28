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
    this.db = new DatabaseSync(path.join(homeDir, "state.db"));
    this.db.exec(`
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
      );
    `);
    log.info("store opened", { db: path.join(homeDir, "state.db") });
  }

  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, unit_id, runtime_id, title, status, started_at, ended_at, cli_ref, stats_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status,
           ended_at=excluded.ended_at, cli_ref=excluded.cli_ref, stats_json=excluded.stats_json`,
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
      stats,
    };
  }

  close(): void {
    this.db.close();
  }
}
