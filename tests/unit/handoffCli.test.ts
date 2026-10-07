import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readBounded,
  requestKey,
  runHandoffCompose,
  USAGE
} from "../../src/integrations/hekate/handoffConsumer/cli";
import { sha256Hex } from "../../src/integrations/hekate/handoffConsumer/exactJson";

// The offline operator CLI over the accepted handoff consumer, run in-process and
// once as a subprocess. Only temporary directories are written.
const GOLDEN = resolve("tests/fixtures/hekate/e2e-consumer-v0");
const SUPPLEMENT = resolve("tests/fixtures/hekate/e2e-byte-compat-v0");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-cli-"));
  dirs.push(dir);
  return dir;
};
const ALLOW = {
  principal: "lead-1",
  rules: [
    { id: "read-all", action: "source_read", match: {}, allow: true },
    { id: "use-all", action: "destination_use", match: {}, allow: true }
  ]
};

function run(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runHandoffCompose(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t)
  });
  return { code, stdout, stderr };
}
function goldenArgs(out: string, over: Record<string, string> = {}) {
  const flags: Record<string, string> = {
    "--delivery": join(GOLDEN, "delivery"),
    "--fresh": join(GOLDEN, "inputs/fresh.json"),
    "--policy": join(GOLDEN, "inputs/policy-allow.json"),
    "--request": join(GOLDEN, "inputs/request.json"),
    "--retrieval": join(GOLDEN, "recorded/retrieval.json"),
    "--out": out,
    ...over
  };
  return ["compose", ...Object.entries(flags).flatMap(([k, v]) => (v ? [k, v] : []))];
}

describe("composing the golden deliveries", () => {
  it.each([
    ["valid", "policy-allow.json", "request.json"],
    ["denied", "policy-deny.json", "request.json"],
    ["wrong-destination", "policy-allow.json", "request-wrong-destination.json"]
  ])("%s writes the exact view part, H1 text and summary", (name, policy, request) => {
    const out = join(temp(), "out");
    const r = run(
      goldenArgs(out, {
        "--policy": join(GOLDEN, "inputs", policy),
        "--request": join(GOLDEN, "inputs", request)
      })
    );
    const expected = JSON.parse(
      readFileSync(join(GOLDEN, "expected", name, "expected.json"), "utf8")
    );
    expect(r).toEqual({
      code: 0,
      stdout: `handoff: composed viewDigest ${expected.viewDigest}\n`,
      stderr: ""
    });
    expect(readFileSync(join(out, "view-part.txt"))).toEqual(
      readFileSync(join(GOLDEN, "expected", name, "view-part.txt"))
    );
    expect(readFileSync(join(out, "h1-text.txt"))).toEqual(
      readFileSync(join(GOLDEN, "expected/h1-text.txt"))
    );
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      viewDigest: expected.viewDigest,
      viewCost: expected.viewCost,
      reservationTokens: expected.reservationTokens,
      h1SuppliedSha256: expected.h1SuppliedSha256,
      fresh: "historical as-of input, not live authority"
    });
    expect(summary.h1).toContain("not the pinned 5255daa invocation");
    expect(summary.inputs["manifest.bin"]).toBe(
      sha256Hex(readFileSync(join(GOLDEN, "delivery/manifest.bin")))
    );
    expect(summary.inputs.policy).toBe(sha256Hex(readFileSync(join(GOLDEN, "inputs", policy))));
  });

  it("composes with no retrieval file, marking retrieval unavailable", () => {
    const out = join(temp(), "out");
    expect(run(goldenArgs(out, { "--retrieval": "" })).code).toBe(0);
    expect(readFileSync(join(out, "view-part.txt"), "utf8")).toContain('"no_retriever"');
  });
});

describe("supplement deliveries with ChatAgent's real H1", () => {
  it.each(["unicode-rich", "eventseq-beyond-2^53"])(
    "%s is refused by the real H1, whose synthetic claim it cannot render, leaving no output",
    (name) => {
      const dir = temp();
      writeFileSync(join(dir, "allow.json"), JSON.stringify(ALLOW));
      const delivery = join(SUPPLEMENT, "deliveries", name);
      const out = join(dir, "out");
      const r = run([
        "compose",
        "--delivery",
        delivery,
        "--fresh",
        join(delivery, "fresh.json"),
        "--policy",
        join(dir, "allow.json"),
        "--request",
        join(delivery, "request.json"),
        "--out",
        out
      ]);
      expect(r).toMatchObject({ code: 1, stderr: "handoff: h1_refused\n" });
      expect(existsSync(out)).toBe(false);
    }
  );
});

