import { useEffect, useState } from "react";
import { fetchPdSplit } from "../../api/client";
import type { PdSplit } from "../../api/types";
import { ActivityIcon } from "../ui/icons";
import { Panel } from "../ui/Panel";

const NO_RESPONSE_TIMEOUT_MS = 30_000;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function tokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K` : String(value);
}

function rate(tokenCount: number, ms: number): string {
  return ms > 0 ? `${Math.round(tokenCount / (ms / 1000)).toLocaleString("en-US")} tok/s` : "—";
}

/** Prefill/decode split: long prompts prefilled on a separate host, decoded on the cluster. */
export function PdSplitCard() {
  const [split, setSplit] = useState<PdSplit | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let loading = false;
    let disabled = false;
    let staleTimer: number | undefined;
    const load = async () => {
      if (loading || disabled) return;
      loading = true;
      try {
        const next = await fetchPdSplit();
        if (!alive) return;
        disabled = next.enabled === false;
        setSplit(next);
        setFailed(false);
        window.clearTimeout(staleTimer);
        if (next.available) staleTimer = window.setTimeout(() => {
          if (alive) setFailed(true);
        }, NO_RESPONSE_TIMEOUT_MS);
      } catch {
        if (alive) setFailed(true);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => { alive = false; window.clearInterval(timer); window.clearTimeout(staleTimer); };
  }, []);

  if (split?.enabled === false) return null;
  const available = split?.available === true && !failed;
  const totals = available ? split.totals : null;
  const recent = available ? split.recent : [];
  const active = available ? split.active : null;
  return (
    <Panel title="Prefill / decode split" icon={<ActivityIcon className="h-3.5 w-3.5" />} className="ov-card" bodyClassName="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
        <span>Prefill host</span>
        <span className={!available ? "text-muted" : split.engineUp ? "font-tabular text-success" : "text-danger"}>
          {!available ? "Live status unavailable" : split.engineUp ? active ? "Prefilling" : "Ready" : "Engine down; cluster prefills"}
        </span>
      </div>
      {!split && !failed ? <p className="text-[12px] text-muted">Waiting for split status…</p> : !available || !totals ? (
        <p className="text-[12px] text-muted">Split status unavailable; request counts are unknown.</p>
      ) : (
        <>
          {active ? (
            <div className="rounded border border-border bg-surface-elevated px-2.5 py-2 text-[12px]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-text-strong">
                  {tokens(active.tokens)} token prompt{split.queued ? ` · ${split.queued} queued` : ""}
                </span>
                <span className="font-tabular text-success">{seconds(active.ageMs)}</span>
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded border border-border bg-surface-elevated px-2 py-1.5">
              <div className="font-tabular text-[14px] font-semibold text-text-strong">{totals.pd}</div>
              <div className="text-[10px] text-muted">Split</div>
            </div>
            <div className="rounded border border-border bg-surface-elevated px-2 py-1.5">
              <div className="font-tabular text-[14px] font-semibold text-text-strong">{totals.direct}</div>
              <div className="text-[10px] text-muted">Cluster only</div>
            </div>
            <div className="rounded border border-border bg-surface-elevated px-2 py-1.5">
              <div className={`font-tabular text-[14px] font-semibold ${totals.failed > 0 ? "text-danger" : "text-text-strong"}`}>{totals.failed}</div>
              <div className="text-[10px] text-muted">Fell back</div>
            </div>
          </div>
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="text-muted">Prefill host average</span>
            <span className="font-tabular text-text">{rate(totals.tokens, totals.prefillMs)} · {tokens(totals.tokens)} tokens</span>
          </div>
          <div className="border-t border-border pt-2.5">
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted">Recent split prompts</div>
            {recent.slice(0, 6).map((entry, index) => (
              <div key={`${entry.observedAt}-${index}`} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-text">
                  {tokens(entry.tokens)} tok{entry.cachedTokens > 0 ? ` (${tokens(entry.cachedTokens)} cached)` : ""} · {rate(entry.prefixTokens, entry.prefillMs)}
                </span>
                <span className="font-tabular text-muted">
                  {seconds(entry.prefillMs)} + {seconds(entry.pushMs)} · {Math.round(entry.stateBytes / 1e6)} MB
                </span>
              </div>
            ))}
            {recent.length === 0 ? <p className="text-[12px] text-muted">No split prompts in the last hour.</p> : null}
          </div>
        </>
      )}
      <p className="text-[10px] text-muted">
        Counts since the proxy started. Recent rows: prompt size · prefill speed, then prefill + state transfer time · state size.
        Speed counts only the tokens computed; cached ones come from the prefill host's prefix cache.
        {available && split.minTokens ? ` Prompts adding fewer than ${tokens(split.minTokens)} new tokens stay on the cluster.` : ""}
      </p>
    </Panel>
  );
}
