import { afterEach, describe, expect, it, vi } from "vitest";
import { PdSplitCard } from "./PdSplitCard";
import { cleanupRenders, flush, render } from "../../testing/render";
import type { PdSplit } from "../../api/types";

vi.mock("../../api/client", () => ({ fetchPdSplit: vi.fn() }));
import { fetchPdSplit } from "../../api/client";
const fetchSplit = vi.mocked(fetchPdSplit);
const split = (overrides: Partial<PdSplit> = {}): PdSplit => ({
  enabled: true, available: true, generatedAt: new Date(Date.now()).toISOString(), error: null,
  engineUp: true, minTokens: 16384,
  totals: { pd: 3, direct: 5, failed: 1, tokens: 300000, prefillMs: 30000 },
  active: null,
  recent: [{ tokens: 122733, prefixTokens: 120832, prefillMs: 14372, pushMs: 995, stateBytes: 110500000, observedAt: "2026-11-12T08:00:05Z" }],
  ...overrides,
});

describe("optional prefill/decode split card", () => {
  afterEach(() => { cleanupRenders(); });

  it("shows counts, the prefill host's average speed and the recent prompt's timings", async () => {
    fetchSplit.mockResolvedValue(split());
    const { container } = render(<PdSplitCard />);
    await flush();
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("10,000 tok/s");
    expect(container.textContent).toContain("123K tok");
    expect(container.textContent).toContain("14.4 s + 0.99 s");
    expect(container.textContent).toContain("111 MB");
  });

  it("shows the prompt being prefilled and a down engine", async () => {
    fetchSplit.mockResolvedValue(split({ active: { tokens: 61000, ageMs: 2500 } }));
    const busy = render(<PdSplitCard />);
    await flush();
    expect(busy.container.textContent).toContain("Prefilling");
    expect(busy.container.textContent).toContain("61.0K token prompt");
    cleanupRenders();

    fetchSplit.mockResolvedValue(split({ engineUp: false }));
    const down = render(<PdSplitCard />);
    await flush();
    expect(down.container.textContent).toContain("Engine down");
  });

  it("does not present an unavailable source as zero counts", async () => {
    fetchSplit.mockResolvedValue(split({ available: false, totals: null, recent: [], engineUp: null, error: "pd-split-source-unavailable" }));
    const { container } = render(<PdSplitCard />);
    await flush();
    expect(container.textContent).toContain("request counts are unknown");
    expect(container.textContent).not.toContain("Cluster only");
  });

  it("is hidden when disabled", async () => {
    fetchSplit.mockResolvedValue(split({ enabled: false, available: false, totals: null, recent: [], engineUp: null }));
    const { container } = render(<PdSplitCard />);
    await flush();
    expect(container.textContent).toBe("");
  });
});