describe("output directory", () => {
  it("refuses an existing directory, even an empty one, and leaves it untouched", () => {
    const parent = temp();
    const empty = join(parent, "empty");
    mkdirSync(empty);
    expect(run(goldenArgs(empty))).toMatchObject({ code: 1, stderr: "handoff: output_exists\n" });
    expect(readdirSync(empty)).toEqual([]);
    const used = join(parent, "used");
    mkdirSync(used);
    writeFileSync(join(used, "keep.txt"), "mine");
    expect(run(goldenArgs(used)).stderr).toBe("handoff: output_exists\n");
    expect(readdirSync(used)).toEqual(["keep.txt"]);
    expect(readFileSync(join(used, "keep.txt"), "utf8")).toBe("mine");
  });

  it("creates nothing when composition is refused", () => {
    const dir = temp();
    writeFileSync(
      join(dir, "bad.json"),
      JSON.stringify({ ...ALLOW, rules: [{ ...ALLOW.rules[0], allow: "false" }] })
    );
    const out = join(dir, "out");
    expect(run(goldenArgs(out, { "--policy": join(dir, "bad.json") })).stderr).toBe(
      "handoff: policy_invalid\n"
    );
    expect(existsSync(out)).toBe(false);
  });

  it("refuses an output whose parent does not exist", () => {
    expect(run(goldenArgs(join(temp(), "missing", "out"))).stderr).toBe(
      "handoff: output_unwritable\n"
    );
  });
});

describe("bounded, typed inputs", () => {
  it("reads at most the cap through one descriptor", () => {
    const dir = temp();
    writeFileSync(join(dir, "f"), "x".repeat(10));
    expect(readBounded(join(dir, "f"), 10)).toHaveLength(10);
    expect(() => readBounded(join(dir, "f"), 9)).toThrow(
      expect.objectContaining({ code: "input_too_large" })
    );
    expect(() => readBounded(dir, 9)).toThrow(
      expect.objectContaining({ code: "input_unreadable" })
    );
    expect(() => readBounded(join(dir, "none"), 9)).toThrow(
      expect.objectContaining({ code: "input_unreadable" })
    );
  });

  it("refuses an oversized delivery field before reading it as JSON", () => {
    const dir = temp();
    const delivery = join(dir, "delivery");
    cpSync(join(GOLDEN, "delivery"), delivery, { recursive: true });
    writeFileSync(join(delivery, "receipt.json"), "x".repeat(4097));
    expect(run(goldenArgs(join(dir, "out"), { "--delivery": delivery })).stderr).toBe(
      "handoff: input_too_large\n"
    );
  });

  it.each([
    ["a missing file", { "--fresh": "missing.json" }, "input_unreadable"],
    ["a directory", { "--policy": GOLDEN }, "input_unreadable"]
  ])("refuses %s", (_label, over, code) => {
    expect(run(goldenArgs(join(temp(), "out"), over)).stderr).toBe(`handoff: ${code}\n`);
  });

  it.each([
    [
      "a float in the snapshot",
      (f: Record<string, unknown>) => ({ ...f, basis: { at: 1.5 } }),
      "codec_unsupported"
    ],
    [
      "an extra snapshot key",
      (f: Record<string, unknown>) => ({ ...f, extra: 1 }),
      "fresh_invalid"
    ],
    [
      "a missing snapshot key",
      (f: Record<string, unknown>) => ({ ...f, queue: undefined }),
      "fresh_invalid"
    ],
    [
      "a mismatched snapshot",
      (f: Record<string, unknown>) => ({ ...f, record_id: "00000000-0000-4000-8000-000000000000" }),
      "fresh_mismatch"
    ]
  ])("refuses %s", (_label, change, code) => {
    const dir = temp();
    const fresh = JSON.parse(readFileSync(join(GOLDEN, "inputs/fresh.json"), "utf8"));
    writeFileSync(join(dir, "fresh.json"), JSON.stringify(change(fresh)));
    expect(run(goldenArgs(join(dir, "out"), { "--fresh": join(dir, "fresh.json") })).stderr).toBe(
      `handoff: ${code}\n`
    );
  });

  it("refuses malformed JSON, an invalid wrapper and an invalid request with codes only", () => {
    const dir = temp();
    writeFileSync(join(dir, "broken.json"), '{"principal": "secret-value"');
    writeFileSync(join(dir, "request.json"), JSON.stringify({ destination: "d", extra: 1 }));
    const delivery = join(dir, "delivery");
    cpSync(join(GOLDEN, "delivery"), delivery, { recursive: true });
    writeFileSync(
      join(delivery, "wrapper.json"),
      JSON.stringify({ wrapper: "w", codec: 1, candidateDigest: "x" })
    );
    const results = [
      run(goldenArgs(join(dir, "a"), { "--policy": join(dir, "broken.json") })),
      run(goldenArgs(join(dir, "b"), { "--request": join(dir, "request.json") })),
      run(goldenArgs(join(dir, "c"), { "--delivery": delivery }))
    ];
    expect(results.map((r) => r.stderr)).toEqual([
      "handoff: input_invalid_json\n",
      "handoff: request_invalid\n",
      "handoff: delivery_invalid\n"
    ]);
    for (const r of results) expect(r.stderr).not.toContain("secret");
  });

  it.each([
    [["compose"]],
    [["other"]],
    [["compose", "--delivery"]],
    [[...goldenArgs("x").slice(0, -2)]],
    [[...goldenArgs("x"), "--unknown", "y"]],
    [[...goldenArgs("x"), "--out", "y"]]
  ])("prints usage with exit 2 for %j", (argv) => {
    expect(run(argv)).toEqual({ code: 2, stdout: "", stderr: USAGE + "\n" });
  });
});

