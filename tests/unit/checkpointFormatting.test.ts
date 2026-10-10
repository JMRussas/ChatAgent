import { describe, expect, it } from "vitest";
import {
  CONTINUATION_RECORD_SCHEMA,
  CONTINUATION_RECORD_SCHEMA_V2,
  FORMATTING_MODE,
  buildGate,
  checkArguments,
  classifyFormatResult,
  formatArguments,
  isFormatSupported,
  isV1Reason,
  parseContinuationRecord,
  partitionEligible,
  serializeContinuationRecord,
  type ContinuationRecordV1,
  type ContinuationRecordV2,
  type FormattingFacts
} from "../../src/checkpoint/checkpointContinuation";
import { continuationCurrency } from "../../src/integrations/hekate/checkpointContinuationView";
import {
  BASE_REF,
  FENCE,
  OTHER_REF,
  RUN_ID,
  SOURCE_REF,
  STAMP
} from "../helpers/checkpointFixtures";

const h = (c: string) => c.repeat(64);
const PINNED = { config: "/wt/.prettierrc.json", ignore: "/wt/.prettierignore" };

const facts = (over: Partial<FormattingFacts> = {}): FormattingFacts => ({
  mode: FORMATTING_MODE,
  state: "pending",
  ran: false,
  eligible: 0,
  unsupported: 0,
  changed: 0,
  exitCode: null,
  signal: null,
  timedOut: false,
  outputLimited: false,
  outputBytes: 0,
  configSha256: h("1"),
  ignoreSha256: h("2"),
  ...over
});

const v1 = (over: Partial<ContinuationRecordV1> = {}): ContinuationRecordV1 => ({
  schema: CONTINUATION_RECORD_SCHEMA,
  runId: RUN_ID,
  identity: { ...FENCE, observedStateRevision: 4, executorRef: "exec-1" },
  baseRef: BASE_REF,
  phase: "snapshotting",
  reason: "in_progress",
  startedAt: STAMP,
  updatedAt: STAMP,
  endedAt: null,
  sourceRef: null,
  worker: null,
  finish: "not_attempted",
  checkRole: "mimir_external_checks",
  checks: [],
  gate: "not_written",
  failureAttribution: "unattributed",
  leadAcceptance: "pending",
  semanticReview: "not_performed",
  delivery: "not_sent",
  wake: "none",
  acknowledgment: "none",
  recordTrust: "supplied_not_authenticated",
  writerLiveness: "unknown",
  ...over
});

const v2 = (over: Partial<ContinuationRecordV2> = {}): ContinuationRecordV2 => ({
  ...v1(),
  schema: CONTINUATION_RECORD_SCHEMA_V2,
  rawRef: null,
  formatting: facts(),
  ...over
});

const passing = (["prettier", "typescript", "vitest"] as const).map((name) => ({
  name,
  result: "pass" as const,
  ran: true,
  exitCode: 0,
  signal: null,
  timedOut: false,
  outputLimited: false,
  outputBytes: 1,
  outputSha256: h("e"),
  startedAt: STAMP,
  endedAt: STAMP
}));

/** A stored review-pending v2 record whose formatting state decides which refs must agree. */
const reviewPending = (state: "unchanged" | "committed", rawRef: string, sourceRef: string) =>
  v2({
    phase: "review_pending",
    reason: "checks_passed",
    endedAt: STAMP,
    sourceRef,
    rawRef,
    finish: "confirmed",
    gate: "written",
    checks: passing,
    formatting: facts({ state, ran: state === "committed", eligible: 1, changed: 1 })
  });

const accepts = (record: unknown) =>
  parseContinuationRecord(Buffer.from(JSON.stringify(record))).ok;

