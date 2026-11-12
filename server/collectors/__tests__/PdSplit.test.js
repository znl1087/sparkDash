import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePdSplit, PdSplitStore } from "../PdSplit.js";

const NOW = Date.parse("2026-11-12T08:00:10.000Z");

function payload(overrides = {}) {
  return {
    generatedAt: "2026-11-12T08:00:09.000Z",
    engineUp: true,
    minTokens: 16384,
    totals: { pd: 3, direct: 5, failed: 1, tokens: 300000, prefillMs: 33000 },
    active: { tokens: 61000, ageMs: 1500 },
    recent: [{ tokens: 122733, prefixTokens: 120832, prefillMs: 14372, pushMs: 995, stateBytes: 110500000, ageMs: 4000 }],
    ...overrides,
  };
}

test("parsePdSplit keeps bounded counters and turns ages into timestamps", () => {
  const parsed = parsePdSplit(payload(), NOW);
  assert.equal(parsed.engineUp, true);
  assert.deepEqual(parsed.totals, { pd: 3, direct: 5, failed: 1, tokens: 300000, prefillMs: 33000 });
  assert.deepEqual(parsed.active, { tokens: 61000, ageMs: 1500 });
  assert.equal(parsed.recent[0].observedAt, "2026-11-12T08:00:05.000Z");
  assert.equal(parsed.recent[0].prefixTokens, 120832);
});

test("parsePdSplit rejects stale, malformed and inconsistent payloads", () => {
  assert.equal(parsePdSplit(payload({ generatedAt: "2026-11-12T07:00:00.000Z" }), NOW), null);
  assert.equal(parsePdSplit(payload({ totals: { pd: -1, direct: 0, failed: 0, tokens: 0, prefillMs: 0 } }), NOW), null);
  assert.equal(parsePdSplit(payload({ recent: [{ tokens: 10, prefixTokens: 20, prefillMs: 1, pushMs: 1, stateBytes: 1, ageMs: 1 }] }), NOW), null);
  assert.equal(parsePdSplit(payload({ recent: "none" }), NOW), null);
  assert.equal(parsePdSplit(null, NOW), null);
});

test("PdSplitStore is disabled without a URL and reports an unreachable source", async () => {
  const off = new PdSplitStore({ url: "" });
  assert.equal(off.snapshot().enabled, false);
  assert.equal(off.snapshot().error, null);

  const invalid = new PdSplitStore({ url: "http://example.com/pd/stats" });
  assert.equal(invalid.snapshot().error, "pd-split-configuration-invalid");

  const down = new PdSplitStore({ url: "http://192.168.5.113:8889/pd/stats", now: () => NOW, read: async () => { throw new Error("down"); } });
  await down.refreshIfDue();
  const snapshot = down.snapshot();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.error, "pd-split-source-unavailable");
  assert.equal(snapshot.totals, null);
  assert.deepEqual(snapshot.recent, []);
});

test("PdSplitStore serves the parsed sample and ages the in-flight prefill", async () => {
  let nowMs = NOW;
  const store = new PdSplitStore({ url: "http://192.168.5.113:8889/pd/stats", now: () => nowMs, read: async () => payload() });
  await store.refreshIfDue();
  nowMs += 2000;
  const snapshot = store.snapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.totals.pd, 3);
  assert.equal(snapshot.active.ageMs, 1500 + 3000);
  assert.equal(snapshot.recent.length, 1);
});
