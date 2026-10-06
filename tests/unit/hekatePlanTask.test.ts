import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPlanTaskContext,
  DEFAULT_PLAN_TASK_LIMITS,
  planTaskFromResponse,
  PlanTaskError,
  resolvePlanTaskLimits,
  type PlanRule,
  type PlanTaskLimits
} from "../../src/integrations/hekate/planTask";
import { ContextBudgetError, type ContextBudget } from "../../src/app/contextBuilder";

// Raw Hekate responses (tests/fixtures/hekate/PROVENANCE.md). Variants are made by
// editing the raw text, so number syntax reaches the parser exactly as written;
// every variant is synthetic.
const fixture = (name: string) => readFileSync(`tests/fixtures/hekate/claim-${name}.json`, "utf8");
const claimed = fixture("claimed");
const replayed = fixture("replayed");
const noWork = fixture("no-ready-work");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const variant = (from: string, to: string, base = claimed) => {
  expect(base).toContain(from);
  return base.replace(from, to);
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PlanTaskError) return error.code;
    throw error;
  }
  return "OK";
};
const RULES: PlanRule[] = [
  { path: "AGENTS.md", revision: "fcceff2", text: "# Repository conventions\n- Run checks.\n" },
  { path: "docs/rules.md", revision: "fcceff2", text: "Second rule." }
];
const task = (response: string, rules: readonly PlanRule[] = [], limits?: PlanTaskLimits) =>
  planTaskFromResponse(response, rules, limits);
const limitsWith = (over: Partial<PlanTaskLimits>) => ({ ...DEFAULT_PLAN_TASK_LIMITS, ...over });