describe("eligible partition and fixed formatter arguments", () => {
  it("counts deleted, unsupported and eligible files; only existing supported files qualify", () => {
    expect(
      partitionEligible([
        { path: "src/a.ts", deleted: false },
        { path: "docs/x.md", deleted: true },
        { path: "src/data.json", deleted: false },
        { path: "src/notes.txt", deleted: false },
        { path: "src/.hidden", deleted: false },
        { path: "src/old.ts", deleted: true }
      ])
    ).toEqual({ eligible: ["src/a.ts", "src/data.json"], unsupported: 2, deleted: 2 });
    expect(isFormatSupported("src/a.ts")).toBe(true);
    expect(isFormatSupported("src/a.TS")).toBe(false);
    expect(isFormatSupported("src/Makefile")).toBe(false);
  });

  it("writes and checks with the same explicit config, ignore file and file list, no globs", () => {
    const write = formatArguments("write", PINNED, ["src/a.ts", "src/b.ts"]);
    const check = formatArguments("check", PINNED, ["src/a.ts", "src/b.ts"]);
    const shared = [
      "--config",
      PINNED.config,
      "--no-editorconfig",
      "--ignore-path",
      PINNED.ignore
    ];
    expect(write.slice(1, 6)).toEqual(shared);
    expect(check.slice(1, 6)).toEqual(shared);
    expect(write.slice(6)).toEqual([
      "--write",
      "--ignore-unknown",
      "--no-error-on-unmatched-pattern",
      "src/a.ts",
      "src/b.ts"
    ]);
    expect(check.slice(6)).toEqual(["--check", "--ignore-unknown", "src/a.ts", "src/b.ts"]);
    expect(write.join(" ")).not.toMatch(/[*?{}]/);
  });

  it("keeps the legacy check argv byte-identical without pinned files", () => {
    expect(checkArguments("prettier", ["src/a.ts"], ["tests/a.test.ts"])).toEqual([
      expect.stringMatching(/prettier/),
      "--check",
      "--ignore-unknown",
      "src/a.ts"
    ]);
    expect(checkArguments("prettier", ["src/a.ts"], ["tests/a.test.ts"], PINNED)).toEqual(
      formatArguments("check", PINNED, ["src/a.ts"])
    );
  });
});

describe("format result classification", () => {
  const eligible = ["src/a.ts", "src/b.ts"];
  const diff = (path: string, over: Record<string, string> = {}) => ({
    oldMode: "100644",
    newMode: "100644",
    status: "M",
    path,
    ...over
  });
  const unstaged = (path: string) => ({ x: " ", y: "M", path });

  it("accepts unstaged modifications of eligible regular files and returns them sorted", () => {
    expect(
      classifyFormatResult(
        [unstaged("src/b.ts"), unstaged("src/a.ts")],
        [diff("src/b.ts"), diff("src/a.ts")],
        eligible
      )
    ).toEqual({ ok: true, changed: ["src/a.ts", "src/b.ts"] });
    expect(classifyFormatResult([], [], eligible)).toEqual({ ok: true, changed: [] });
  });

  it("accepts the staged form only when asked for it", () => {
    const staged = [{ x: "M", y: " ", path: "src/a.ts" }];
    expect(classifyFormatResult(staged, [diff("src/a.ts")], eligible, true).ok).toBe(true);
    expect(classifyFormatResult(staged, [diff("src/a.ts")], eligible).ok).toBe(false);
    expect(classifyFormatResult([unstaged("src/a.ts")], [diff("src/a.ts")], eligible, true).ok).toBe(
      false
    );
  });

  it("rejects untracked, outside, deleted, retyped, linked, duplicated and mismatched entries", () => {
    const one = [unstaged("src/a.ts")];
    const violations: [Parameters<typeof classifyFormatResult>[0], ReturnType<typeof diff>[]][] = [
      [[{ x: "?", y: "?", path: "src/stray.ts" }], []],
      [[unstaged("src/outside.ts")], [diff("src/outside.ts")]],
      [[{ x: " ", y: "D", path: "src/a.ts" }], [diff("src/a.ts", { status: "D" })]],
      [one, [diff("src/a.ts", { newMode: "100755" })]],
      [one, [diff("src/a.ts", { oldMode: "120000", newMode: "120000" })]],
      [one, [diff("src/a.ts", { oldMode: "100644", newMode: "000000" })]],
      [one, [diff("src/a.ts", { status: "T" })]],
      [one, []],
      [[], [diff("src/a.ts")]],
      [[unstaged("src/a.ts"), unstaged("src/a.ts")], [diff("src/a.ts")]],
      [one, [diff("src/a.ts"), diff("src/a.ts")]]
    ];
    for (const [status, entries] of violations)
      expect(classifyFormatResult(status, entries, eligible)).toEqual({
        ok: false,
        reason: "scope_violation"
      });
  });
});

