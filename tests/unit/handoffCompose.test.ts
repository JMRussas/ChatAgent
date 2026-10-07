import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { member, readExactJson } from "../../src/integrations/hekate/handoffConsumer/exactJson";
import { sha256Hex } from "../../src/integrations/hekate/handoffConsumer/exactJson";
import {
  chatAgentH1,
  composeHandoff,
  CompositionRefusal,
  MESSAGE_OVERHEAD_TOKENS,
  type ComposeInput,
  type H1Builder,
  type H1Outcome,
  type ImportPolicy,
  type PolicyRule,
  type Retriever
} from "../../src/integrations/hekate/handoffConsumer/compose";
import type {
  FreshSnapshot,
  HandoffDelivery
} from "../../src/integrations/hekate/handoffConsumer/delivery";

// Composition of verified Hekate handoff deliveries (plan 034 rev 3) against the
// accepted golden bundle, using ChatAgent's real H1 at HEAD, and the reviewed
// supplement, whose expectations came from the reference H1-SHAPED stub.
const GOLDEN = "tests/fixtures/hekate/e2e-consumer-v0";
const SUPPLEMENT = "tests/fixtures/hekate/e2e-byte-compat-v0";

const bytes = (path: string) => new Uint8Array(readFileSync(path));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sha = (text: string) => sha256Hex(Buffer.from(text, "utf8"));

function deliveryFrom(dir: string, files: Record<string, string>): HandoffDelivery {
  const wrapper = json(join(dir, files.wrapper));
  return {
    wrapper: wrapper.wrapper,
    codec: wrapper.codec,
    candidateDigest: wrapper.candidateDigest,
    manifest: bytes(join(dir, files.manifest)),
    envelope: bytes(join(dir, files.envelope)),
    task: bytes(join(dir, files.task)),
    receipt: bytes(join(dir, files.receipt)),
    h1Input: bytes(join(dir, files.h1Input))
  };
}
/** A fixture's as-of proof, with the attempt epoch read losslessly. */
function freshFrom(path: string): FreshSnapshot {
  const raw = readFileSync(path);
  const f = JSON.parse(raw.toString("utf8"));
  const identity = member(
    readExactJson(new Uint8Array(raw), { maxBytes: 1 << 20 }).root as never,
    "review_identity"
  );
  const epoch = member(identity as never, "attemptEpoch") as unknown as { lexeme: string };
  return {
    candidateDigest: f.candidate_digest,
    recordId: f.record_id,
    reviewIdentity: { ...f.review_identity, attemptEpoch: BigInt(epoch.lexeme) },
    packageRef: f.package_ref,
    receiptStatus: f.receipt_status,
    currentBinding: f.current_binding,
    reviewClass: f.review_class,
    pinsProblem: f.pins_problem,
    pending: f.pending,
    queue: f.queue,
    basis: f.basis
  };
}
const goldenDelivery = () =>
  deliveryFrom(join(GOLDEN, "delivery"), {
    wrapper: "wrapper.json",
    manifest: "manifest.bin",
    envelope: "envelope.bin",
    task: "task.bin",
    receipt: "receipt.json",
    h1Input: "h1-input.json"
  });
const goldenFresh = () => freshFrom(join(GOLDEN, "inputs/fresh.json"));
const policy = (file: string): ImportPolicy => json(join(GOLDEN, "inputs", file));
const request = (file: string): { destination: string; wanted: unknown[] } =>
  json(join(GOLDEN, "inputs", file));

