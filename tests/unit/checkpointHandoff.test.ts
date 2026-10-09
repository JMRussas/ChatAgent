import { describe, expect, it } from "vitest";
import {
  buildHandoff,
  itemsDigest,
  parseHandoff,
  serializeHandoff,
  type AttentionItem
} from "../../src/integrations/hekate/checkpointAttention";
import { STAMP } from "../helpers/checkpointFixtures";
import { attentionOf, item } from "../helpers/handoffFixtures";

const ID = "22222222-2222-4222-8222-222222222222";
const record = (...items: AttentionItem[]) =>
  buildHandoff({
    handoffId: ID,
    createdAt: STAMP,
    overviewGeneratedAt: STAMP,
    attention: attentionOf(...items)
  });
const bytes = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));

describe("checkpoint-handoff/v1", () => {
  it("round-trips with literal not-sent fields, no taskListed and a pinned digest", () => {
    const built = record(item());
    const text = serializeHandoff(built);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = parseHandoff(Buffer.from(text));
    expect(parsed.ok && parsed.value).toEqual(built);
    expect(built).toMatchObject({
      delivery: "not_sent",
      notification: "none",
      wake: "none",
      acknowledgment: "none",
      fenceStatus: "observed_at_capture",
      automaticAllowed: false,
      source: { overviewSchema: "executive-overview/v3", atomic: false }
    });
    expect("taskListed" in built.items[0]).toBe(false);
    expect(built.itemsSha256).toBe(itemsDigest(built.items));
  });

  it("carries the pid descriptor only on cleanup items", () => {
    const cleanup = item({
      kind: "cleanup_unconfirmed",
      stop: { kind: "failed", code: "cleanup_failed" },
      rootPid: 4242,
      action: "inspect_owned_process_manually"
    });
    expect(parseHandoff(Buffer.from(serializeHandoff(record(cleanup)))).ok).toBe(true);
    expect(() => serializeHandoff(record(item({ rootPid: 4242 })))).toThrow();
  });

  it("rejects altered literals, a wrong digest, unknown keys and bad item shapes", () => {
    const base = JSON.parse(serializeHandoff(record(item())));
    const mutants: Record<string, unknown>[] = [
      { ...base, delivery: "sent" },
      { ...base, notification: "email" },
      { ...base, wake: "scheduled" },
      { ...base, acknowledgment: "operator" },
      { ...base, schema: "checkpoint-handoff/v2" },
      { ...base, itemsSha256: "0".repeat(64) },
      { ...base, extra: 1 },
      { ...base, automaticAllowed: true },
      { ...base, forbidden: ["model_retry"] },
      { ...base, items: [] },
      { ...base, items: [{ ...base.items[0], kind: "mystery" }] },
      { ...base, items: [{ ...base.items[0], attribution: "source" }] },
      { ...base, items: [{ ...base.items[0], note: "prompt text" }] },
      { ...base, items: [{ ...base.items[0], action: "inspect_owned_process_manually" }] }
    ];
    for (const mutant of mutants) expect(parseHandoff(bytes(mutant)).ok).toBe(false);
  });

  it("rejects duplicate keys, __proto__, floats, oversize input and syntax errors without echo", () => {
    const text = serializeHandoff(record(item()));
    expect(parseHandoff(bytes(text.replace('"wake":"none"', '"wake":"none","wake":"none"'))).ok).toBe(false);
    expect(parseHandoff(bytes(text.replace("{", '{"__proto__":{},'))).ok).toBe(false);
    expect(parseHandoff(bytes(text.replace('"attemptEpoch":2', '"attemptEpoch":2.5'))).ok).toBe(false);
    expect(parseHandoff(bytes(text.replace('"attemptEpoch":2', '"attemptEpoch":2.0'))).ok).toBe(false);
    expect(parseHandoff(bytes("{not json SECRET"))).toEqual({ ok: false, reason: "invalid" });
    expect(parseHandoff(Buffer.alloc(64 * 1024 + 1, 32))).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses to serialize a record that is oversize or off-contract", () => {
    const big = record(item());
    big.forbidden = [...big.forbidden, "x".repeat(70_000)];
    expect(() => serializeHandoff(big)).toThrow();
  });
});