describe("record versions", () => {
  it("round-trips a v1 record byte-for-byte and keeps parsing it as v1", () => {
    const record = v1();
    const text = serializeContinuationRecord(record);
    expect(text).toBe(`${JSON.stringify(record)}\n`);
    const parsed = parseContinuationRecord(Buffer.from(text));
    expect(parsed.ok && parsed.value.schema).toBe(CONTINUATION_RECORD_SCHEMA);
    expect(text).not.toMatch(/rawRef|formatting/);
  });

  it("narrows a parsed union on the schema literal before reading v2 fields", () => {
    const parsed = parseContinuationRecord(
      Buffer.from(serializeContinuationRecord(reviewPending("committed", SOURCE_REF, OTHER_REF)))
    );
    if (!parsed.ok) throw new Error("expected a valid record");
    const record = parsed.value;
    expect(record.schema).toBe(CONTINUATION_RECORD_SCHEMA_V2);
    if (record.schema !== CONTINUATION_RECORD_SCHEMA_V2) throw new Error("expected v2");
    expect(record.rawRef).toBe(SOURCE_REF);
    expect(record.sourceRef).toBe(OTHER_REF);
    expect(record.formatting.state).toBe("committed");
  });

  it("keeps the v1 wire schema strict: no v2 fields and no formatter reasons", () => {
    expect(accepts(v1())).toBe(true);
    expect(accepts({ ...v1(), rawRef: null })).toBe(false);
    expect(accepts({ ...v1(), formatting: facts() })).toBe(false);
    for (const reason of ["format_failed", "format_unavailable"]) {
      expect(accepts({ ...v1({ phase: "needs_operator", endedAt: STAMP }), reason })).toBe(false);
    }
    expect(isV1Reason("checks_passed")).toBe(true);
    expect(isV1Reason("format_failed")).toBe(false);
    expect(isV1Reason("format_unavailable")).toBe(false);
  });

  it("requires v2 to carry the formatter facts and to know the raw ref before a source ref", () => {
    expect(accepts(v2())).toBe(true);
    const { formatting: _facts, ...withoutFacts } = v2();
    expect(accepts(withoutFacts)).toBe(false);
    const { rawRef: _raw, ...withoutRaw } = v2();
    expect(accepts(withoutRaw)).toBe(false);
    expect(accepts(v2({ sourceRef: SOURCE_REF, rawRef: null }))).toBe(false);
    expect(accepts(v2({ sourceRef: SOURCE_REF, rawRef: SOURCE_REF }))).toBe(true);
    expect(accepts({ ...v2(), formatting: { ...facts(), path: "src/a.ts" } })).toBe(false);
    expect(accepts({ ...v2(), formatting: { ...facts(), mode: "other" } })).toBe(false);
    expect(accepts({ ...v2(), extra: 1 })).toBe(false);
  });

  it("ties the formatter reasons to the recorded formatter state", () => {
    const stop = { phase: "needs_operator", endedAt: STAMP } as const;
    expect(
      accepts(v2({ ...stop, reason: "format_failed", formatting: facts({ state: "failed" }) }))
    ).toBe(true);
    expect(
      accepts(v2({ ...stop, reason: "format_failed", formatting: facts({ state: "running" }) }))
    ).toBe(false);
    expect(
      accepts(
        v2({ ...stop, reason: "format_unavailable", formatting: facts({ state: "unavailable" }) })
      )
    ).toBe(true);
    expect(
      accepts(v2({ ...stop, reason: "format_unavailable", formatting: facts({ state: "failed" }) }))
    ).toBe(false);
  });

  it("refines review_pending: unchanged means raw equals source, committed means they differ", () => {
    expect(accepts(reviewPending("unchanged", SOURCE_REF, SOURCE_REF))).toBe(true);
    expect(accepts(reviewPending("unchanged", SOURCE_REF, OTHER_REF))).toBe(false);
    expect(accepts(reviewPending("committed", SOURCE_REF, OTHER_REF))).toBe(true);
    expect(accepts(reviewPending("committed", SOURCE_REF, SOURCE_REF))).toBe(false);
    expect(accepts(v2({ ...reviewPending("committed", SOURCE_REF, OTHER_REF), rawRef: null }))).toBe(
      false
    );
    const pending = reviewPending("committed", SOURCE_REF, OTHER_REF);
    expect(accepts({ ...pending, formatting: { ...pending.formatting, state: "failed" } })).toBe(
      false
    );
  });

  it("judges view currency against the final source, not the raw commit", () => {
    const record = reviewPending("committed", SOURCE_REF, OTHER_REF);
    const task = (artifactRef: string) => ({ state: "review_pending" as const, artifactRef });
    expect(continuationCurrency(record, task(OTHER_REF))).toEqual({ ok: true, relevance: "open" });
    expect(continuationCurrency(record, task(SOURCE_REF))).toEqual({
      ok: false,
      reason: "stale_source"
    });
  });

  it("builds the gate from the final source of a v2 record, never the raw commit", () => {
    const gate = buildGate(reviewPending("committed", SOURCE_REF, OTHER_REF), h("c"), STAMP);
    expect(gate.sourceRef).toBe(OTHER_REF);
    expect(gate.evidenceRefs).toContain(`source:${OTHER_REF}`);
    expect(gate.evidenceRefs.join(" ")).not.toContain(SOURCE_REF);
    expect(gate.outcome).toBe("checks_passed");
  });
});
