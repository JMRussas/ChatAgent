import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  member,
  readExactJson,
  sha256Hex
} from "../../src/integrations/hekate/handoffConsumer/exactJson";
import {
  DeliveryRefusal,
  verifyDelivery,
  verifyHandoffDelivery,
  type FreshSnapshot,
  type HandoffDelivery
} from "../../src/integrations/hekate/handoffConsumer/delivery";

// The verification stage of the offline handoff consumer (Hekate plan 034 rev 3)
// against the accepted golden bundle and the reviewed byte-compatibility supplement.
// Composition (policy, retrieval, view, H1) is a later stage and is not run here.
const GOLDEN = "tests/fixtures/hekate/e2e-consumer-v0";
const SUPPLEMENT = "tests/fixtures/hekate/e2e-byte-compat-v0";

type Field = "manifest" | "envelope" | "task" | "receipt" | "h1Input";
interface Inputs {
  delivery: HandoffDelivery;
  /** The as-of proof in its snake_case fixture form; converted when used. */
  fresh: Record<string, unknown>;
  /** attemptEpoch read losslessly from the fixture bytes. */
  attemptEpoch: bigint;
}

const bytes = (path: string) => new Uint8Array(readFileSync(path));
const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

function load(files: Record<Field | "wrapper" | "fresh", string>): Inputs {
  const wrapper = JSON.parse(readFileSync(files.wrapper, "utf8"));
  const freshBytes = bytes(files.fresh);
  const identity = member(
    readExactJson(freshBytes, { maxBytes: 1 << 20 }).root as never,
    "review_identity"
  );
  const epoch = member(identity as never, "attemptEpoch") as { lexeme: string };
  return {
    delivery: {
      wrapper: wrapper.wrapper,
      codec: wrapper.codec,
      candidateDigest: wrapper.candidateDigest,
      manifest: bytes(files.manifest),
      envelope: bytes(files.envelope),
      task: bytes(files.task),
      receipt: bytes(files.receipt),
      h1Input: bytes(files.h1Input)
    },
    fresh: JSON.parse(text(freshBytes)),
    attemptEpoch: BigInt(epoch.lexeme)
  };
}
const golden = () =>
  load({
    manifest: join(GOLDEN, "delivery/manifest.bin"),
    envelope: join(GOLDEN, "delivery/envelope.bin"),
    task: join(GOLDEN, "delivery/task.bin"),
    receipt: join(GOLDEN, "delivery/receipt.json"),
    h1Input: join(GOLDEN, "delivery/h1-input.json"),
    wrapper: join(GOLDEN, "delivery/wrapper.json"),
    fresh: join(GOLDEN, "inputs/fresh.json")
  });
const supplement = (name: string) => {
  const dir = join(SUPPLEMENT, "deliveries", name);
  return load({
    manifest: join(dir, "manifest.bin"),
    envelope: join(dir, "envelope.bin"),
    task: join(dir, "task.bin"),
    receipt: join(dir, "receipt.json"),
    h1Input: join(dir, "h1-input.json"),
    wrapper: join(dir, "wrapper.json"),
    fresh: join(dir, "fresh.json")
  });
};