it("runs as a subprocess through the script", () => {
  const out = join(temp(), "out");
  const r = spawnSync(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/handoff.ts"), ...goldenArgs(out)],
    { encoding: "utf8", timeout: 60_000 }
  );
  const expected = JSON.parse(readFileSync(join(GOLDEN, "expected/valid/expected.json"), "utf8"));
  expect(r.status).toBe(0);
  expect(r.stdout).toBe(`handoff: composed viewDigest ${expected.viewDigest}\n`);
  expect(r.stderr).toBe("");
  expect(readFileSync(join(out, "view-part.txt"))).toEqual(
    readFileSync(join(GOLDEN, "expected/valid/view-part.txt"))
  );
});

describe("recorded retrieval matching (review 1476)", () => {
  it("keys integers by value and strings by text, never confusing the two", () => {
    expect(requestKey(9007199254740993n)).not.toBe(requestKey("9007199254740993"));
    expect(requestKey(7)).not.toBe(requestKey("7"));
    expect(requestKey(7)).toBe(requestKey(7n));
    expect(requestKey({ b: 1, a: [null, true] })).toBe(requestKey({ a: [null, true], b: 1n }));
    expect(() => requestKey({ seq: 1.5 })).toThrow(
      expect.objectContaining({ code: "retrieval_invalid" })
    );
  });

  it("refuses a recorded file with conflicting results for the same request", () => {
    const dir = temp();
    const recorded = JSON.parse(readFileSync(join(GOLDEN, "recorded/retrieval.json"), "utf8"));
    // The golden file itself repeats each request with an identical result.
    expect(recorded).toHaveLength(4);
    const conflicting = { ...recorded[0], result: { ...recorded[0].result, bytes: "other" } };
    writeFileSync(join(dir, "dup.json"), JSON.stringify([...recorded, conflicting]));
    const out = join(dir, "out");
    expect(run(goldenArgs(out, { "--retrieval": join(dir, "dup.json") })).stderr).toBe(
      "handoff: retrieval_invalid\n"
    );
    expect(existsSync(out)).toBe(false);
  });

  it("does not answer a pointer whose recorded seq is a string", () => {
    const dir = temp();
    const recorded = JSON.parse(readFileSync(join(GOLDEN, "recorded/retrieval.json"), "utf8"));
    const stringly = recorded.map((e: { request: Record<string, unknown> }) => ({
      ...e,
      request: { ...e.request, seq: String(e.request.seq) }
    }));
    writeFileSync(join(dir, "strings.json"), JSON.stringify(stringly));
    const out = join(dir, "out");
    expect(run(goldenArgs(out, { "--retrieval": join(dir, "strings.json") })).code).toBe(0);
    const view = readFileSync(join(out, "view-part.txt"), "utf8");
    expect(view).toContain('"not_found_or_invalid"');
    expect(view).not.toContain('"label":"as-of"');
  });
});

describe("--emit-request (CA-ISSUE-003 slot)", () => {
  it.each(["fast", "deep"])("writes the %s worker request offline beside the view", (role) => {
    const out = join(temp(), "out");
    const r = run([...goldenArgs(out), "--emit-request", role]);
    expect(r.code).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "h1-text.txt",
      "request.json",
      "summary.json",
      "view-part.txt"
    ]);
    const request = JSON.parse(readFileSync(join(out, "request.json"), "utf8"));
    expect(request).toMatchObject({ slot: "handoff-view-slot.v0", role });
    expect(request.messages).toEqual([
      { role: "user", content: readFileSync(join(GOLDEN, "expected/h1-text.txt"), "utf8") }
    ]);
    expect(request.system.split("[HANDOFF_VIEW:")).toHaveLength(2);
    expect(request.system.endsWith("[/HANDOFF_VIEW]")).toBe(true);
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(summary.request).toMatchObject({
      role,
      slot: "handoff-view-slot.v0",
      sha256: sha256Hex(readFileSync(join(out, "request.json")))
    });
  });

  it("leaves the outputs unchanged without the flag", () => {
    const out = join(temp(), "out");
    expect(run(goldenArgs(out)).code).toBe(0);
    expect(readdirSync(out)).not.toContain("request.json");
    expect(JSON.parse(readFileSync(join(out, "summary.json"), "utf8")).request).toBeUndefined();
  });

  it("refuses an unknown role as a usage error", () => {
    expect(run([...goldenArgs("x"), "--emit-request", "both"]).code).toBe(2);
  });
});