describe("validating a raw claim response", () => {
  it("accepts the captured claimed and replayed responses as historical data", () => {
    const first = task(claimed);
    expect(first.source).toMatchObject({
      contractVersion: "plan-contract/v1",
      rootId: "2106a3b7-47fc-4d8c-a4e8-14a8c63901bb",
      nodeId: "0030b6ce-c31a-4ae1-b999-d72110324406",
      claimKey: "x._~-123",
      attemptId: "k-att",
      attemptEpoch: 1,
      executorRef: "run-k",
      contentRevision: 1,
      contentDigest: "ABA4FED47F00152C6B8B56EC23B580AA6327E193EC38ABACFBB2094EF1B065A1",
      prereqDigest: "91ad4ede0bacab815eb27ae1112b5c7edaeffae6560026f8af830c1b35eb991d",
      eventSeq: 4,
      actor: "worker",
      createdAt: "2026-10-06T22:13:03.102911Z",
      replayed: false,
      stillCurrent: true
    });
    const again = task(replayed);
    expect(again.source.replayed).toBe(true);
    expect(again.text).toBe(first.text);
    // No longer current is still a parseable fact; this seam decides nothing.
    expect(task(variant('"stillCurrent":true', '"stillCurrent":false')).source.stillCurrent).toBe(
      false
    );
  });

  it("refuses a no-ready-work receipt", () => {
    expect(code(() => task(noWork))).toBe("NO_WORK");
  });

  it.each([
    [
      "another contract version",
      '"contractVersion":"plan-contract/v1"',
      '"contractVersion":"plan-contract/v2"',
      "UNSUPPORTED_CONTRACT"
    ],
    ["a renamed root field", '"rootId"', '"rootNodeId"', "INVALID_RESPONSE"],
    ["no creation time", ',"createdAt":"2026-10-06T22:13:03.102911Z"', "", "INVALID_RESPONSE"],
    [
      "an impossible creation time",
      "2026-10-06T22:13:03.102911Z",
      "2026-13-06T22:13:03.102911Z",
      "INVALID_RESPONSE"
    ],
    [
      "an extra envelope field",
      '"replayed":false,',
      '"replayed":false,"authorized":true,',
      "INVALID_RESPONSE"
    ],
    [
      "an extra receipt field",
      '"outcome":"claimed",',
      '"outcome":"claimed","lease":1,',
      "INVALID_RESPONSE"
    ],
    ["a claimed receipt with a null field", '"eventSeq":4', '"eventSeq":null', "INVALID_RESPONSE"],
    [
      "a claimed epoch of 0",
      '"attemptEpoch":1,"executorRef"',
      '"attemptEpoch":0,"executorRef"',
      "INVALID_RESPONSE"
    ],
    [
      "a lowercase content digest",
      "ABA4FED47F00152C6B8B56EC23B580AA6327E193EC38ABACFBB2094EF1B065A1",
      "aba4fed47f00152c6b8b56ec23b580aa6327e193ec38abacfbb2094ef1b065a1",
      "INVALID_RESPONSE"
    ],
    [
      "a short content digest",
      "ABA4FED47F00152C6B8B56EC23B580AA6327E193EC38ABACFBB2094EF1B065A1",
      "ABA4FED47F00152C6B8B56EC23B580AA6327E193EC38ABACFBB2094EF1B065A",
      "INVALID_RESPONSE"
    ],
    [
      "an uppercase prerequisite digest",
      '"prereqDigest":"91ad4ede',
      '"prereqDigest":"91AD4EDE',
      "INVALID_RESPONSE"
    ],
    ["a dot-segment claim key", '"claimKey":"x._~-123"', '"claimKey":".."', "INVALID_RESPONSE"],
    [
      "a claim key with a colon",
      '"claimKey":"x._~-123"',
      '"claimKey":"hekate-claim:x"',
      "INVALID_RESPONSE"
    ],
    [
      "an executor reference with a space",
      '"executorRef":"run-k"',
      '"executorRef":"run k"',
      "INVALID_RESPONSE"
    ],
    [
      "a blank attempt id",
      '"attemptId":"k-att","attemptEpoch":1,"executorRef"',
      '"attemptId":"  ","attemptEpoch":1,"executorRef"',
      "INVALID_RESPONSE"
    ],
    ["a non-string attribute", '"attributes":null}', '"attributes":{"a":1}}', "INVALID_RESPONSE"],
    ["an unknown work state", '"work":"in_progress"', '"work":"running"', "INVALID_RESPONSE"],
    ["malformed JSON", '"receipt":{', '"receipt":{{', "INVALID_RESPONSE"]
  ])("refuses %s", (_, from, to, expected) => {
    expect(code(() => task(variant(from, to)))).toBe(expected);
  });

  it("refuses a response that is not text", () => {
    for (const response of [null, undefined, 42, JSON.parse(claimed)])
      expect(code(() => task(response as unknown as string))).toBe("INVALID_RESPONSE");
  });

  it("accepts a null executor reference and a nested epoch of 0", () => {
    expect(
      task(variant('"executorRef":"run-k"', '"executorRef":null')).source.executorRef
    ).toBeNull();
    // Synthetic: an unstarted prerequisite keeps epoch 0 in the opaque snapshot.
    const nested = variant(
      '"attemptEpoch":1,"contentRevision":1,"pinnedPrereqDigest"',
      '"attemptEpoch":0,"contentRevision":1,"pinnedPrereqDigest"'
    );
    expect(code(() => task(nested))).toBe("OK");
  });

  it.each([
    ["2^53 + 1", "9007199254740993"],
    ["2^53", "9007199254740992"],
    ["a fraction", "1.5"],
    ["a trailing zero fraction", "1.0"],
    ["an exponent", "1e0"],
    ["negative zero", "-0"]
  ])("refuses %s anywhere instead of rounding it", (_, number) => {
    for (const [from, to] of [
      ['"attemptEpoch":1,"executorRef"', `"attemptEpoch":${number},"executorRef"`],
      ['"eventSeq":4', `"eventSeq":${number}`],
      ['"pinnedContentRevision":1', `"pinnedContentRevision":${number}`]
    ])
      expect(
        code(() => task(variant(from, to))),
        `${from} -> ${number}`
      ).toBe("INVALID_NUMBER");
  });

  it.each([
    ["an unsafe integer", "9007199254740993"],
    ["a fraction", "1.5"],
    ["an exponent", "4e0"]
  ])("refuses %s hidden behind a later duplicate key", (_, number) => {
    // JSON.parse keeps only the last duplicate, so the raw text itself is checked.
    expect(code(() => task(variant('"eventSeq":4', `"eventSeq":${number},"eventSeq":4`)))).toBe(
      "INVALID_NUMBER"
    );
    // The same with an escaped spelling of the duplicate key.
    expect(
      code(() => task(variant('"eventSeq":4', `"event\\u0053eq":${number},"eventSeq":4`)))
    ).toBe("INVALID_NUMBER");
  });

  it("accepts number-like text inside strings, escapes included", () => {
    const quoted = task(
      variant(
        '"attemptId":"k-att","attemptEpoch":1,"executorRef":"run-k"',
        '"attemptId":"9007199254740993 1.5e3 -0","attemptEpoch":1,"executorRef":"a\\"1.5\\\\2e9"'
      )
    );
    expect(quoted.source.attemptId).toBe("9007199254740993 1.5e3 -0");
    expect(quoted.source.executorRef).toBe('a"1.5\\2e9');
  });

  it("accepts the largest safe integer", () => {
    expect(task(variant('"eventSeq":4', '"eventSeq":9007199254740991')).source.eventSeq).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it("bounds the raw input before parsing and the prerequisite snapshot after", () => {
    const limits = limitsWith({ maxResponseBytes: Buffer.byteLength(claimed) });
    expect(code(() => task(claimed, [], limits))).toBe("OK");
    // Unparseable and oversized: refused for size, so it was never parsed.
    expect(code(() => task(claimed + "{", [], limits))).toBe("INPUT_TOO_LARGE");
    expect(code(() => task(claimed, [], limitsWith({ maxPrerequisiteBytes: 100 })))).toBe(
      "INPUT_TOO_LARGE"
    );
  });
});

describe("limits", () => {
  it("defaults only when none are given, and the defaults cannot be changed", () => {
    expect(resolvePlanTaskLimits()).toBe(DEFAULT_PLAN_TASK_LIMITS);
    expect(Object.isFrozen(DEFAULT_PLAN_TASK_LIMITS)).toBe(true);
    expect(() => {
      (DEFAULT_PLAN_TASK_LIMITS as PlanTaskLimits).maxRules = 1000;
    }).toThrow();
    const copy = resolvePlanTaskLimits(limitsWith({ maxRules: 3 }));
    expect(copy).toEqual(limitsWith({ maxRules: 3 }));
    expect(Object.isFrozen(copy)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a number", 5],
    ["an array", []],
    ["an empty object", {}],
    ["a missing field", (({ maxResponseBytes: _, ...rest }) => rest)(DEFAULT_PLAN_TASK_LIMITS)],
    ["an extra field", { ...DEFAULT_PLAN_TASK_LIMITS, maxEverything: 1 }],
    ["a null field", limitsWith({ maxRules: null as unknown as number })],
    ["a string field", limitsWith({ maxRules: "8" as unknown as number })],
    ["zero", limitsWith({ maxRules: 0 })],
    ["a fraction", limitsWith({ maxRules: 1.5 })],
    ["NaN", limitsWith({ maxRules: Number.NaN })],
    ["over the ceiling", limitsWith({ maxRules: 16_777_217 })]
  ])("refuses %s as limits", (_, limits) => {
    expect(() => task(claimed, [], limits as unknown as PlanTaskLimits)).toThrow(
      /limit|must be an integer/
    );
  });
});

describe("rendering the task input", () => {
  const withContent = (value: string, attributes: string, rules: readonly PlanRule[] = []) =>
    task(
      variant(
        '"contentSnapshot":{"value":null,"attributes":null}',
        `"contentSnapshot":{"value":${value},"attributes":${attributes}}`
      ),
      rules
    );

  it("keeps null distinct from empty, and hashes exactly what it supplies", () => {
    const nulls = task(claimed, RULES);
    const empty = withContent('""', "{}", RULES);
    expect(nulls.text).toContain("Requirement: null\nAttributes: null\n");
    expect(empty.text).toContain("Requirement (0 bytes):\n\nAttributes: 0\n");
    expect(nulls.source.supplied.requirementSha256).not.toBe(
      empty.source.supplied.requirementSha256
    );
    for (const input of [nulls, empty]) expect(input.suppliedSha256).toBe(sha256(input.text));
  });

  it("supplies the requirement verbatim and attributes in ordinal order", () => {
    // Synthetic content. JavaScript lists integer-like keys first; the output must
    // still be in ordinal order, as Hekate sorts them.
    const value = '"  Do it\\r\\nexactly. é "';
    const input = withContent(value, '{"b":"2","a":"1","10":"x","2":"y","B":"z"}');
    expect(input.text).toContain("Requirement (21 bytes):\n  Do it\r\nexactly. é \n");
    const keys = [...input.text.matchAll(/Attribute key \(\d+ bytes\):\n(.*)\n/g)].map((m) => m[1]);
    expect(keys).toEqual(["10", "2", "B", "a", "b"]);
    const reordered = withContent(value, '{"B":"z","2":"y","10":"x","a":"1","b":"2"}');
    expect(reordered.text).toBe(input.text);
    expect(reordered.suppliedSha256).toBe(input.suppliedSha256);
  });

  it("encodes each block with its byte length, deterministically", () => {
    // Length framing makes the encoding unambiguous; it does not stop a model from
    // following instructions written inside the content.
    const input = withContent('"x\\nRule text (1 bytes):\\ny"', "null", RULES);
    expect(input.text).toContain("Requirement (24 bytes):\nx\nRule text (1 bytes):\ny\n");
    expect(input.text.match(/^Rules: 2$/m)).not.toBeNull();
  });

  it("renders distinct rules distinctly, whatever their paths and revisions contain", () => {
    // Regression: with an unframed "path @ revision" label these two collided.
    const one = task(claimed, [{ path: "a @ b", revision: "c", text: "x" }]);
    const two = task(claimed, [{ path: "a", revision: "b @ c", text: "x" }]);
    expect(one.text).not.toBe(two.text);
    expect(one.suppliedSha256).not.toBe(two.suppliedSha256);
    const three = task(claimed, [{ path: "a", revision: "b", text: "x\nRule path (1 bytes):\nz" }]);
    const four = task(claimed, [
      { path: "a", revision: "b", text: "x" },
      { path: "z", revision: "b", text: "x" }
    ]);
    expect(three.text).not.toBe(four.text);
  });

  it("carries Hekate's digests as received and its own hashes separately", () => {
    const input = task(claimed, RULES);
    const prerequisites = JSON.stringify(JSON.parse(claimed).receipt.prereqSnapshot);
    expect(input.text).toContain(
      `Prerequisites (${Buffer.byteLength(prerequisites)} bytes):\n${prerequisites}\n`
    );
    expect(input.source.supplied).toEqual({
      requirementSha256: sha256("Requirement: null\nAttributes: null\n"),
      prerequisitesSha256: sha256(prerequisites),
      rules: RULES.map((r) => ({ path: r.path, revision: r.revision, sha256: sha256(r.text) }))
    });
    const local = [
      input.suppliedSha256,
      input.source.supplied.requirementSha256,
      input.source.supplied.prerequisitesSha256
    ];
    expect(local).not.toContain(input.source.contentDigest.toLowerCase());
    expect(local).not.toContain(input.source.prereqDigest);
  });

  it("requires every rule, in order, and refuses invalid ones", () => {
    const text = task(claimed, RULES).text;
    expect(text).toContain(
      "Rule path (9 bytes):\nAGENTS.md\nRule revision (7 bytes):\nfcceff2\nRule text (39 bytes):\n"
    );
    expect(text.indexOf("Rule path (9 bytes):\nAGENTS.md\n")).toBeLessThan(
      text.indexOf("Rule path (13 bytes):\ndocs/rules.md\n")
    );
    expect(task(claimed, []).text).toContain("Rules: 0\n");
    for (const rules of [
      [RULES[0], RULES[0]],
      [{ ...RULES[0], text: "" }],
      [{ ...RULES[0], path: " " }],
      [{ ...RULES[0], revision: "" }],
      [{ ...RULES[0], path: "a\nb" }],
      [{ ...RULES[0], text: undefined }],
      [null],
      "AGENTS.md",
      undefined,
      Array.from({ length: 33 }, (_, i) => ({ ...RULES[0], path: `r${i}` }))
    ])
      expect(
        // Called directly: the helper would default an undefined list.
        code(() => planTaskFromResponse(claimed, rules as unknown as PlanRule[])),
        String(JSON.stringify(rules)).slice(0, 80)
      ).toBe("INVALID_RULES");
    expect(
      code(() =>
        task(claimed, [{ ...RULES[0], text: "x".repeat(300) }], limitsWith({ maxRuleBytes: 300 }))
      )
    ).toBe("INVALID_RULES");
    const size = Buffer.byteLength(task(claimed, RULES).text);
    expect(code(() => task(claimed, RULES, limitsWith({ maxPackageBytes: size })))).toBe("OK");
    expect(code(() => task(claimed, RULES, limitsWith({ maxPackageBytes: size - 1 })))).toBe(
      "PACKAGE_TOO_LARGE"
    );
  });

  it("uses copies: later changes to the caller's rules or to the result change nothing", () => {
    const rules = RULES.map((r) => ({ ...r }));
    const input = task(claimed, rules);
    const before = input.text;
    rules[0].text = "Changed after rendering.";
    rules.push({ path: "late.md", revision: "x", text: "Late." });
    expect(input.text).toBe(before);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.source)).toBe(true);
    expect(Object.isFrozen(input.source.supplied.rules[0])).toBe(true);
    expect(() => {
      (input.source as { attemptEpoch: number }).attemptEpoch = 99;
    }).toThrow();
    // A getter is read once: a rule cannot pass validation and render differently.
    let reads = 0;
    const tricky = {
      path: "AGENTS.md",
      revision: "r",
      get text() {
        reads += 1;
        return reads === 1 ? "valid" : "";
      }
    };
    expect(task(claimed, [tricky]).text).toContain("Rule text (5 bytes):\nvalid\n");
    expect(reads).toBe(1);
  });
});

describe("building the task context", () => {
  const roles = {
    fast: "Fast role instructions that are longer than the deep ones.",
    deep: "Deep."
  };
  const budget = (windowTokens: number): ContextBudget => ({
    windowTokens,
    maxHistoryTurns: 8,
    safetyTokens: 64,
    fastOutputTokens: 100,
    deepOutputTokens: 400
  });
  const build = (windowTokens: number, roleInstructions = roles) =>
    buildPlanTaskContext({
      response: claimed,
      rules: RULES,
      systemInstruction: "System.",
      roleInstructions,
      budget: budget(windowTokens),
      capturedAtIso: "2026-10-06T22:30:00.000Z"
    });
  const fits = (result: ReturnType<typeof build>) => {
    if (result instanceof ContextBudgetError) throw result;
    return result;
  };

  it("supplies exactly the package as the one message, with nothing else", () => {
    const built = fits(build(1_000_000));
    expect(built.text).toBe(task(claimed, RULES).text);
    expect(built.context.messages).toEqual([
      { role: "user", content: built.text, messageId: "x._~-123" }
    ]);
    expect(built.context.memory).toBeNull();
    expect(built.context.resolvedSources).toEqual([]);
    expect(built.context.unavailableSources).toEqual([]);
    expect(built.context.includedTurnIds).toEqual([]);
    expect(built.context.activeTasks).toEqual([]);
    expect(built.suppliedSha256).toBe(sha256(built.context.messages[0].content));
    // The snapshot id is a fresh UUID; the text and hashes are what is reproducible.
    const again = fits(build(1_000_000));
    expect(again.context.snapshotId).not.toBe(built.context.snapshotId);
    expect(again.text).toBe(built.text);
  });

  it("fails one token under an exact fit, counting the larger role and output reserve", () => {
    const fixed = fits(build(1_000_000)).context.estimatedInputTokens;
    // Swapping which role is longer changes nothing: the larger one is budgeted.
    expect(
      fits(build(1_000_000, { fast: roles.deep, deep: roles.fast })).context.estimatedInputTokens
    ).toBe(fixed);
    // The larger output reserve (deep, 400) and the safety reserve are both held back.
    const exact = fixed + 400 + 64;
    expect(build(exact)).not.toBeInstanceOf(ContextBudgetError);
    const over = build(exact - 1);
    expect(over).toBeInstanceOf(ContextBudgetError);
    expect((over as ContextBudgetError).code).toBe("CONTEXT_TOO_LARGE");
  });

  it.each([
    ["a NaN window", { windowTokens: Number.NaN }],
    ["an infinite window", { windowTokens: Number.POSITIVE_INFINITY }],
    ["a zero window", { windowTokens: 0 }],
    ["a negative safety reserve", { safetyTokens: -1000 }],
    ["a NaN output reserve", { deepOutputTokens: Number.NaN }],
    ["a negative output reserve", { fastOutputTokens: -5 }],
    ["a fractional reserve", { safetyTokens: 1.5 }],
    ["an unsafe window", { windowTokens: 2 ** 53 }],
    ["a missing field", { safetyTokens: undefined }],
    ["an extra field", { referenceTokens: 0 }]
  ])("refuses %s before building", (_, over) => {
    const options = {
      response: claimed,
      rules: RULES,
      systemInstruction: "System.",
      roleInstructions: roles,
      budget: { ...budget(1_000_000), ...over } as ContextBudget,
      capturedAtIso: "2026-10-06T22:30:00.000Z"
    };
    expect(code(() => buildPlanTaskContext(options))).toBe("INVALID_OPTIONS");
  });

  it("refuses invalid instructions, capture times and unknown options", () => {
    const base = {
      response: claimed,
      rules: RULES,
      systemInstruction: "System.",
      roleInstructions: roles,
      budget: budget(1_000_000),
      capturedAtIso: "2026-10-06T22:30:00.000Z"
    };
    for (const over of [
      { systemInstruction: undefined },
      { roleInstructions: { fast: "x" } },
      { capturedAtIso: "yesterday" },
      // A token counter override is not accepted: it could under-report.
      { tokenCounter: { estimateBytes: () => 0 } }
    ])
      expect(
        code(() =>
          buildPlanTaskContext({ ...base, ...over } as unknown as Parameters<
            typeof buildPlanTaskContext
          >[0])
        ),
        JSON.stringify(Object.keys(over))
      ).toBe("INVALID_OPTIONS");
  });

  it("validates the response and rules before building", () => {
    expect(
      code(() =>
        buildPlanTaskContext({
          response: noWork,
          rules: RULES,
          systemInstruction: "System.",
          roleInstructions: roles,
          budget: budget(1_000_000),
          capturedAtIso: "2026-10-06T22:30:00.000Z"
        })
      )
    ).toBe("NO_WORK");
  });
});