function freshOf(inputs: Inputs): FreshSnapshot {
  const f = inputs.fresh as Record<string, never>;
  const identity = f.review_identity as Record<string, string>;
  return {
    candidateDigest: f.candidate_digest,
    recordId: f.record_id,
    reviewIdentity: {
      rootId: identity.rootId,
      nodeId: identity.nodeId,
      attemptId: identity.attemptId,
      attemptEpoch: inputs.attemptEpoch,
      artifactRef: identity.artifactRef
    },
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

/** The fixtures' mutation instructions (bundle replay.py semantics). */
function mutate(inputs: Inputs, m: Record<string, unknown>, base: string): Inputs {
  const next: Inputs = structuredClone(inputs);
  const d = next.delivery;
  const target = m.target as string;
  switch (m.op) {
    case "replace": {
      const field = target as Field;
      const before = text(d[field]);
      expect(before).toContain(m.find as string);
      d[field] = utf8(before.replace(m.find as string, () => m.with as string));
      break;
    }
    case "raw":
      d[target as Field] = utf8(m.with as string);
      break;
    case "field":
      (d as unknown as Record<string, string>)[target] = m.with as string;
      break;
    case "file":
      d[target as Field] = bytes(join(base, m.path as string));
      break;
    case "redigest": {
      const digest = sha256Hex(d.manifest);
      d.receipt = utf8(text(d.receipt).replace(d.candidateDigest, digest));
      d.candidateDigest = digest;
      next.fresh.candidate_digest = digest;
      break;
    }
    case "set": {
      const keys = m.path as string[];
      if (target === "fresh" || target === "h1Input") {
        const doc = target === "fresh" ? next.fresh : JSON.parse(text(d.h1Input));
        let at = doc;
        for (const key of keys.slice(0, -1)) at = at[key];
        at[keys.at(-1)!] = m.value;
        if (target === "h1Input") d.h1Input = utf8(JSON.stringify(doc));
      }
      // policy and request belong to composition, not verification.
      break;
    }
    case "policyFile":
    case "requestFile":
      break;
    default:
      throw new Error(`unknown mutation ${String(m.op)}`);
  }
  return next;
}

function outcome(inputs: Inputs) {
  try {
    verifyHandoffDelivery(inputs.delivery, freshOf(inputs));
    return "verified";
  } catch (error) {
    if (error instanceof DeliveryRefusal) return error.code;
    throw error;
  }
}

/** Refusals decided at composition (after verification) pass this stage. */
const COMPOSITION_CODES = new Set(["CONTEXT_TOO_LARGE"]);
const verificationOutcome = (expected: { outcome: string; code?: string }) =>
  expected.outcome === "composed" || COMPOSITION_CODES.has(expected.code!)
    ? "verified"
    : expected.code;

describe("golden bundle e2e-consumer-v0", () => {
  const variants: { name: string; mutations?: Record<string, unknown>[]; expect: never }[] =
    JSON.parse(readFileSync(join(GOLDEN, "variants.json"), "utf8"));

  it("verifies the accepted delivery and binds its receipt, task and transition", () => {
    const inputs = golden();
    const v = verifyHandoffDelivery(inputs.delivery, freshOf(inputs));
    expect(v.candidateDigest).toBe(sha256Hex(inputs.delivery.manifest));
    expect(v.receipt.candidateDigest).toBe(v.candidateDigest);
    expect(v.task.text).toBe(readFileSync(join(GOLDEN, "expected/h1-text.txt"), "utf8"));
    expect(v.transition.linkId).toBe(v.receipt.bindingLinkId);
    expect(v.revalidation).toMatchObject({ asOf: "revalidation", queue: [] });
    expect(v.revalidation.pending).toHaveLength(1);
    expect(Object.isFrozen(v)).toBe(true);
  });

  it.each(variants.map((v) => [v.name, v] as const))("%s", (_name, variant) => {
    let inputs = golden();
    for (const m of variant.mutations ?? []) inputs = mutate(inputs, m, GOLDEN);
    expect(outcome(inputs)).toBe(verificationOutcome(variant.expect));
  });
});

describe("byte-compatibility supplement e2e-byte-compat-v0", () => {
  const variants: {
    name: string;
    delivery: string;
    mutations?: Record<string, unknown>[];
    expect: never;
  }[] = JSON.parse(readFileSync(join(SUPPLEMENT, "variants.json"), "utf8"));

  it("covers all 18 reviewed cases", () => {
    expect(variants).toHaveLength(18);
  });

  it.each(variants.map((v) => [v.name, v] as const))("%s", (_name, variant) => {
    let inputs = supplement(variant.delivery);
    for (const m of variant.mutations ?? []) inputs = mutate(inputs, m, SUPPLEMENT);
    expect(outcome(inputs)).toBe(verificationOutcome(variant.expect));
  });

  it("keeps an event sequence beyond 2^53 exact and the receipt seq as a bigint", () => {
    const inputs = supplement("eventseq-beyond-2^53");
    const v = verifyHandoffDelivery(inputs.delivery, freshOf(inputs));
    expect(text(v.manifest.bytes())).toContain("9007199254740993");
    expect(typeof v.receipt.seq).toBe("bigint");
  });
});

// Structural cases for codes and ordering the fixtures do not isolate. Each starts
// from the golden delivery and changes one thing (or two, to show which comes first).
const MANIFEST_OPEN = '{"manifest":';
/** Rebuilds a delivery around new manifest text: envelope, digests and proof follow. */
function withManifest(inputs: Inputs, manifest: string, task?: string): Inputs {
  const next = structuredClone(inputs);
  const d = next.delivery;
  const old = text(d.manifest);
  const envelope = text(d.envelope);
  expect(envelope.startsWith(MANIFEST_OPEN + old)).toBe(true);
  d.envelope = utf8(MANIFEST_OPEN + manifest + envelope.slice(MANIFEST_OPEN.length + old.length));
  d.manifest = utf8(manifest);
  if (task !== undefined) d.task = utf8(task);
  const digest = sha256Hex(d.manifest);
  d.receipt = utf8(text(d.receipt).replace(d.candidateDigest, digest));
  d.candidateDigest = digest;
  next.fresh.candidate_digest = digest;
  return next;
}
const setH1 = (inputs: Inputs, change: (h1: Record<string, never>) => void) => {
  const next = structuredClone(inputs);
  const h1 = JSON.parse(text(next.delivery.h1Input));
  change(h1);
  next.delivery.h1Input = utf8(JSON.stringify(h1));
  return next;
};
const setReceipt = (inputs: Inputs, receipt: string) => {
  const next = structuredClone(inputs);
  next.delivery.receipt = utf8(receipt);
  return next;
};
const receiptOf = (inputs: Inputs) => JSON.parse(text(inputs.delivery.receipt));

describe("ingress, wrapper and receipt", () => {
  it("checks the whole wrapper first, then each field, before reading anything", () => {
    const inputs = golden();
    const huge = structuredClone(inputs);
    huge.delivery.task = new Uint8Array(1 << 20);
    huge.delivery.envelope = new Uint8Array(1 << 20);
    huge.delivery.manifest = new Uint8Array(1 << 20);
    huge.delivery.h1Input = new Uint8Array(1_572_864);
    huge.delivery.codec = "other";
    expect(outcome(huge)).toBe("ingress_too_large");
    const field = structuredClone(inputs);
    field.delivery.receipt = new Uint8Array(4097);
    field.delivery.codec = "other";
    expect(outcome(field)).toBe("ingress_too_large");
  });

  it("refuses another wrapper or codec before reading the receipt", () => {
    const inputs = setReceipt(golden(), "{");
    inputs.delivery.wrapper = "handoff-delivery.v1";
    expect(outcome(inputs)).toBe("codec_unsupported");
  });

  it("reads the receipt strictly before comparing any digest", () => {
    const inputs = setReceipt(golden(), '{"seq":1,"seq":2}');
    inputs.delivery.candidateDigest = "0".repeat(64);
    expect(outcome(inputs)).toBe("strict_json");
  });

  it.each([
    ["an extra field", (r: Record<string, unknown>) => (r.extra = "x")],
    ["a missing field", (r: Record<string, unknown>) => delete r.recordHash],
    ["seq as a float", (r: Record<string, unknown>) => (r.seq = 1.5)],
    ["seq zero", (r: Record<string, unknown>) => (r.seq = 0)],
    ["seq as a boolean", (r: Record<string, unknown>) => (r.seq = true)],
    [
      "an uppercase id",
      (r: Record<string, unknown>) => (r.recordId = String(r.recordId).toUpperCase())
    ],
    ["a short hash", (r: Record<string, unknown>) => (r.recordHash = "abc")]
  ])("refuses a receipt with %s", (_label, change) => {
    const inputs = golden();
    const receipt = receiptOf(inputs);
    change(receipt);
    expect(outcome(setReceipt(inputs, JSON.stringify(receipt)))).toBe("receipt_shape");
  });

  it("keeps a receipt seq beyond 2^53 exact", () => {
    const inputs = golden();
    const receipt = text(inputs.delivery.receipt).replace(
      /"seq":\s*\d+/,
      '"seq": 9223372036854775807'
    );
    const v = verifyDelivery(setReceipt(inputs, receipt).delivery);
    expect(v.receipt.seq).toBe(9223372036854775807n);
  });

  it("refuses a digest mismatch before parsing the manifest", () => {
    const inputs = structuredClone(golden());
    inputs.delivery.manifest = utf8("{");
    expect(outcome(inputs)).toBe("digest_mismatch");
    const other = golden();
    other.delivery.candidateDigest = "0".repeat(64);
    expect(outcome(other)).toBe("digest_mismatch");
  });

  it("refuses a receipt naming another transition", () => {
    const inputs = golden();
    const receipt = receiptOf(inputs);
    receipt.handoffId = "00000000-0000-4000-8000-000000000000";
    expect(outcome(setReceipt(inputs, JSON.stringify(receipt)))).toBe("receipt_mismatch");
  });
});

describe("strict reading and host boundaries", () => {
  it("refuses an integer longer than Python reads as strict_json", () => {
    const inputs = golden();
    const at = (digits: number) =>
      outcome(
        withManifest(
          inputs,
          text(inputs.delivery.manifest).replace(/^\{/, `{"!":${"9".repeat(digits)},`)
        )
      );
    expect(at(4301)).toBe("strict_json");
    // Within Python's limit it is read exactly, and the manifest's top-level keys are
    // not closed (as in the reference), so the delivery verifies.
    expect(at(4300)).toBe("verified");
  });

  it("reads a very wide array without exhausting the call stack", () => {
    const inputs = golden();
    const next = structuredClone(inputs);
    next.delivery.manifest = utf8("[" + Array(300_000).fill("0").join(",") + "]");
    const digest = sha256Hex(next.delivery.manifest);
    next.delivery.receipt = utf8(
      text(next.delivery.receipt).replace(next.delivery.candidateDigest, digest)
    );
    next.delivery.candidateDigest = digest;
    expect(outcome(next)).toBe("delivery_mismatch");
  });

  it("refuses a non-finite float as strict_json", () => {
    const inputs = golden();
    expect(
      outcome(withManifest(inputs, text(inputs.delivery.manifest).replace(/^\{/, '{"!":1e999,')))
    ).toBe("strict_json");
  });

  it.each([
    ["nesting deeper than the host reads", "[".repeat(65) + "]".repeat(65), "DEPTH"],
    ["a __proto__ key", '{"__proto__":1}', "KEY"]
  ])("reports %s as unsupported, not invalid", (_label, manifest, reason) => {
    const inputs = golden();
    const next = structuredClone(inputs);
    next.delivery.manifest = utf8(manifest);
    const digest = sha256Hex(next.delivery.manifest);
    next.delivery.receipt = utf8(
      text(next.delivery.receipt).replace(next.delivery.candidateDigest, digest)
    );
    next.delivery.candidateDigest = digest;
    try {
      verifyDelivery(next.delivery);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "codec_unsupported", reason });
    }
  });

  it("reports a float outside the supported subset as unsupported", () => {
    const inputs = supplement("clock-subnormal");
    const manifest = text(inputs.delivery.manifest);
    expect(manifest).toContain('"at":1.0');
    try {
      verifyDelivery(withManifest(inputs, manifest.replace('"at":1.0', '"at":1e+16')).delivery);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "codec_unsupported", reason: "NUMBER" });
    }
  });
});