describe("--expect parity with the producer's consumer (CA-ISSUE-011)", () => {
  /** A v0 expectation from the golden valid composition (produced with the real H1). */
  const goldenExpectation = () => {
    const expected = JSON.parse(readFileSync(join(GOLDEN, "expected/valid/expected.json"), "utf8"));
    const wrapper = JSON.parse(readFileSync(join(GOLDEN, "delivery/wrapper.json"), "utf8"));
    return {
      version: "handoff-expectation.v0",
      h1Builder: "chatagent-h1",
      viewDigest: expected.viewDigest,
      viewPartSha256: sha256Hex(readFileSync(join(GOLDEN, "expected/valid/view-part.txt"))),
      reservationTokens: expected.reservationTokens,
      viewCost: expected.viewCost,
      h1SuppliedSha256: expected.h1SuppliedSha256,
      candidateDigest: wrapper.candidateDigest
    } as Record<string, unknown>;
  };
  const withExpectation = (content: string) => {
    const dir = temp();
    writeFileSync(join(dir, "expected.json"), content);
    const out = join(dir, "out");
    return {
      out,
      result: run([...goldenArgs(out), "--expect", join(dir, "expected.json")]),
      file: join(dir, "expected.json")
    };
  };

  it("publishes when the producer's view matches, recording the expectation", () => {
    const { out, result, file } = withExpectation(JSON.stringify(goldenExpectation(), null, 2));
    expect(result.code).toBe(0);
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(summary.expectation).toMatchObject({
      sha256: sha256Hex(readFileSync(file)),
      version: "handoff-expectation.v0",
      result: "matches the supplied expectation"
    });
  });

  it.each([
    ["viewDigest", { viewDigest: "0".repeat(64) }],
    ["viewPartSha256", { viewPartSha256: "0".repeat(64) }],
    ["reservation and cost", { reservationTokens: "0000007465", viewCost: 7465 }],
    ["h1SuppliedSha256", { h1SuppliedSha256: "0".repeat(64) }],
    ["candidateDigest", { candidateDigest: "0".repeat(64) }]
  ])("refuses a different %s as expectation_mismatch, publishing nothing", (_label, change) => {
    const { out, result } = withExpectation(JSON.stringify({ ...goldenExpectation(), ...change }));
    expect(result).toMatchObject({ code: 1, stderr: "handoff: expectation_mismatch\n" });
    expect(existsSync(out)).toBe(false);
  });

  it.each([
    ["an extra key", (e: Record<string, unknown>) => ({ ...e, extra: 1 })],
    ["a missing key", (e: Record<string, unknown>) => ({ ...e, candidateDigest: undefined })],
    [
      "an uppercase digest",
      (e: Record<string, unknown>) => ({ ...e, viewDigest: String(e.viewDigest).toUpperCase() })
    ],
    ["a stub builder", (e: Record<string, unknown>) => ({ ...e, h1Builder: "h1-stub" })],
    [
      "another version",
      (e: Record<string, unknown>) => ({ ...e, version: "handoff-expectation.v1" })
    ],
    [
      "a cost differing from the reservation",
      (e: Record<string, unknown>) => ({ ...e, viewCost: 1 })
    ],
    ["a short reservation", (e: Record<string, unknown>) => ({ ...e, reservationTokens: "7464" })],
    ["a string cost", (e: Record<string, unknown>) => ({ ...e, viewCost: "7464" })]
  ])("refuses an expectation with %s as expectation_invalid", (_label, change) => {
    const { out, result } = withExpectation(JSON.stringify(change(goldenExpectation())));
    expect(result.stderr).toBe("handoff: expectation_invalid\n");
    expect(existsSync(out)).toBe(false);
  });

  it.each([
    ["a float cost", JSON.stringify({ x: 1 }).replace("1", "1.5")],
    ["malformed JSON", "{"],
    ["an oversized file", " ".repeat(4097)]
  ])("refuses %s as expectation_invalid", (_label, content) => {
    const e = JSON.stringify(goldenExpectation());
    const body =
      _label === "a float cost" ? e.replace(/"viewCost":\d+/, '"viewCost":7464.0') : content;
    const { out, result } = withExpectation(body);
    expect(result.stderr).toBe("handoff: expectation_invalid\n");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a missing expectation file as input_unreadable", () => {
    const out = join(temp(), "out");
    expect(run([...goldenArgs(out), "--expect", join(temp(), "none.json")]).stderr).toBe(
      "handoff: input_unreadable\n"
    );
  });
});