/** Answers only the exact recorded requests, as the bundle's offline replay does. */
function recordedRetriever(): Retriever & { calls: number } {
  const recorded: { request: unknown; result: never }[] = json(
    join(GOLDEN, "recorded/retrieval.json")
  );
  const key = (v: unknown) => JSON.stringify(v, Object.keys(v as object).sort());
  const fn = ((pointer: Record<string, unknown>) => {
    fn.calls++;
    const hit = recorded.find((r) => key(r.request) === key(pointer));
    if (!hit) throw new Error("unrecorded retrieval");
    return hit.result;
  }) as unknown as Retriever & { calls: number };
  fn.calls = 0;
  return fn;
}
/** ChatAgent's real H1, recording the options it was called with. */
function recordingH1() {
  const calls: { options: Record<string, unknown>; result: H1Outcome }[] = [];
  const h1: H1Builder = (options) => {
    const result = chatAgentH1(options);
    calls.push({ options, result });
    return result;
  };
  return { h1, calls };
}
function expectComposition(c: ReturnType<typeof composeHandoff>, dir: string) {
  expect(c.part).toBe(readFileSync(join(dir, "view-part.txt"), "utf8"));
  const expected = json(join(dir, "expected.json"));
  expect(c.viewDigest).toBe(expected.viewDigest);
  expect(c.reservationTokens).toBe(expected.reservationTokens);
  expect(c.viewCost).toBe(expected.viewCost);
  expect(c.h1.suppliedSha256).toBe(expected.h1SuppliedSha256);
  expect(Buffer.byteLength(c.part, "utf8") + MESSAGE_OVERHEAD_TOKENS).toBe(c.viewCost);
}

describe("golden bundle compositions with ChatAgent's real H1", () => {
  const recordedCalls: {
    options: { budget: { windowTokens: number } };
    result: { text: string; suppliedSha256: string };
  }[] = json(join(GOLDEN, "recorded/h1-calls.json"));
  const cases = [
    ["valid", "policy-allow.json", "request.json", 0],
    ["denied", "policy-deny.json", "request.json", 1],
    ["wrong-destination", "policy-allow.json", "request-wrong-destination.json", 2]
  ] as const;

  it.each(cases)(
    "%s reproduces its view part, digest, reservation and H1 call",
    (name, policyFile, requestFile, call) => {
      const { h1, calls } = recordingH1();
      const req = request(requestFile);
      const c = composeHandoff({
        delivery: goldenDelivery(),
        fresh: goldenFresh(),
        policy: policy(policyFile),
        destination: req.destination,
        wanted: req.wanted,
        retriever: recordedRetriever(),
        h1
      });
      expectComposition(c, join(GOLDEN, "expected", name));
      // One H1 call, with exactly the recorded reduced window, giving the recorded text.
      expect(calls).toHaveLength(1);
      const recorded = recordedCalls[call];
      expect(calls[0].options.budget).toEqual(recorded.options.budget);
      expect(calls[0].result).toMatchObject({
        ok: true,
        text: recorded.result.text,
        suppliedSha256: recorded.result.suppliedSha256
      });
      expect(c.h1.text).toBe(readFileSync(join(GOLDEN, "expected/h1-text.txt"), "utf8"));
    }
  );

  it("refuses a window too small for the view before any H1 call", () => {
    const delivery = goldenDelivery();
    const options = JSON.parse(Buffer.from(delivery.h1Input).toString("utf8"));
    options.budget.windowTokens = 3000;
    const { h1, calls } = recordingH1();
    const req = request("request.json");
    expect(() =>
      composeHandoff({
        delivery: { ...delivery, h1Input: new Uint8Array(Buffer.from(JSON.stringify(options))) },
        fresh: goldenFresh(),
        policy: policy("policy-allow.json"),
        destination: req.destination,
        wanted: req.wanted,
        retriever: recordedRetriever(),
        h1
      })
    ).toThrow(expect.objectContaining({ code: "CONTEXT_TOO_LARGE" }));
    expect(calls).toHaveLength(0);
  });
});

/**
 * A port of the reference's H1-SHAPED stub (`e1/consumer.py` `h1_stub`), which
 * produced the supplement's expectations. It is not ChatAgent's H1: it mimics only
 * its shape and budget arithmetic, with an approximate system rendering.
 */
