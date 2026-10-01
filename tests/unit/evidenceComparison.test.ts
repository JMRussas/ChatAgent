import { expect, it, vi } from "vitest";
import dataset from "../../data/evals/evidence-quality.v1.json";
import {
  runEvidenceComparison,
  gradeEvidenceComparison,
  evidenceHash
} from "../../src/eval/evidenceComparison";
it("keeps expected answers out of inference and requires independent hash-bound grades", async () => {
  const generate = vi.fn(async () => ({
    text: JSON.stringify({ status: "insufficient_evidence", reason: "Not enough evidence" }),
    finishReason: "stop" as const
  }));
  const report = await runEvidenceComparison(dataset, [
    { id: "fixture", thinking: "configured", provider: { createProvisionalReply: generate } }
  ]);
  expect(generate).toHaveBeenCalledTimes(3);
  expect(report.records.every((r) => r.errorCode === null)).toBe(true);
  expect(JSON.stringify(generate.mock.calls)).not.toContain(dataset.cases[0].expected);
  expect(
    gradeEvidenceComparison(report, { judge: { id: "reviewer", kind: "human" }, ratings: [] })
      .passed
  ).toBe(false);
  const ratings = report.records.map((r) => ({
    responseHash: r.responseHash,
    grade: r.caseId === "insufficient-recap" ? "pass" : "fail",
    rationale: "Independent task completion assessment"
  }));
  expect(
    gradeEvidenceComparison(report, { judge: { id: "reviewer", kind: "human" }, ratings }).passed
  ).toBe(false);
  const tampered = structuredClone(report);
  tampered.records[0].prompt = "different prompt";
  expect(() =>
    gradeEvidenceComparison(tampered, { judge: { id: "reviewer", kind: "human" }, ratings })
  ).toThrow("CASE_PLAN_MISMATCH");
});
it("validates all evidence before any model invocation", async () => {
  const generate = vi.fn();
  const invalid = structuredClone(dataset);
  invalid.cases[2].selectedRows = [999];
  await expect(
    runEvidenceComparison(invalid, [
      { id: "fixture", thinking: "configured", provider: { createProvisionalReply: generate } }
    ])
  ).rejects.toThrow();
  expect(generate).not.toHaveBeenCalled();
});

it("rejects omitted, duplicated and unplanned records instead of grading a subset", async () => {
  const provider = {
    createProvisionalReply: async () => ({
      text: JSON.stringify({ status: "insufficient_evidence", reason: "Not enough evidence" }),
      finishReason: "stop" as const
    })
  };
  const report = await runEvidenceComparison(dataset, [
    { id: "fixture", thinking: "configured", provider }
  ]);
  const grades = {
    judge: { id: "reviewer", kind: "human" },
    ratings: report.records.map((r) => ({
      responseHash: r.responseHash,
      grade: "pass",
      rationale: "Reviewed"
    }))
  };
  expect(gradeEvidenceComparison(report, grades).passed).toBe(true);
  for (const records of [
    report.records.slice(1),
    [...report.records, report.records[0]],
    [{ ...report.records[0], caseId: "unknown" }, ...report.records.slice(1)]
  ]) {
    expect(() => gradeEvidenceComparison({ ...report, records }, grades)).toThrow(
      "CASE_COVERAGE_MISMATCH"
    );
  }
  expect(() =>
    gradeEvidenceComparison({ ...report, version: "evidence-comparison-v1" }, grades)
  ).toThrow();
  const tampered = structuredClone(report);
  tampered.records[0].generated!.text = "changed";
  expect(() => gradeEvidenceComparison(tampered, grades)).toThrow("RESPONSE_HASH_MISMATCH");
  expect(() =>
    gradeEvidenceComparison(report, { ...grades, ratings: [grades.ratings[0], grades.ratings[0]] })
  ).toThrow("DUPLICATE_GRADE");
});

it("rejects invalid condition IDs before provider calls", async () => {
  const generate = vi.fn();
  await expect(
    runEvidenceComparison(dataset, [
      { id: " fixture ", thinking: "configured", provider: { createProvisionalReply: generate } }
    ])
  ).rejects.toThrow("surrounding whitespace");
  expect(generate).not.toHaveBeenCalled();
});

it("captures delivery and fails a formatter regression even if raw model output passes", async () => {
  const provider = {
    createProvisionalReply: async () => ({
      text: JSON.stringify({ status: "insufficient_evidence", reason: "No play data" }),
      finishReason: "stop" as const
    })
  };
  const report = await runEvidenceComparison(dataset, [
    { id: "fixture", thinking: "configured", provider }
  ]);
  expect(report.records[0].delivered?.text).toContain("No play data");
  report.records[0].delivered!.text = "Wrong rendered answer";
  const { responseHash, semanticGrade, ...record } = report.records[0];
  report.records[0].responseHash = evidenceHash(record);
  const graded = gradeEvidenceComparison(report, {
    judge: { id: "reviewer", kind: "human" },
    ratings: report.records.map((r) => ({
      responseHash: r.responseHash,
      grade: "pass",
      rationale: "Raw model output correct"
    }))
  });
  expect(graded.passed).toBe(false);
  expect(graded.results[0].runtimePassed).toBe(false);
});
it("retains rejected model output without inventing a delivery", async () => {
  const report = await runEvidenceComparison(dataset, [
    {
      id: "fixture",
      thinking: "configured",
      provider: { createProvisionalReply: async () => ({ text: "{invalid", finishReason: "stop" }) }
    }
  ]);
  expect(
    report.records.every(
      (r) =>
        r.delivered === null &&
        r.deliveryHash === null &&
        r.answer === null &&
        r.generated?.text === "{invalid" &&
        r.errorCode
    )
  ).toBe(true);
  const grades = {
    judge: { id: "reviewer", kind: "human" },
    ratings: report.records.map((r) => ({
      responseHash: r.responseHash,
      grade: "pass",
      rationale: "Cannot override missing delivery"
    }))
  };
  expect(gradeEvidenceComparison(report, grades).passed).toBe(false);
  expect(() =>
    gradeEvidenceComparison({ ...report, version: "evidence-comparison-v2" }, grades)
  ).toThrow();
});
it("grades saved delivery reports through the CLI without provider calls", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path"),
    { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util");
  const root = await mkdtemp(join(tmpdir(), "delivery-cli-"));
  try {
    const report = await runEvidenceComparison(dataset, [
      {
        id: "fixture",
        thinking: "configured",
        provider: {
          createProvisionalReply: async () => ({
            text: JSON.stringify({ status: "insufficient_evidence", reason: "No play data" }),
            finishReason: "stop"
          })
        }
      }
    ]);
    const reportPath = join(root, "report.json"),
      ratingsPath = join(root, "ratings.json");
    await writeFile(reportPath, JSON.stringify(report));
    await writeFile(
      ratingsPath,
      JSON.stringify({
        judge: { id: "fixture-reviewer", kind: "human" },
        ratings: report.records.map((r) => ({
          responseHash: r.responseHash,
          grade: "pass",
          rationale: "CLI transport fixture; not a quality assessment"
        }))
      })
    );
    await promisify(execFile)(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "src/eval/evidenceComparisonCli.ts",
      "grade",
      reportPath,
      ratingsPath
    ]);
    expect(JSON.parse(await readFile(reportPath + ".graded.json", "utf8"))).toMatchObject({
      version: "evidence-comparison-grading-v3",
      passed: true
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
