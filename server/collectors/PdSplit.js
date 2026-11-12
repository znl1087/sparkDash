import { activityUrl, readActivity } from "./InferenceActivity.js";

const POLL_INTERVAL_MS = 5_000;
const SOURCE_MAX_AGE_MS = 30_000;
const RETENTION_MS = 60 * 60_000;
const MAX_RECENT = 24;
const MAX_TOKENS = 4_000_000;
const MAX_DURATION_MS = 24 * 60 * 60_000;
const MAX_STATE_BYTES = 64 * 1024 ** 3;

function count(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/**
 * Prefill/decode split summary from a front proxy: long prompts are prefilled on a
 * separate prefill host and the prefix state is pushed to the decode cluster.
 * Retains only bounded counters and per-request timings; no prompts or keys.
 */
export function parsePdSplit(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.recent)) return null;
  const generatedMs = typeof payload.generatedAt === "string" ? Date.parse(payload.generatedAt) : NaN;
  if (!Number.isFinite(generatedMs) || nowMs - generatedMs > SOURCE_MAX_AGE_MS || generatedMs > nowMs + 10_000) return null;
  const totals = payload.totals;
  if (!totals || typeof totals !== "object" || Array.isArray(totals) ||
    !["pd", "direct", "failed", "tokens", "prefillMs"].every((key) => count(totals[key]))) return null;
  let active = null;
  if (payload.active != null) {
    if (typeof payload.active !== "object" || !count(payload.active.tokens, MAX_TOKENS) ||
      !count(payload.active.ageMs, MAX_DURATION_MS)) return null;
    active = { tokens: payload.active.tokens, ageMs: payload.active.ageMs };
  }
  const recent = [];
  for (const entry of payload.recent.slice(0, MAX_RECENT)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      !count(entry.tokens, MAX_TOKENS) || !count(entry.prefixTokens, MAX_TOKENS) || entry.prefixTokens > entry.tokens ||
      !count(entry.prefillMs, MAX_DURATION_MS) || !count(entry.pushMs, MAX_DURATION_MS) ||
      !count(entry.stateBytes, MAX_STATE_BYTES) || !count(entry.ageMs, MAX_DURATION_MS)) return null;
    // Tokens the prefill host reused from its prefix cache; prefixTokens counts only what it computed.
    const cachedTokens = entry.cachedTokens ?? 0;
    if (!count(cachedTokens, MAX_TOKENS) || entry.prefixTokens + cachedTokens > entry.tokens) return null;
    if (nowMs - generatedMs + entry.ageMs > RETENTION_MS) continue;
    recent.push({
      tokens: entry.tokens, prefixTokens: entry.prefixTokens, cachedTokens, prefillMs: entry.prefillMs, pushMs: entry.pushMs,
      stateBytes: entry.stateBytes, observedAt: new Date(Math.max(0, generatedMs - entry.ageMs)).toISOString(),
    });
  }
  return {
    generatedMs, active, recent,
    engineUp: payload.engineUp === true,
    minTokens: count(payload.minTokens, MAX_TOKENS) ? payload.minTokens : null,
    queued: count(payload.queued, 10_000) ? payload.queued : 0,
    totals: { pd: totals.pd, direct: totals.direct, failed: totals.failed, tokens: totals.tokens, prefillMs: totals.prefillMs },
  };
}

export class PdSplitStore {
  constructor({ url = process.env.SPARKDASH_PD_STATS_URL, read = readActivity, now = () => Date.now() } = {}) {
    this.enabled = typeof url === "string" && url.trim() !== "";
    this.url = activityUrl(url);
    this.read = read;
    this.now = now;
    this.payload = null;
    this.error = this.enabled && !this.url ? "pd-split-configuration-invalid" : null;
    this.lastPollMs = -Infinity;
    this.inflight = null;
  }

  async refreshIfDue() {
    if (!this.enabled || !this.url) return;
    if (this.inflight) return this.inflight;
    if (this.now() - this.lastPollMs < POLL_INTERVAL_MS) return;
    this.lastPollMs = this.now();
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async refresh() {
    try {
      this.payload = parsePdSplit(await this.read(this.url), this.now());
      this.error = this.payload ? null : "pd-split-source-unavailable";
    } catch {
      this.payload = null;
      this.error = "pd-split-source-unavailable";
    }
  }

  snapshot() {
    const nowMs = this.now();
    const available = this.enabled && this.payload != null && nowMs - this.payload.generatedMs <= SOURCE_MAX_AGE_MS &&
      this.payload.generatedMs <= nowMs + 10_000;
    const drift = available ? Math.max(0, nowMs - this.payload.generatedMs) : 0;
    return {
      enabled: this.enabled, available,
      generatedAt: available ? new Date(this.payload.generatedMs).toISOString() : null,
      error: this.enabled ? this.error ?? (available ? null : "pd-split-source-unavailable") : null,
      engineUp: available ? this.payload.engineUp : null,
      minTokens: available ? this.payload.minTokens : null,
      totals: available ? this.payload.totals : null,
      queued: available ? this.payload.queued : null,
      active: available && this.payload.active ? { ...this.payload.active, ageMs: this.payload.active.ageMs + drift } : null,
      recent: available ? this.payload.recent.filter((entry) => nowMs - Date.parse(entry.observedAt) <= RETENTION_MS) : [],
    };
  }
}
