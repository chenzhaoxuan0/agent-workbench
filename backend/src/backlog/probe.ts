/**
 * 余量探针 —— 订阅执行器当前窗口可用量的实时读数（共识 Q16：CLI 直查优先）。
 *
 * 数据源两级：
 * 1. probe（权威）：执行用户配置的配额命令（实测样例——
 *    zcode quota：文本面板，`TOKENS_LIMIT  remaining 94%  resets 2026-10-12 15:09 (in 2h 41m)`
 *    mmx quota show --output json：model_remains[] 含窗口剩余百分比与 end_time 毫秒时间戳）
 * 2. ledger（兜底）：无探针命令时按本地 usage.jsonl 滚动窗口聚合请求数，
 *    对比自配上限估算。口径偏乐观（只统计经过工作台的会话），UI 必须标注口径。
 *
 * 读数 TTL 缓存 5 分钟 + 并发去重：心跳 30 分钟一跳、弹窗打开时刷新，
 * 不该每次都真起一个子进程。
 */

import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProbeFormat, QuotaHeadroom, RuntimeQuotaConfig } from "../../../prototype/src/core/backlog.ts";
import { log } from "../log.ts";

const PROBE_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 5 * 60_000;

function execShell(cmd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 512, encoding: "utf8" },
      (err, stdout, stderr) => resolve({ ok: err === null, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") }),
    );
  });
}

/** zcode quota 文本面板 → 5h 窗（TOKENS_LIMIT 行）剩余 + 长周期（TIME_LIMIT 行）摘要 */
function parseZcodeQuota(text: string): { percent: number | null; resetsAt: number | null; summary: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const tokenLine = lines.find((l) => l.startsWith("TOKENS_LIMIT"));
  const timeLine = lines.find((l) => l.startsWith("TIME_LIMIT"));
  const parts: string[] = [];
  let percent: number | null = null;
  let resetsAt: number | null = null;
  if (tokenLine !== undefined) {
    parts.push(tokenLine);
    const pct = /remaining\s+(\d+)%/.exec(tokenLine);
    if (pct !== null) percent = Number(pct[1]);
    // `resets 2026-10-12 15:09` 是本地时间；Date 认不了空格分隔，换 T
    const reset = /resets\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/.exec(tokenLine);
    if (reset !== null) {
      const t = Date.parse(`${reset[1]}T${reset[2]}`);
      if (Number.isFinite(t)) resetsAt = t;
    }
  }
  if (timeLine !== undefined) parts.push(timeLine);
  return { percent, resetsAt, summary: parts.join(" · ") || text.trim().slice(0, 120) };
}

/** mmx quota --output json → 首个模型的 5h 窗剩余 + 周限摘要 */
function parseMmxJson(text: string): { percent: number | null; resetsAt: number | null; summary: string } {
  interface MmxEntry {
    current_interval_remaining_percent?: number;
    current_interval_end?: number;
    end_time?: number;
    current_weekly_remaining_percent?: number;
  }
  let first: MmxEntry | undefined;
  try {
    const j = JSON.parse(text) as { model_remains?: MmxEntry[] };
    first = j.model_remains?.[0];
  } catch {
    return { percent: null, resetsAt: null, summary: text.trim().slice(0, 120) };
  }
  if (first === undefined) return { percent: null, resetsAt: null, summary: "mmx 输出里没有 model_remains" };
  const percent = typeof first.current_interval_remaining_percent === "number" ? first.current_interval_remaining_percent : null;
  const resetsAt = typeof first.end_time === "number" ? first.end_time : null;
  const weekly = typeof first.current_weekly_remaining_percent === "number" ? ` · 周限 ${first.current_weekly_remaining_percent}%` : "";
  return { percent, resetsAt, summary: `窗口 ${percent ?? "?"}%${weekly}` };
}

function parseProbe(format: ProbeFormat, stdout: string): { percent: number | null; resetsAt: number | null; summary: string } {
  switch (format) {
    case "zcode-quota":
      return parseZcodeQuota(stdout);
    case "mmx-json":
      return parseMmxJson(stdout);
    default:
      return { percent: null, resetsAt: null, summary: stdout.trim().split(/\r?\n/).slice(0, 3).join(" · ").slice(0, 160) };
  }
}