describe("H1 options", () => {
  it.each([
    ["an unknown option", (h: Record<string, unknown>) => (h.extra = 1), "h1_input"],
    ["a missing option", (h: Record<string, unknown>) => delete h.capturedAtIso, "h1_input"],
    [
      "a fractional budget",
      (h: Record<string, Record<string, unknown>>) => (h.budget.safetyTokens = 1.5),
      "h1_input"
    ],
    [
      "a negative budget",
      (h: Record<string, Record<string, unknown>>) => (h.budget.safetyTokens = -1),
      "h1_input"
    ],
    [
      "a budget beyond 2^53 - 1",
      (h: Record<string, Record<string, unknown>>) => (h.budget.windowTokens = 2 ** 53),
      "h1_input"
    ],
    [
      "an extra role",
      (h: Record<string, Record<string, unknown>>) => (h.roleInstructions.other = "x"),
      "h1_input"
    ],
    ["a non-string rule value", (h: Record<string, unknown>) => (h.rules = [{ a: 1 }]), "h1_input"],
    [
      "a non-string response",
      (h: Record<string, unknown>) => (h.response = 1),
      "ingress_too_large"
    ],
    [
      "33 rules",
      (h: Record<string, unknown>) => (h.rules = Array.from({ length: 33 }, () => ({}))),
      "ingress_too_large"
    ],
    [
      "an instruction over 64 KiB",
      (h: Record<string, unknown>) => (h.systemInstruction = "x".repeat(65537)),
      "ingress_too_large"
    ]
  ])("refuses %s", (_label, change, code) => {
    expect(outcome(setH1(golden(), change as never))).toBe(code);
  });

  it("binds the H1 instructions to the committed task last", () => {
    const changed = setH1(golden(), (h: Record<string, Record<string, string>>) => {
      h.roleInstructions.fast = "different";
    });
    expect(outcome(changed)).toBe("task_mismatch");
    // Every earlier revalidation refusal comes first.
    changed.fresh.review_class = "decided";
    expect(outcome(changed)).toBe("review_not_candidate");
  });
});

