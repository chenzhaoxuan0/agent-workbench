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
import type { ScheduleRule } from "../../../prototype/src/core/automation.ts";
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

/** backlog_items 行的读取形态（心跳引擎与 RPC 层共用） */
export interface BacklogRow {
  id: number;
  title: string;
  goal: string;
  prompt: string;
  unitId: string;
  unitName: string;
  rootPath: string;
  runtimeId: string;
  model: string | null;
  mode: string | null;
  size: string | null;
  /** 执行方式：terminal = 前端 TUI（缺省）；headless = 纯后台 host 会话 */
  launchMode: "terminal" | "headless";
  status: string;
  ignoreCount: number;
  lastProposedAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  reviewNote: string | null;
  source: string;
  sortPos: number;
  createdAt: number;
  updatedAt: number;
}

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
      -- 待办 / GTD（ADR-0001：独立建表，不复用 automations —— 待办的状态机
      -- 多出确认门 / 验收 / 休眠计数，塞同一张表两边都拧巴）。
      -- 状态机全落 DB：awaiting_confirm / executing 等中间态必须跨重启。
      CREATE TABLE IF NOT EXISTS backlog_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        prompt TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        unit_name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        runtime_id TEXT NOT NULL DEFAULT '',
        model TEXT,
        mode TEXT,
        size TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        ignore_count INTEGER NOT NULL DEFAULT 0,
        last_proposed_at INTEGER,
        last_run_at INTEGER,
        last_error TEXT,
        review_note TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        sort_pos REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backlog_items_status ON backlog_items(status, sort_pos);
      -- 待办运行记录（复用执行链路、不复用 automation_runs 表：那边 automation_id
      -- NOT NULL 挂着定时任务行，硬塞会互相污染）
      CREATE TABLE IF NOT EXISTS backlog_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        session_id TEXT,
        runtime_id TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'gtd',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_backlog_runs_item ON backlog_runs(item_id, id);

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
    // 自动化 v2（对齐 ZCode 的调度状态机）：
    // 「下次何时跑」是持久化事实（next_run_at），scheduler 只认 DB 不靠内存推算，
    // daemon 重启 / 崩溃不丢拍；recurring/max_runs/run_count 收口一次性与有限次任务；
    // last_error 撑卡片的失败徽章。
    for (const stmt of [
      `ALTER TABLE automations ADD COLUMN name TEXT`,
      `ALTER TABLE automations ADD COLUMN schedule_rule TEXT`,
      `ALTER TABLE automations ADD COLUMN recurring INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE automations ADD COLUMN max_runs INTEGER`,
      `ALTER TABLE automations ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE automations ADD COLUMN next_run_at INTEGER`,
      `ALTER TABLE automations ADD COLUMN last_run_at INTEGER`,
      `ALTER TABLE automations ADD COLUMN last_error TEXT`,
      `ALTER TABLE automations ADD COLUMN last_error_at INTEGER`,
      `ALTER TABLE automation_runs ADD COLUMN trigger TEXT`,
      // 执行方式：terminal = 到点在前端 PTY 里拉起执行器 TUI（人可看可插手），
      // headless = 原有 host 会话。旧行 NULL 按 terminal 读（新默认）。
      `ALTER TABLE automations ADD COLUMN launch_mode TEXT`,
      // 待办同款：terminal = 前端 TUI（缺省）；headless = 纯后台
      `ALTER TABLE backlog_items ADD COLUMN launch_mode TEXT`,
    ]) {
      try {
        this.db.exec(stmt);
      } catch {
        // 列已存在
      }
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
    // 分发日志同属这条会话：不删就永远留在库里，而 memory.dispatches 还能
    // 把「已经 forget 掉」的会话日志原样查回来
    this.db.prepare(`DELETE FROM dispatches WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  /** 最后一条消息的时间戳（0 = 一条都没有）。curator 的 idle 闸要用真实的对话活动 */
  latestMessageAt(): number {
    const row = this.db.prepare(`SELECT max(at) AS at FROM messages`).get() as { at?: number | null } | undefined;
    return Number(row?.at ?? 0);
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

  // ---- 自动化（Phase 5，v2 调度状态机）---------------------------------------

  /** automations 行的读取形态。scheduleRule 为调度权威（共享引擎的规则对象）。 */
  automationRow(r: Record<string, unknown>): ReturnType<Store["listAutomations"]>[number] {
    let rule: ScheduleRule | null = null;
    const raw = r["schedule_rule"];
    if (typeof raw === "string" && raw !== "") {
      try {
        rule = JSON.parse(raw) as ScheduleRule;
      } catch {
        rule = null; // 坏 JSON 按纯 cron 处理，不让一行脏数据掀掉整个列表
      }
    }
    const unitName = String(r["unit_name"]);
    return {
      id: Number(r["id"]),
      unitId: String(r["unit_id"]),
      unitName,
      name: r["name"] === null || r["name"] === undefined ? unitName : String(r["name"]),
      runtimeId: String(r["runtime_id"]),
      rootPath: String(r["root_path"]),
      prompt: String(r["prompt"]),
      model: r["model"] === null ? null : String(r["model"]),
      mode: r["mode"] === null ? null : String(r["mode"]),
      cron: String(r["cron"]),
      scheduleRule: rule,
      recurring: Number(r["recurring"] ?? 1) === 1,
      maxRuns: r["max_runs"] === null || r["max_runs"] === undefined ? null : Number(r["max_runs"]),
      runCount: Number(r["run_count"] ?? 0),
      enabled: Number(r["enabled"]) === 1,
      nextRunAt: r["next_run_at"] === null || r["next_run_at"] === undefined ? null : Number(r["next_run_at"]),
      lastRunAt: r["last_run_at"] === null || r["last_run_at"] === undefined ? null : Number(r["last_run_at"]),
      lastError: r["last_error"] === null || r["last_error"] === undefined ? null : String(r["last_error"]),
      lastErrorAt: r["last_error_at"] === null || r["last_error_at"] === undefined ? null : Number(r["last_error_at"]),
      launchMode: r["launch_mode"] === "headless" ? "headless" : "terminal",
      createdAt: Number(r["created_at"]),
    };
  }

  createAutomation(a: {
    unitId: string;
    unitName: string;
    name: string;
    runtimeId: string;
    rootPath: string;
    prompt: string;
    model: string | null;
    mode: string | null;
    cron: string;
    scheduleRule: ScheduleRule | null;
    recurring: boolean;
    maxRuns: number | null;
    nextRunAt: number | null;
    launchMode: "terminal" | "headless";
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO automations (unit_id, unit_name, name, runtime_id, root_path, prompt, model, mode, cron,
           schedule_rule, recurring, max_runs, run_count, next_run_at, enabled, created_at, launch_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
      )
      .run(
        a.unitId,
        a.unitName,
        a.name,
        a.runtimeId,
        a.rootPath,
        a.prompt,
        a.model,
        a.mode,
        a.cron,
        a.scheduleRule === null ? null : JSON.stringify(a.scheduleRule),
        a.recurring ? 1 : 0,
        a.maxRuns,
        a.nextRunAt,
        Date.now(),
        a.launchMode,
      );
    return Number(result.lastInsertRowid);
  }

  listAutomations(): Array<{
    id: number;
    unitId: string;
    unitName: string;
    name: string;
    runtimeId: string;
    rootPath: string;
    prompt: string;
    model: string | null;
    mode: string | null;
    cron: string;
    scheduleRule: ScheduleRule | null;
    recurring: boolean;
    maxRuns: number | null;
    runCount: number;
    enabled: boolean;
    nextRunAt: number | null;
    lastRunAt: number | null;
    lastError: string | null;
    lastErrorAt: number | null;
    launchMode: "terminal" | "headless";
    createdAt: number;
  }> {
    const rows = this.db.prepare(`SELECT * FROM automations ORDER BY id DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.automationRow(r));
  }

  getAutomation(id: number): { automation: ReturnType<Store["listAutomations"]>[number] } | undefined {
    const hit = this.listAutomations().find((a) => a.id === id);
    return hit === undefined ? undefined : { automation: hit };
  }

  /**
   * 局部更新。只写传入的字段（undefined = 不动），调度字段变化后由调用方
   * 负责把 nextRunAt 一起算好传进来 —— store 不懂调度语义。
   */
  updateAutomation(
    id: number,
    patch: Partial<{
      name: string;
      unitId: string;
      unitName: string;
      runtimeId: string;
      rootPath: string;
      prompt: string;
      model: string | null;
      mode: string | null;
      cron: string;
      scheduleRule: ScheduleRule | null;
      recurring: boolean;
      maxRuns: number | null;
      enabled: boolean;
      nextRunAt: number | null;
      lastRunAt: number | null;
      launchMode: "terminal" | "headless";
    }>,
  ): boolean {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const put = (col: string, v: string | number | boolean | null): void => {
      sets.push(`${col} = ?`);
      if (typeof v === "boolean") values.push(v ? 1 : 0);
      else values.push(v);
    };
    if (patch.name !== undefined) put("name", patch.name);
    if (patch.unitId !== undefined) put("unit_id", patch.unitId);
    if (patch.unitName !== undefined) put("unit_name", patch.unitName);
    if (patch.runtimeId !== undefined) put("runtime_id", patch.runtimeId);
    if (patch.rootPath !== undefined) put("root_path", patch.rootPath);
    if (patch.prompt !== undefined) put("prompt", patch.prompt);
    if (patch.model !== undefined) put("model", patch.model);
    if (patch.mode !== undefined) put("mode", patch.mode);
    if (patch.cron !== undefined) put("cron", patch.cron);
    if (patch.scheduleRule !== undefined) put("schedule_rule", patch.scheduleRule === null ? null : JSON.stringify(patch.scheduleRule));
    if (patch.recurring !== undefined) put("recurring", patch.recurring);
    if (patch.maxRuns !== undefined) put("max_runs", patch.maxRuns);
    if (patch.enabled !== undefined) put("enabled", patch.enabled);
    if (patch.nextRunAt !== undefined) put("next_run_at", patch.nextRunAt);
    if (patch.lastRunAt !== undefined) put("last_run_at", patch.lastRunAt);
    if (patch.launchMode !== undefined) put("launch_mode", patch.launchMode);
    if (sets.length === 0) return true;
    values.push(id);
    const result = this.db.prepare(`UPDATE automations SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return Number(result.changes) > 0;
  }

  /**
   * 发火结算（认领）：next_run_at 先行前推 + run_count+1，之后再异步派发 ——
   * 两帧 tick 之间不会对同一次触发重复发火（single-flight 靠 DB 前推，不靠内存锁）。
   * terminal=true 同时停用（一次性/有限次任务跑完，对齐 ZCode 的 completed 收口）。
   */
  markAutomationFired(id: number, nextRunAt: number | null, lastRunAt: number, terminal: boolean): boolean {
    const result = this.db
      .prepare(
        `UPDATE automations SET next_run_at = ?, last_run_at = ?, run_count = run_count + 1,
           enabled = CASE WHEN ? THEN 0 ELSE enabled END WHERE id = ?`,
      )
      .run(nextRunAt, lastRunAt, terminal ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  /** 失败徽章：message=null 表示清除（下次成功发火时调用） */
  setAutomationError(id: number, message: string | null, at: number | null): void {
    this.db.prepare(`UPDATE automations SET last_error = ?, last_error_at = ? WHERE id = ?`).run(message, at, id);
  }

  setAutomationEnabled(id: number, enabled: boolean): boolean {
    const result = this.db.prepare(`UPDATE automations SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  deleteAutomation(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM automations WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  startAutomationRun(automationId: number, sessionId: string | null, trigger: "schedule" | "manual" = "schedule"): number {
    const result = this.db
      .prepare(`INSERT INTO automation_runs (automation_id, session_id, status, trigger, started_at) VALUES (?, ?, 'running', ?, ?)`)
      .run(automationId, sessionId, trigger, Date.now());
    return Number(result.lastInsertRowid);
  }

  /** 错过窗口的记账：不派发，只留痕 + 由调用方推进 next_run_at（misfire 不补跑口径） */
  recordSkippedAutomationRun(automationId: number, scheduledAt: number, reason: string): number {
    const result = this.db
      .prepare(`INSERT INTO automation_runs (automation_id, session_id, status, trigger, started_at, finished_at, detail)
                VALUES (?, NULL, 'skipped', 'schedule', ?, ?, ?)`)
      .run(automationId, scheduledAt, Date.now(), reason);
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
    trigger: string;
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
      trigger: r["trigger"] === null || r["trigger"] === undefined ? "schedule" : String(r["trigger"]),
      startedAt: Number(r["started_at"]),
      finishedAt: r["finished_at"] === null ? null : Number(r["finished_at"]),
      detail: r["detail"] === null ? null : String(r["detail"]),
    }));
  }

  // ---- 待办 / GTD（backlog）----------------------------------------------------

  private backlogRow(r: Record<string, unknown>): BacklogRow {
    const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return {
      id: Number(r["id"]),
      title: String(r["title"]),
      goal: String(r["goal"]),
      prompt: String(r["prompt"]),
      unitId: String(r["unit_id"]),
      unitName: String(r["unit_name"]),
      rootPath: String(r["root_path"]),
      runtimeId: String(r["runtime_id"] ?? ""),
      model: r["model"] === null || r["model"] === undefined ? null : String(r["model"]),
      mode: r["mode"] === null || r["mode"] === undefined ? null : String(r["mode"]),
      size: r["size"] === null || r["size"] === undefined ? null : String(r["size"]),
      launchMode: r["launch_mode"] === "headless" ? "headless" : "terminal",
      status: String(r["status"]),
      ignoreCount: Number(r["ignore_count"] ?? 0),
      lastProposedAt: nOrNull(r["last_proposed_at"]),
      lastRunAt: nOrNull(r["last_run_at"]),
      lastError: r["last_error"] === null || r["last_error"] === undefined ? null : String(r["last_error"]),
      reviewNote: r["review_note"] === null || r["review_note"] === undefined ? null : String(r["review_note"]),
      source: String(r["source"] ?? "manual"),
      sortPos: Number(r["sort_pos"] ?? 0),
      createdAt: Number(r["created_at"]),
      updatedAt: Number(r["updated_at"]),
    };
  }

  createBacklogItem(a: {
    title: string;
    goal: string;
    prompt: string;
    unitId: string;
    unitName: string;
    rootPath: string;
    runtimeId?: string;
    model?: string | null;
    mode?: string | null;
    size?: string | null;
    launchMode?: "terminal" | "headless";
    source?: "manual" | "inbox";
    sortPos?: number;
  }): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO backlog_items (title, goal, prompt, unit_id, unit_name, root_path, runtime_id, model, mode,
           size, launch_mode, status, ignore_count, source, sort_pos, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0, ?, ?, ?, ?)`,
      )
      .run(
        a.title,
        a.goal,
        a.prompt,
        a.unitId,
        a.unitName,
        a.rootPath,
        a.runtimeId ?? "",
        a.model ?? null,
        a.mode ?? null,
        a.size ?? null,
        a.launchMode ?? "terminal",
        a.source ?? "manual",
        a.sortPos ?? now,
        now,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  listBacklogItems(): BacklogRow[] {
    // done 的沉底按时间排，活跃的按手动排序位（顺序即优先级）
    const rows = this.db
      .prepare(`SELECT * FROM backlog_items ORDER BY status = 'done', sort_pos, id DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.backlogRow(r));
  }

  getBacklogItem(id: number): BacklogRow | undefined {
    const row = this.db.prepare(`SELECT * FROM backlog_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.backlogRow(row);
  }

  /** 局部更新（undefined = 不动）。状态迁移由调用方负责合法性，store 只管落盘。 */
  updateBacklogItem(
    id: number,
    patch: Partial<{
      title: string;
      goal: string;
      prompt: string;
      unitId: string;
      unitName: string;
      rootPath: string;
      runtimeId: string;
      model: string | null;
      mode: string | null;
      size: string | null;
      launchMode: "terminal" | "headless";
      status: string;
      ignoreCount: number;
      lastProposedAt: number | null;
      lastRunAt: number | null;
      lastError: string | null;
      reviewNote: string | null;
      sortPos: number;
    }>,
  ): boolean {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const put = (col: string, v: string | number | null): void => {
      sets.push(`${col} = ?`);
      values.push(v);
    };
    if (patch.title !== undefined) put("title", patch.title);
    if (patch.goal !== undefined) put("goal", patch.goal);
    if (patch.prompt !== undefined) put("prompt", patch.prompt);
    if (patch.unitId !== undefined) put("unit_id", patch.unitId);
    if (patch.unitName !== undefined) put("unit_name", patch.unitName);
    if (patch.rootPath !== undefined) put("root_path", patch.rootPath);
    if (patch.runtimeId !== undefined) put("runtime_id", patch.runtimeId);
    if (patch.model !== undefined) put("model", patch.model);
    if (patch.mode !== undefined) put("mode", patch.mode);
    if (patch.size !== undefined) put("size", patch.size);
    if (patch.launchMode !== undefined) put("launch_mode", patch.launchMode);
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.ignoreCount !== undefined) put("ignore_count", patch.ignoreCount);
    if (patch.lastProposedAt !== undefined) put("last_proposed_at", patch.lastProposedAt);
    if (patch.lastRunAt !== undefined) put("last_run_at", patch.lastRunAt);
    if (patch.lastError !== undefined) put("last_error", patch.lastError);
    if (patch.reviewNote !== undefined) put("review_note", patch.reviewNote);
    if (patch.sortPos !== undefined) put("sort_pos", patch.sortPos);
    if (sets.length === 0) return true;
    sets.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    const result = this.db.prepare(`UPDATE backlog_items SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return Number(result.changes) > 0;
  }

  deleteBacklogItem(id: number): boolean {
    this.db.prepare(`DELETE FROM backlog_runs WHERE item_id = ?`).run(id);
    const result = this.db.prepare(`DELETE FROM backlog_items WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  startBacklogRun(itemId: number, sessionId: string | null, runtimeId: string, trigger: "gtd" | "manual" = "gtd"): number {
    const result = this.db
      .prepare(`INSERT INTO backlog_runs (item_id, session_id, runtime_id, status, trigger, started_at) VALUES (?, ?, ?, 'running', ?, ?)`)
      .run(itemId, sessionId, runtimeId, trigger, Date.now());
    return Number(result.lastInsertRowid);
  }

  setBacklogRunSession(runId: number, sessionId: string): void {
    this.db.prepare(`UPDATE backlog_runs SET session_id = ? WHERE id = ?`).run(sessionId, runId);
  }

  finishBacklogRun(runId: number, status: "done" | "failed", detail: string | null): void {
    this.db.prepare(`UPDATE backlog_runs SET status = ?, finished_at = ?, detail = ? WHERE id = ?`).run(status, Date.now(), detail, runId);
  }

  listBacklogRuns(itemId: number, limit = 10): Array<{
    id: number;
    itemId: number;
    sessionId: string | null;
    runtimeId: string;
    status: string;
    trigger: string;
    startedAt: number;
    finishedAt: number | null;
    detail: string | null;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM backlog_runs WHERE item_id = ? ORDER BY id DESC LIMIT ?`)
      .all(itemId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      itemId: Number(r["item_id"]),
      sessionId: r["session_id"] === null || r["session_id"] === undefined ? null : String(r["session_id"]),
      runtimeId: String(r["runtime_id"]),
      status: String(r["status"]),
      trigger: String(r["trigger"] ?? "gtd"),
      startedAt: Number(r["started_at"]),
      finishedAt: r["finished_at"] === null || r["finished_at"] === undefined ? null : Number(r["finished_at"]),
      detail: r["detail"] === null || r["detail"] === undefined ? null : String(r["detail"]),
    }));
  }

  /** 最近的运行引用（卡片与执行中判定共用） */
  latestBacklogRun(itemId: number): ReturnType<Store["listBacklogRuns"]>[number] | undefined {
    return this.listBacklogRuns(itemId, 1)[0];
  }

  /** 仍未收口的运行（重启自愈用）：status=running 的全量 */
  listRunningBacklogRuns(): Array<{ runId: number; itemId: number; sessionId: string | null; runtimeId: string; startedAt: number }> {
    const rows = this.db
      .prepare(`SELECT id, item_id, session_id, runtime_id, started_at FROM backlog_runs WHERE status = 'running'`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      runId: Number(r["id"]),
      itemId: Number(r["item_id"]),
      sessionId: r["session_id"] === null || r["session_id"] === undefined ? null : String(r["session_id"]),
      runtimeId: String(r["runtime_id"]),
      startedAt: Number(r["started_at"]),
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
    // ⚠ 用户查询里的 `%` / `_` 必须转义：不转义时搜 "_" 或 "%" 会命中**所有**行
    // （LIKE 里它们是通配符），看起来像「检索坏了」。
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db
      .prepare(`SELECT * FROM memory WHERE pillar = ? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`)
      .all(pillar, `%${escaped}%`, limit) as Array<Record<string, unknown>>;
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
    //
    // ⚠ 但纯前缀仍然会串到「同名前缀的兄弟目录」：prefix=`C:/work/my_project` 时
    // `C:/work/my_project2/MEMORY.md` 也算命中。前缀必须带路径分隔符
    // （两种斜杠都试，库里的路径写法不保证统一），目录自身用精确相等兜一条。
    const base = prefix === undefined ? undefined : prefix.replace(/[\\/]+$/, "");
    const rows = (
      prefix === undefined
        ? this.db.prepare(`SELECT * FROM memory_meta ORDER BY path`).all()
        : this.db
            .prepare(
              `SELECT * FROM memory_meta
               WHERE path = ? OR substr(path, 1, ?) = ? OR substr(path, 1, ?) = ?
               ORDER BY path`,
            )
            .all(
              prefix,
              base!.length + 1, `${base!}/`,
              base!.length + 1, `${base!}\\`,
            )
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
        // ⚠ bytes 以前也绑 charUsed —— 字符数被当成字节数写进库，memory.telemetry
        // 从此永久显示一个错的体积（ON CONFLICT 分支不刷新 bytes，只有 curator
        // 钉选时才会被 upsertMemoryMeta 纠正）。这里没有真实字节数就写 0：
        // 「不知道」比「记一个错的」好。
        `INSERT INTO memory_meta (path, bytes, char_used, use_count, last_used_at, state, pinned, created_at)
         VALUES (?, 0, ?, 1, ?, 'active', 0, ?)
         ON CONFLICT(path) DO UPDATE SET
           use_count = use_count + 1, last_used_at = excluded.last_used_at, char_used = excluded.char_used`,
      )
      .run(path, charUsed, at, at);
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