function referenceH1Stub(taskText: string): H1Builder {
  return (options) => {
    const b = options.budget as Record<string, number>;
    const ri = options.roleInstructions as { fast: string; deep: string };
    const n = (s: string) => BigInt(Buffer.byteLength(s, "utf8"));
    const role = n(ri.fast) >= n(ri.deep) ? ri.fast : ri.deep;
    const fixed =
      32n + n(`${options.systemInstruction as string}\n\n${role}`) + 16n + n(taskText) + 16n;
    const available =
      BigInt(b.windowTokens) -
      BigInt(Math.max(b.fastOutputTokens, b.deepOutputTokens)) -
      BigInt(b.safetyTokens);
    if (fixed > available) return { ok: false, code: "CONTEXT_TOO_LARGE" };
    return {
      ok: true,
      text: taskText,
      suppliedSha256: sha(taskText),
      systemInstruction: options.systemInstruction as string,
      roleInstructions: { ...ri },
      messages: [{ role: "user", content: taskText }]
    };
  };
}
const ALLOW: ImportPolicy = {
  principal: "lead-1",
  rules: [
    { id: "read-all", action: "source_read", match: {}, allow: true },
    { id: "use-all", action: "destination_use", match: {}, allow: true }
  ]
};

describe("supplement compositions (expectations from the reference H1-shaped stub)", () => {
  const variants: {
    name: string;
    delivery: string;
    mutations?: { op: string; path: string }[];
    expect: { outcome: string; expected?: string };
  }[] = json(join(SUPPLEMENT, "variants.json"));
  const composed = variants.filter((v) => v.expect.outcome === "composed");

  it("covers all 6 reviewed compositions", () => {
    expect(composed).toHaveLength(6);
  });

  it.each(composed.map((v) => [v.name, v] as const))(
    "%s reproduces its view part byte for byte",
    (_name, variant) => {
      const dir = join(SUPPLEMENT, "deliveries", variant.delivery);
      const files = {
        wrapper: "wrapper.json",
        manifest: "manifest.bin",
        envelope: "envelope.bin",
        task: "task.bin",
        receipt: "receipt.json",
        h1Input: "h1-input.json"
      };
      const delivery = deliveryFrom(dir, files);
      for (const m of variant.mutations ?? []) {
        expect(m.op).toBe("file");
        delivery.h1Input = bytes(join(SUPPLEMENT, m.path));
      }
      const req = json(join(dir, "request.json"));
      const taskText = JSON.parse(Buffer.from(delivery.task).toString("utf8")).text;
      const c = composeHandoff({
        delivery,
        fresh: freshFrom(join(dir, "fresh.json")),
        policy: ALLOW,
        destination: req.destination,
        wanted: req.wanted,
        h1: referenceH1Stub(taskText)
      });
      expectComposition(c, join(SUPPLEMENT, variant.expect.expected!));
    }
  );
});

// Structural cases (acceptance matrix 4-6). Each starts from the golden valid case.
function goldenInput(over: Partial<ComposeInput> = {}): ComposeInput {
  const req = request("request.json");
  return {
    delivery: goldenDelivery(),
    fresh: goldenFresh(),
    policy: policy("policy-allow.json"),
    destination: req.destination,
    wanted: req.wanted,
    retriever: recordedRetriever(),
    h1: chatAgentH1,
    ...over
  };
}
/** The canonical view of a composition, parsed for inspection only. */
const viewOf = (c: { part: string }) => JSON.parse(c.part.split("\n")[1]);
const optional = (c: { part: string }) =>
  viewOf(c).optional as { kind: string; status: string; reason?: string; text?: string }[];
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).name;
  }
  return "composed";
};
/** Rebuilds the golden delivery around new manifest text: envelope, digests, proof. */
function withManifest(
  change: (manifest: string) => string
): Pick<ComposeInput, "delivery" | "fresh"> {
  const delivery = goldenDelivery();
  const fresh = goldenFresh();
  const old = Buffer.from(delivery.manifest).toString("utf8");
  const manifest = change(old);
  expect(manifest).not.toBe(old);
  const envelope = Buffer.from(delivery.envelope)
    .toString("utf8")
    .replace(old, () => manifest);
  const digest = sha(manifest);
  const receipt = Buffer.from(delivery.receipt)
    .toString("utf8")
    .replace(delivery.candidateDigest, digest);
  return {
    delivery: {
      ...delivery,
      candidateDigest: digest,
      manifest: new Uint8Array(Buffer.from(manifest)),
      envelope: new Uint8Array(Buffer.from(envelope)),
      receipt: new Uint8Array(Buffer.from(receipt))
    },
    fresh: { ...fresh, candidateDigest: digest }
  };
}