describe("delivered content and revalidation", () => {
  it("refuses a delivery whose decoded content exceeds the 032 caps", () => {
    const inputs = golden();
    const task = JSON.parse(text(inputs.delivery.task));
    const long = "x".repeat(70_000);
    // The text digest also appears inside packageRef: every occurrence follows the text.
    const [from, to] = [sha256Hex(utf8(task.text)), sha256Hex(utf8(long))];
    const manifest = text(inputs.delivery.manifest).split(from).join(to);
    const taskBytes = text(inputs.delivery.task)
      .split(from)
      .join(to)
      .replace(JSON.stringify(task.text).slice(1, -1), () => long);
    expect(outcome(withManifest(inputs, manifest, taskBytes))).toBe("delivery_overflow");
  });

  it.each([
    ["a different attempt epoch", (f: FreshSnapshot) => (f.reviewIdentity.attemptEpoch += 1n)],
    [
      "a numeric attempt epoch",
      (f: FreshSnapshot) => ((f.reviewIdentity as { attemptEpoch: unknown }).attemptEpoch = 1)
    ],
    ["another package", (f: FreshSnapshot) => (f.packageRef = "{}")],
    ["another record", (f: FreshSnapshot) => (f.recordId = "00000000-0000-4000-8000-000000000000")],
    [
      "an extra identity field",
      (f: FreshSnapshot) => ((f.reviewIdentity as Record<string, unknown>).extra = "x")
    ]
  ])("refuses a proof with %s as fresh_mismatch", (_label, change) => {
    const inputs = golden();
    const v = verifyDelivery(inputs.delivery);
    const fresh = freshOf(inputs);
    change(fresh);
    expect(() => verifyHandoffDelivery(inputs.delivery, fresh)).toThrow(
      expect.objectContaining({ code: "fresh_mismatch" })
    );
    expect(v.candidateDigest).toBe(inputs.delivery.candidateDigest);
  });

  it("compares five identity fields: extra manifest fields are kept, missing ones refuse", () => {
    const inputs = golden();
    const manifest = text(inputs.delivery.manifest);
    const at = manifest.indexOf('"identity":{') + '"identity":{'.length;
    expect(manifest.slice(at)).toMatch(/^"artifactRef":"[^"]*",/);
    // The reference picks the five fields out of the manifest identity (which also
    // carries lead and leadSession), so another manifest field changes nothing.
    const extra = withManifest(
      inputs,
      manifest.slice(0, at) + '"aaExtra":"x",' + manifest.slice(at)
    );
    expect(outcome(extra)).toBe("verified");
    const field = /^"artifactRef":"[^"]*",/.exec(manifest.slice(at))![0];
    const missing = withManifest(inputs, manifest.slice(0, at) + manifest.slice(at + field.length));
    expect(outcome(missing)).toBe("fresh_mismatch");
  });

  it("refuses more than 256 uncertainty references, counting pending and queue", () => {
    const inputs = golden();
    const fresh = freshOf(inputs);
    fresh.pending = Array.from({ length: 200 }, () => ({}));
    fresh.queue = Array.from({ length: 56 }, () => "q");
    expect(() => verifyHandoffDelivery(inputs.delivery, fresh)).not.toThrow();
    fresh.queue = Array.from({ length: 57 }, () => "q");
    expect(() => verifyHandoffDelivery(inputs.delivery, fresh)).toThrow(
      expect.objectContaining({ code: "uncertainty_overflow" })
    );
  });
});

