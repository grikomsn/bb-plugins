import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return NUMBER_FORMAT.format(Math.round(n));
}

/**
 * Compact bytes/tokens like `12.3k`, `4.5m`.
 */
export function formatTokensCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs < 1_000) return NUMBER_FORMAT.format(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  return `${(n / 1_000_000_000).toFixed(2)}b`;
}

export function formatPercent(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  return `${Math.round(p)}%`;
}

export function clampPercent(p: number | null | undefined): number | null {
  if (p === null || p === undefined || !Number.isFinite(p)) return null;
  return Math.max(0, Math.min(100, p));
}

export function formatRelative(iso: string | number): string {
  const ms = Date.now() - (typeof iso === "number" ? iso : new Date(iso).getTime());
  if (ms < 1_000) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** YYYY-MM-DD in local time. Accepts Date or epoch ms. */
export function localDateKey(d: Date | number): string {
  const date = typeof d === "number" ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
