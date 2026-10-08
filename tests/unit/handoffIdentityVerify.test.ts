import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  verifyDelivery,
  verifyHandoffDelivery,
  type FreshSnapshot,
  type HandoffDelivery
} from "../../src/integrations/hekate/handoffConsumer/delivery";
import { sha256Hex } from "../../src/integrations/hekate/handoffConsumer/exactJson";

// CA-ISSUE-013 acceptance oracle: a delivery whose manifest review identity lacks a
// required field (rootId, nodeId, attemptId, attemptEpoch, artifactRef), or is not an
// object, is refused AT VERIFICATION with delivery_mismatch, as the revised Python
// reference consumer does (Hekate HK-ISSUE-002, consumer aea15fa4). Each malformed
// delivery is fully re-signed (manifest digest, receipt and candidate digest), so only
// the identity differs. Extra identity fields stay accepted, as in the reference.
const GOLDEN = "tests/fixtures/hekate/e2e-consumer-v0";
const REQUIRED = ["rootId", "nodeId", "attemptId", "attemptEpoch", "artifactRef"] as const;

const bytes = (path: string) => new Uint8Array(readFileSync(join(GOLDEN, path)));
const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

function golden(): { delivery: HandoffDelivery; fresh: FreshSnapshot } {
  const wrapper = JSON.parse(text(bytes("delivery/wrapper.json")));
  const f = JSON.parse(text(bytes("inputs/fresh.json")));
  return {
    delivery: {
      wrapper: wrapper.wrapper,
      codec: wrapper.codec,
      candidateDigest: wrapper.candidateDigest,
      manifest: bytes("delivery/manifest.bin"),
      envelope: bytes("delivery/envelope.bin"),
      task: bytes("delivery/task.bin"),
      receipt: bytes("delivery/receipt.json"),
      h1Input: bytes("delivery/h1-input.json")
    },
    fresh: {
      candidateDigest: f.candidate_digest,
      recordId: f.record_id,
      reviewIdentity: {
        ...f.review_identity,
        attemptEpoch: BigInt(f.review_identity.attemptEpoch)
      },
      packageRef: f.package_ref,
      receiptStatus: f.receipt_status,
      currentBinding: f.current_binding,
      reviewClass: f.review_class,
      pinsProblem: f.pins_problem,
      pending: f.pending,
      queue: f.queue,
      basis: f.basis
    }
  };
}

/** The manifest's canonical identity object text, which holds no nested object. */
const IDENTITY = /"identity":(\{[^{}]*\})/;

/**
 * Replace the identity object's canonical text, then re-sign everything that binds the
 * manifest: the envelope embeds the manifest bytes verbatim, and the receipt, wrapper
 * and as-of proof carry its digest.
 */
function withIdentity(rewrite: (identityText: string) => string) {
  const g = golden();
  const manifest = text(g.delivery.manifest);
  const found = IDENTITY.exec(manifest);
  expect(found, "the golden manifest carries a flat identity object").not.toBeNull();
  const next = manifest.replace(IDENTITY, `"identity":${rewrite(found![1])}`);
  expect(next).not.toBe(manifest);
  const envelope = text(g.delivery.envelope);
  expect(envelope.split(manifest).length, "the envelope embeds the manifest once").toBe(2);
  g.delivery.envelope = utf8(envelope.replace(manifest, next));
  const old = g.delivery.candidateDigest;
  g.delivery.manifest = utf8(next);
  const digest = sha256Hex(g.delivery.manifest);
  g.delivery.receipt = utf8(text(g.delivery.receipt).replace(old, digest));
  g.delivery.candidateDigest = digest;
  g.fresh = { ...g.fresh, candidateDigest: digest };
  return g;
}

/** Drop one key from the canonical identity object, keeping canonical form. */
const without = (key: string) => (identity: string) => {
  const members = identity.slice(1, -1).split(/,(?=")/);
  const kept = members.filter((m) => !m.startsWith(`"${key}":`));
  expect(kept.length, `the golden identity carries ${key}`).toBe(members.length - 1);
  return `{${kept.join(",")}}`;
};

const outcome = (run: () => unknown) => {
  try {
    run();
    return "verified";
  } catch (error) {
    return (error as { code?: string }).code ?? `threw ${String(error)}`;
  }
};

describe("a missing required review identity field is refused at verification", () => {
  it.each(REQUIRED)("refuses a re-signed delivery without %s as delivery_mismatch", (key) => {
    const g = withIdentity(without(key));
    expect(outcome(() => verifyDelivery(g.delivery))).toBe("delivery_mismatch");
  });

  it.each(REQUIRED)("reports delivery_mismatch through verifyHandoffDelivery without %s", (key) => {
    const g = withIdentity(without(key));
    expect(outcome(() => verifyHandoffDelivery(g.delivery, g.fresh))).toBe("delivery_mismatch");
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"identity"']
  ])("refuses an identity that is %s as delivery_mismatch", (_label, value) => {
    const g = withIdentity(() => value);
    expect(outcome(() => verifyDelivery(g.delivery))).toBe("delivery_mismatch");
  });
});

describe("controls: valid identities still verify", () => {
  it("verifies the unchanged golden delivery", () => {
    const g = golden();
    expect(outcome(() => verifyDelivery(g.delivery))).toBe("verified");
    expect(outcome(() => verifyHandoffDelivery(g.delivery, g.fresh))).toBe("verified");
  });

  it("verifies a re-signed delivery without the optional lead field", () => {
    const g = withIdentity(without("lead"));
    expect(outcome(() => verifyDelivery(g.delivery))).toBe("verified");
    expect(outcome(() => verifyHandoffDelivery(g.delivery, g.fresh))).toBe("verified");
  });

  it("verifies a re-signed delivery whose artifactRef is present but null", () => {
    // Presence is the requirement, as in the reference's review_identity; values are
    // not re-specified here (how revalidation compares a null value is out of scope).
    const g = withIdentity((identity) =>
      identity.replace(/"artifactRef":"[^"]*"/, '"artifactRef":null')
    );
    expect(outcome(() => verifyDelivery(g.delivery))).toBe("verified");
  });

  it("verifies a re-signed delivery with an extra identity field", () => {
    const g = withIdentity((identity) => `${identity.slice(0, -1)},"zz":1}`);
    expect(outcome(() => verifyDelivery(g.delivery))).toBe("verified");
    expect(outcome(() => verifyHandoffDelivery(g.delivery, g.fresh))).toBe("verified");
  });
});