describe("bounded retrieval", () => {
  it("authorizes before any callback: a denied pointer is never fetched", () => {
    const retriever = recordedRetriever();
    const c = composeHandoff(goldenInput({ policy: policy("policy-deny.json"), retriever }));
    expect(retriever.calls).toBe(0);
    expect(
      optional(c)
        .filter((i) => i.kind === "retrieval")
        .map((i) => i.reason)
    ).toEqual(["policy", "policy"]);
  });

  it("never fetches an unselected pointer and deduplicates the request", () => {
    const retriever = recordedRetriever();
    const wanted = [
      ...request("request.json").wanted,
      { seq: 7, kind: "review_progress" },
      { seq: 999, kind: "binding" }
    ];
    const c = composeHandoff(goldenInput({ wanted, retriever }));
    expect(retriever.calls).toBe(2);
    const retrievals = optional(c).filter((i) => i.kind === "retrieval");
    expect(retrievals.map((i) => [i.status, i.reason ?? null])).toEqual([
      ["included", null],
      ["included", null],
      ["denied", "not_selected"]
    ]);
  });

  it.each([
    ["a string seq", [{ seq: "7", kind: "binding" }]],
    ["a boolean seq", [{ seq: true, kind: "binding" }]],
    ["a fractional seq", [{ seq: 1.5, kind: "binding" }]],
    ["an extra key", [{ seq: 7, kind: "binding", root: "x" }]],
    ["a long kind", [{ seq: 7, kind: "k".repeat(65) }]],
    ["a non-object", ["binding"]]
  ])("refuses a request with %s before any callback", (_label, wanted) => {
    const retriever = recordedRetriever();
    expect(codeOf(() => composeHandoff(goldenInput({ wanted, retriever })))).toBe(
      "retrieval_request_malformed"
    );
    expect(retriever.calls).toBe(0);
  });

  it("refuses more than 64 requested pointers", () => {
    const wanted = Array.from({ length: 65 }, (_, seq) => ({ seq, kind: "binding" }));
    expect(codeOf(() => composeHandoff(goldenInput({ wanted })))).toBe(
      "retrieval_request_too_large"
    );
  });

  const outage = () => {
    throw new Error("private outage detail");
  };
  it.each([
    ["a source error", outage, "source_error"],
    ["nothing found", () => null, "not_found_or_invalid"],
    [
      "another pointer echoed",
      (p: Record<string, unknown>) => ({ pointer: { ...p, seq: 1 }, bytes: "x" }),
      "callback_mismatch"
    ],
    [
      "non-text bytes",
      (p: Record<string, unknown>) => ({ pointer: p, bytes: 1 }),
      "callback_mismatch"
    ],
    [
      "too many bytes",
      (p: Record<string, unknown>) => ({ pointer: p, bytes: "x".repeat(32 * 1024 + 1) }),
      "cap"
    ]
  ])("marks %s unavailable without refusing the composition", (_label, fn, reason) => {
    const c = composeHandoff(goldenInput({ retriever: fn as unknown as Retriever }));
    const retrievals = optional(c).filter((i) => i.kind === "retrieval");
    expect(retrievals.every((i) => i.status === "unavailable" && i.reason === reason)).toBe(true);
    expect(c.part).not.toContain("private outage detail");
  });

  it("reports a missing retriever as unavailable", () => {
    const c = composeHandoff(goldenInput({ retriever: undefined }));
    expect(
      optional(c)
        .filter((i) => i.kind === "retrieval")
        .map((i) => i.reason)
    ).toEqual(["no_retriever", "no_retriever"]);
  });
});

