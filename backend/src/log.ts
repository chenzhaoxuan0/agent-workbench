/**
 * 最小日志 —— 单行、人类可读、带 kv。
 *
 * "日志清" 是 Phase 0 的验收项之一：一行一件事，不刷屏、不打堆栈
 * （错误对象单独走 error 级并序列化 message）。
 */

import type { LogLevel } from "./config.ts";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVEL_WEIGHT.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_WEIGHT[level];
}

function fmtValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function emit(level: LogLevel, message: string, kv?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < threshold) return;
  const head = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}`;
  const tail = kv
    ? " " +
      Object.entries(kv)
        .map(([k, v]) => `${k}=${fmtValue(v)}`)
        .join(" ")
    : "";
  const line = `${head} ${message}${tail}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, kv?: Record<string, unknown>) => emit("debug", message, kv),
  info: (message: string, kv?: Record<string, unknown>) => emit("info", message, kv),
  warn: (message: string, kv?: Record<string, unknown>) => emit("warn", message, kv),
  error: (message: string, kv?: Record<string, unknown>) => emit("error", message, kv),
};