/** 本地账本兜底：滚动窗口内按 requestId 去重的请求数 vs 自配上限 */
function estimateFromLedger(homeDir: string, cfg: RuntimeQuotaConfig): QuotaHeadroom {
  let used = 0;
  const seen = new Set<string>();
  try {
    const raw = readFileSync(path.join(homeDir, "usage.jsonl"), "utf8");
    const since = Date.now() - cfg.windowHours * 3_600_000;
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (Number(r["at"] ?? 0) < since) continue;
      const reqId = r["requestId"];
      if (typeof reqId === "string" && reqId !== "") {
        if (seen.has(reqId)) continue;
        seen.add(reqId);
      }
      used++;
    }
  } catch {
    return { runtimeId: "", subscribed: true, percent: null, resetsAt: null, summary: "无本地账本", source: "unknown", checkedAt: Date.now() };
  }
  const percent = cfg.limit !== null && cfg.limit > 0 ? Math.max(0, Math.round((1 - used / cfg.limit) * 100)) : null;
  const summary = `账本估算：窗口 ${cfg.windowHours}h 内约 ${used} 次${cfg.limit !== null ? ` / 上限 ${cfg.limit}` : "（未配上限）"} —— 口径仅含本工作台会话`;
  return { runtimeId: "", subscribed: true, percent, resetsAt: null, summary, source: "ledger", checkedAt: Date.now() };
}

export class QuotaProbe {
  private readonly cache = new Map<string, { at: number; data: QuotaHeadroom }>();
  private readonly inflight = new Map<string, Promise<QuotaHeadroom>>();

  constructor(private readonly homeDir: string) {}

  /**
   * 查一个执行器的余量。subscribed=false 直接给 unknown；
   * 有探针命令走探针（失败回落账本），没有直接账本。
   */
  async read(runtimeId: string, cfg: RuntimeQuotaConfig, opts: { refresh?: boolean } = {}): Promise<QuotaHeadroom> {
    if (!cfg.subscribed) {
      return { runtimeId, subscribed: false, percent: null, resetsAt: null, summary: null, source: "unknown", checkedAt: null };
    }
    const hit = this.cache.get(runtimeId);
    if (hit !== undefined && !opts.refresh && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
    const running = this.inflight.get(runtimeId);
    if (running !== undefined) return running;
    const p = (async (): Promise<QuotaHeadroom> => {
      if (cfg.probeCmd !== null) {
        const r = await execShell(cfg.probeCmd);
        if (r.ok) {
          const parsed = parseProbe(cfg.probeFormat, r.stdout);
          const data: QuotaHeadroom = {
            runtimeId,
            subscribed: true,
            percent: parsed.percent,
            resetsAt: parsed.resetsAt,
            summary: parsed.summary === "" ? null : parsed.summary,
            source: "probe",
            checkedAt: Date.now(),
          };
          this.cache.set(runtimeId, { at: Date.now(), data });
          return data;
        }
        log.warn("quota probe failed, falling back to ledger", { runtimeId, cmd: cfg.probeCmd, stderr: r.stderr.slice(0, 200) });
      }
      const data: QuotaHeadroom = { ...estimateFromLedger(this.homeDir, cfg), runtimeId };
      this.cache.set(runtimeId, { at: Date.now(), data });
      return data;
    })();
    this.inflight.set(runtimeId, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(runtimeId);
    }
  }

  /** 全部订阅执行器的余量表（心跳 prompt 与确认弹窗共用）；不阻塞、慢的给 unknown */
  async readAll(runtimes: Readonly<Record<string, RuntimeQuotaConfig>>): Promise<QuotaHeadroom[]> {
    const ids = Object.entries(runtimes).filter(([, cfg]) => cfg.subscribed).map(([id]) => id);
    return Promise.all(
      ids.map(async (id) => {
        try {
          return await this.read(id, runtimes[id]!, {});
        } catch {
          return { runtimeId: id, subscribed: true, percent: null, resetsAt: null, summary: null, source: "unknown", checkedAt: null } as QuotaHeadroom;
        }
      }),
    );
  }
}