describe("no effects", () => {
  it("leaves its inputs unchanged and is unaffected by later changes to them", () => {
    const inputs = golden();
    const before = structuredClone(inputs.delivery);
    const v = verifyHandoffDelivery(inputs.delivery, freshOf(inputs));
    expect(inputs.delivery).toEqual(before);
    const manifest = v.manifest.bytes();
    inputs.delivery.manifest.fill(0);
    expect(v.manifest.bytes()).toEqual(manifest);
    expect(verifyHandoffDelivery(golden().delivery, freshOf(golden()))).toEqual(
      verifyHandoffDelivery(golden().delivery, freshOf(golden()))
    );
  });

  it("hashes and parses its own copy of a shared buffer", () => {
    const inputs = golden();
    const shared = new Uint8Array(new SharedArrayBuffer(inputs.delivery.manifest.byteLength));
    shared.set(inputs.delivery.manifest);
    const v = verifyDelivery({ ...inputs.delivery, manifest: shared });
    shared.fill(0x20);
    expect(v.manifest.sha256).toBe(inputs.delivery.candidateDigest);
    expect(sha256Hex(v.manifest.bytes())).toBe(inputs.delivery.candidateDigest);
  });

  it("copies with the intrinsic constructor, never a field's own slice()", () => {
    const inputs = golden();
    // A field whose slice() returns other bytes, as a shared view could after a change.
    class Tampering extends Uint8Array {
      slice(): Uint8Array<ArrayBuffer> {
        return utf8("{}") as Uint8Array<ArrayBuffer>;
      }
    }
    const fields = ["manifest", "envelope", "task", "receipt", "h1Input"] as const;
    const delivery = { ...inputs.delivery };
    for (const field of fields) delivery[field] = new Tampering(inputs.delivery[field]);
    expect(outcome({ ...inputs, delivery })).toBe("verified");
  });

  it("measures true byte lengths, so a field cannot under-report its size", () => {
    const inputs = golden();
    class Small extends Uint8Array {
      get byteLength() {
        return 1;
      }
    }
    const delivery = { ...inputs.delivery, task: new Small(2 * 1024 * 1024) };
    expect(outcome({ ...inputs, delivery })).toBe("ingress_too_large");
  });

  it("never coerces the wrapper, codec or digest text", () => {
    const inputs = golden();
    const disguised = (value: string) => ({ toString: () => value }) as unknown as string;
    for (const [field, code] of [
      ["wrapper", "codec_unsupported"],
      ["codec", "codec_unsupported"],
      ["candidateDigest", "digest_mismatch"]
    ] as const) {
      const delivery = { ...inputs.delivery, [field]: disguised(inputs.delivery[field]) };
      expect(outcome({ ...inputs, delivery })).toBe(code);
    }
  });

  it("accepts Node Buffers and keeps a private copy of them", () => {
    const inputs = golden();
    const manifest = Buffer.from(inputs.delivery.manifest);
    const v = verifyDelivery({
      ...inputs.delivery,
      manifest,
      receipt: Buffer.from(inputs.delivery.receipt)
    });
    manifest.fill(0x20);
    expect(v.manifest.sha256).toBe(inputs.delivery.candidateDigest);
    expect(sha256Hex(v.manifest.bytes())).toBe(inputs.delivery.candidateDigest);
  });

  it("reads each caller field once, so a later read cannot swap the bytes", () => {
    const inputs = golden();
    let reads = 0;
    const delivery = { ...inputs.delivery };
    Object.defineProperty(delivery, "manifest", {
      get: () => (reads++ === 0 ? inputs.delivery.manifest : utf8("{}"))
    });
    const v = verifyDelivery(delivery);
    expect(reads).toBe(1);
    expect(v.manifest.sha256).toBe(inputs.delivery.candidateDigest);
  });

  it("refuses with a code only, never input content", () => {
    const inputs = setReceipt(golden(), '{"secret-value":1}');
    try {
      verifyDelivery(inputs.delivery);
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secret");
    }
  });
});