describe("imports and the note", () => {
  it("marks an import whose text no longer matches its source hash unavailable", () => {
    const view = viewOf(composeHandoff(goldenInput()));
    const imported = view.optional.find((i: { kind: string }) => i.kind === "import");
    const changed = withManifest((m) => m.replace(imported.ref.contentHash, "0".repeat(64)));
    const c = composeHandoff(goldenInput(changed));
    const first = optional(c).find((i) => i.kind === "import")!;
    expect(first).toMatchObject({ status: "unavailable", reason: "hash_mismatch" });
    expect(first.text).toBeUndefined();
  });

  it("keeps the note a claim, outside every instruction", () => {
    const c = composeHandoff(goldenInput());
    const note = optional(c).find((i) => i.kind === "note")!;
    expect(note).toMatchObject({ status: "included", label: "claim" });
    expect(c.h1.systemInstruction).not.toContain(note.text);
  });
});

describe("budget and H1 binding", () => {
  /** ChatAgent's H1, refusing for budget the first `n` calls. */
  const tight = (n: number): H1Builder => {
    let calls = 0;
    return (options) =>
      calls++ < n ? { ok: false, code: "CONTEXT_TOO_LARGE" } : chatAgentH1(options);
  };

  it("omits optional items for budget in drop order, last of a kind first", () => {
    const status = (n: number) =>
      optional(composeHandoff(goldenInput({ h1: tight(n) }))).map((i) => `${i.kind}:${i.status}`);
    expect(status(1)).toEqual([
      "retrieval:included",
      "retrieval:omitted",
      "import:included",
      "import:included",
      "note:included"
    ]);
    expect(status(2)).toEqual([
      "retrieval:omitted",
      "retrieval:omitted",
      "import:included",
      "import:included",
      "note:included"
    ]);
    expect(status(3)).toEqual([
      "retrieval:omitted",
      "retrieval:omitted",
      "import:included",
      "import:omitted",
      "note:included"
    ]);
    expect(status(5)).toEqual([
      "retrieval:omitted",
      "retrieval:omitted",
      "import:omitted",
      "import:omitted",
      "note:omitted"
    ]);
    const omitted = optional(composeHandoff(goldenInput({ h1: tight(5) })));
    expect(omitted.every((i) => i.text === undefined && i.reason === "budget")).toBe(true);
    expect(codeOf(() => composeHandoff(goldenInput({ h1: tight(6) })))).toBe("CONTEXT_TOO_LARGE");
  });

  const throwing: H1Builder = () => {
    throw new Error("x");
  };
  const withResult =
    (change: (r: Extract<H1Outcome, { ok: true }>) => object): H1Builder =>
    (options) =>
      change(chatAgentH1(options) as Extract<H1Outcome, { ok: true }>) as H1Outcome;
  it.each([
    ["another H1 refusal", (() => ({ ok: false, code: "NO_WORK" })) as H1Builder, "h1_refused"],
    ["a throwing H1", throwing, "h1_unavailable"],
    ["a malformed H1 result", (() => ({ text: "x" })) as unknown as H1Builder, "h1_unavailable"],
    ["other text", withResult((r) => ({ ...r, text: "other" })), "task_mismatch"],
    [
      "a second message",
      withResult((r) => ({ ...r, messages: [...r.messages, { role: "user", content: "x" }] })),
      "task_mismatch"
    ],
    [
      "another system instruction",
      withResult((r) => ({ ...r, systemInstruction: "other" })),
      "task_mismatch"
    ]
  ])("refuses %s", (_label, h1, code) => {
    expect(codeOf(() => composeHandoff(goldenInput({ h1 })))).toBe(code);
  });
});

describe("view identity, caching and effects", () => {
  it("changes the view digest with every bound input", () => {
    const allow = policy("policy-allow.json");
    const extraRule = {
      id: "extra",
      action: "source_read" as const,
      match: { kind: "none" },
      allow: false
    };
    const digests = [
      composeHandoff(goldenInput()),
      composeHandoff(goldenInput({ policy: { ...allow, principal: "lead-2" } })),
      composeHandoff(goldenInput({ policy: { ...allow, rules: [...allow.rules, extraRule] } })),
      composeHandoff(goldenInput({ policy: policy("policy-deny.json") })),
      composeHandoff(
        goldenInput({ destination: request("request-wrong-destination.json").destination })
      ),
      composeHandoff(
        goldenInput({
          retriever: ((p: Record<string, unknown>) => ({
            pointer: p,
            bytes: "different",
            basis: {}
          })) as Retriever
        })
      )
    ].map((c) => c.viewDigest);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("caches nothing: each composition re-runs retrieval and H1", () => {
    const retriever = recordedRetriever();
    const { h1, calls } = recordingH1();
    const first = composeHandoff(goldenInput({ retriever, h1 }));
    const second = composeHandoff(goldenInput({ retriever, h1 }));
    expect(second.part).toBe(first.part);
    expect(retriever.calls).toBe(4);
    expect(calls).toHaveLength(2);
  });

  it("uses the snapshot as validated, even if the caller changes it during composition", () => {
    const fresh = goldenFresh();
    const pending = [...fresh.pending];
    const expected = viewOf(composeHandoff(goldenInput())).mandatory.revalidation;
    const recorded = recordedRetriever();
    const c = composeHandoff(
      goldenInput({
        fresh: { ...fresh, pending },
        retriever: ((p: Record<string, unknown>) => {
          pending.push({ injected: true });
          return recorded(p);
        }) as Retriever
      })
    );
    expect(viewOf(c).mandatory.revalidation).toEqual(expected);
  });

  it("refuses a host float it cannot spell as Python would", () => {
    const allow = policy("policy-allow.json");
    const rules = [{ ...allow.rules[0], match: { seq: 1.5 } }, ...allow.rules.slice(1)];
    expect(codeOf(() => composeHandoff(goldenInput({ policy: { ...allow, rules } })))).toBe(
      "codec_unsupported"
    );
    expect(
      codeOf(() => composeHandoff(goldenInput({ fresh: { ...goldenFresh(), basis: { at: 0.5 } } })))
    ).toBe("codec_unsupported");
  });

  it("leaves every input unchanged", () => {
    const input = goldenInput();
    const snapshot = () =>
      structuredClone({
        delivery: input.delivery,
        fresh: input.fresh,
        policy: input.policy,
        wanted: input.wanted
      });
    const before = snapshot();
    composeHandoff(input);
    expect(snapshot()).toEqual(before);
  });
});

describe("host inputs (review 1458)", () => {
  const decisionsOf = (c: { part: string }) =>
    (
      viewOf(c).optional as {
        kind: string;
        decisions?: { action: string; rule: string | null; allow: boolean }[];
      }[]
    ).find((i) => i.kind === "import")!.decisions!;

  it("matches a null rule value against a missing target key, as target.get does", () => {
    const allow = policy("policy-allow.json");
    const rules = [
      {
        id: "absent-is-null",
        action: "source_read" as const,
        match: { absent: null },
        allow: true
      },
      ...allow.rules
    ];
    const c = composeHandoff(goldenInput({ policy: { ...allow, rules } }));
    expect(decisionsOf(c)[0]).toMatchObject({ rule: "absent-is-null", allow: true });
  });

  it.each([
    ["a boolean", true],
    ["a float", 1.5],
    ["a container", { nested: "x" }],
    ["an array", ["x"]]
  ])("refuses %s rule match value as an explicit unsupported boundary", (_label, value) => {
    const allow = policy("policy-allow.json");
    const rules = [{ ...allow.rules[0], match: { kind: value } }, ...allow.rules.slice(1)];
    expect(
      codeOf(() => composeHandoff(goldenInput({ policy: { ...allow, rules } as ImportPolicy })))
    ).toBe("codec_unsupported");
  });

  it("refuses a policy it cannot copy", () => {
    const allow = policy("policy-allow.json");
    const rules = [{ ...allow.rules[0], match: { kind: () => "x" } }];
    expect(
      codeOf(() => composeHandoff(goldenInput({ policy: { ...allow, rules } as never })))
    ).toBe("codec_unsupported");
  });

  it.each([
    ["the destination", { destination: "conv-\ud800" }],
    ["the principal", { policy: { ...policy("policy-allow.json"), principal: "lead-\udc00" } }],
    ["a snapshot basis key", { fresh: { ...goldenFresh(), basis: { "\ud83d": 1 } } }],
    [
      "retrieved text",
      {
        retriever: ((p: Record<string, unknown>) => ({
          pointer: p,
          bytes: "text \ud800"
        })) as Retriever
      }
    ]
  ])("refuses a lone surrogate in %s before spelling or hashing it", (_label, over) => {
    expect(codeOf(() => composeHandoff(goldenInput(over as Partial<ComposeInput>)))).toBe(
      "codec_unsupported"
    );
  });

  it("keeps a valid surrogate pair", () => {
    const c = composeHandoff(goldenInput({ destination: "conv-\u{1f600}" }));
    expect(viewOf(c).destination).toBe("conv-\u{1f600}");
  });

  it("decides on the inputs as given, even if a callback changes them midway", () => {
    const baseline = composeHandoff(goldenInput());
    const input = goldenInput();
    const recorded = recordedRetriever();
    const mutable = { ...input, policy: structuredClone(input.policy), wanted: [...input.wanted!] };
    const c = composeHandoff({
      ...mutable,
      retriever: ((p: Record<string, unknown>) => {
        // A callback rewriting the caller's objects after composition began.
        (mutable.policy.rules as PolicyRule[]).length = 0;
        mutable.policy.principal = "someone-else";
        (mutable.wanted as unknown[]).push({ seq: 1, kind: "binding" });
        return recorded(p);
      }) as Retriever
    });
    expect(c.part).toBe(baseline.part);
  });
});

describe("review 1461 boundaries", () => {
  const allow = () => policy("policy-allow.json");

  it.each([
    ["a string allow", (p: ImportPolicy) => ({ ...p, rules: [{ ...p.rules[0], allow: "false" }] })],
    ["a missing principal", (p: ImportPolicy) => ({ rules: p.rules })],
    [
      "an unknown action",
      (p: ImportPolicy) => ({ ...p, rules: [{ ...p.rules[0], action: "read" }] })
    ],
    ["a numeric rule id", (p: ImportPolicy) => ({ ...p, rules: [{ ...p.rules[0], id: 1 }] })],
    ["an array match", (p: ImportPolicy) => ({ ...p, rules: [{ ...p.rules[0], match: [] }] })],
    ["non-array rules", (p: ImportPolicy) => ({ ...p, rules: {} })]
  ])("refuses a policy with %s before any callback, coercing nothing", (_label, change) => {
    const retriever = recordedRetriever();
    const code = codeOf(() =>
      composeHandoff(goldenInput({ policy: change(allow()) as never, retriever }))
    );
    expect(code).toBe("policy_invalid");
    expect(retriever.calls).toBe(0);
  });

  it("refuses a non-string destination as request_invalid", () => {
    expect(codeOf(() => composeHandoff(goldenInput({ destination: 7 as never })))).toBe(
      "request_invalid"
    );
  });

  it("keeps the reference order: an invalid delivery is refused before an invalid policy", () => {
    const delivery = goldenDelivery();
    const bad = { ...allow(), rules: [{ ...allow().rules[0], allow: "false" }] } as never;
    expect(
      codeOf(() =>
        composeHandoff(
          goldenInput({ delivery: { ...delivery, candidateDigest: "0".repeat(64) }, policy: bad })
        )
      )
    ).toBe("digest_mismatch");
    expect(
      codeOf(() =>
        composeHandoff(goldenInput({ delivery: { ...delivery, codec: "other" }, policy: bad }))
      )
    ).toBe("codec_unsupported");
  });

  it.each([
    ["a null message", (r: Record<string, unknown>) => ({ ...r, messages: [null] })],
    ["a non-array message list", (r: Record<string, unknown>) => ({ ...r, messages: "x" })],
    ["a sparse message list", (r: Record<string, unknown>) => ({ ...r, messages: new Array(1) })],
    [
      "missing role instructions",
      (r: Record<string, unknown>) => ({ ...r, roleInstructions: null })
    ]
  ])("refuses an H1 result with %s as task_mismatch, never a TypeError", (_label, change) => {
    const h1: H1Builder = (o) => change(chatAgentH1(o) as never) as unknown as H1Outcome;
    expect(codeOf(() => composeHandoff(goldenInput({ h1 })))).toBe("task_mismatch");
  });

  it("refuses an H1 result whose accessor throws as h1_unavailable", () => {
    const h1: H1Builder = (o) => {
      const r = chatAgentH1(o);
      return Object.defineProperty({ ...r }, "text", {
        get: () => {
          throw new Error("private");
        }
      }) as H1Outcome;
    };
    expect(codeOf(() => composeHandoff(goldenInput({ h1 })))).toBe("h1_unavailable");
  });

  it("detaches the bound H1 result from the builder's object", () => {
    let retained: { text: string; messages: { content: string }[] } | undefined;
    const h1: H1Builder = (o) => {
      const r = chatAgentH1(o) as Extract<H1Outcome, { ok: true }>;
      retained = { ...r, messages: r.messages.map((m) => ({ ...m })) };
      return retained as unknown as H1Outcome;
    };
    const c = composeHandoff(goldenInput({ h1 }));
    const text = c.h1.text;
    retained!.text = "changed";
    retained!.messages[0].content = "changed";
    expect(c.h1.text).toBe(text);
    expect(c.h1.messages[0].content).toBe(text);
    expect(Object.isFrozen(c.h1) && Object.isFrozen(c.h1.messages[0])).toBe(true);
  });

  it("reads a retrieval result once, so a getter cannot hand over other bytes", () => {
    const recorded = recordedRetriever();
    const retriever = ((p: Record<string, unknown>) => {
      let reads = 0;
      const result = recorded(p) as unknown as { pointer: unknown; bytes: string; basis: unknown };
      return {
        pointer: result.pointer,
        basis: result.basis,
        get bytes() {
          return reads++ === 0 ? result.bytes : "swapped";
        }
      };
    }) as Retriever;
    const c = composeHandoff(goldenInput({ retriever }));
    const included = optional(c).filter((i) => i.kind === "retrieval" && i.status === "included");
    expect(included).toHaveLength(2);
    expect(c.part).not.toContain("swapped");
    for (const item of included as unknown as { sha256: string; text: string }[])
      expect(item.sha256).toBe(sha(item.text));
  });

  it("stops after 16 retrieval calls and marks the rest unavailable for the cap", () => {
    const extra = Array.from(
      { length: 18 },
      (_, i) =>
        `{"kind":"binding","linkId":"00000000-0000-4000-8000-${String(i).padStart(12, "0")}","seq":${100 + i}}`
    );
    const changed = withManifest((m) =>
      m.replace('"evidenceIndex":[', () => `"evidenceIndex":[${extra.join(",")},`)
    );
    let calls = 0;
    const retriever = ((p: Record<string, unknown>) => {
      calls++;
      return { pointer: p, bytes: "x", basis: {} };
    }) as Retriever;
    const wanted = Array.from({ length: 18 }, (_, i) => ({ seq: 100 + i, kind: "binding" }));
    const c = composeHandoff(goldenInput({ ...changed, wanted, retriever }));
    expect(calls).toBe(16);
    const retrievals = optional(c).filter((i) => i.kind === "retrieval");
    expect(retrievals.slice(0, 16).every((i) => i.status === "included")).toBe(true);
    expect(retrievals.slice(16).map((i) => [i.status, i.reason])).toEqual([
      ["unavailable", "cap"],
      ["unavailable", "cap"]
    ]);
  });
});
