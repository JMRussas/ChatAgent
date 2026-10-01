import { describe, expect, it } from "vitest";
import {
  classifyTask,
  classifyTaskRequirements,
  type ModelTask
} from "../../src/routing/taskClassifier";

const corpus: [string, ModelTask][] = [
  ["Explain this code", "coding"],
  ["DEBUG the parser", "coding"],
  ["Help with debugging", "coding"],
  ["Refactor the function", "coding"],
  ["Explain a compiler diagnostic", "coding"],
  ["Help with a type-error", "coding"],
  ["Why this type error?", "coding"],
  ["TypeError: value is not callable", "coding"],
  ["What happened?\nTraceback (most recent call last):", "coding"],
  ["Interpret this stack trace", "coding"],
  ["Failure\n    at parse (parser.ts:12:3)", "coding"],
  ["Explain:\n```ts\nconst a = 1;\n```", "coding"],
  ["Explain:\n~~~python\nx = 1\n~~~", "coding"],
  ["Explain ```const a = 1```", "coding"],
  ["Summarize the supplied notes", "summarization"],
  ["SUMMARISE the supplied notes", "summarization"],
  ["Give a summary", "summarization"],
  ["Extract fields from the supplied text", "extraction"],
  ["Extract the fields from the supplied text", "extraction"],
  ["Return only valid JSON", "extraction"],
  ["Respond in JSON", "extraction"],
  ["Format the answer as JSON", "extraction"],
  ["Give me JSON", "extraction"],
  ["Compare the alternatives", "reasoning"],
  ["Design a garden", "reasoning"],
  ["Explain the tradeoffs", "reasoning"],
  ["Explain the trade-offs", "reasoning"],
  ["Analyze the supplied argument", "reasoning"],
  ["Analyse the supplied argument", "reasoning"],
  ["Hello, how are you?", "conversation"],
  ["Explain resource allocation", "conversation"],
  ["How do people encode memories?", "conversation"],
  ["What is a barcode?", "conversation"],
  ["What is JSON?", "conversation"],
  ["Why is data stored as JSON?", "conversation"],
  ["Explain vision and tools", "conversation"],
  ["Discuss a designer's work", "conversation"],
  ["Explain the summarizer", "conversation"],
  ["Summarize and compare this code", "coding"],
  ["Summarize the notes and return JSON", "summarization"],
  ["Compare the entries and extract fields", "extraction"],
  ["Compare the entries and return JSON", "extraction"],
  ["", "conversation"]
];

describe("spec 04 task classification corpus", () => {
  it.each(corpus)("%s -> %s", (text, task) => {
    expect(classifyTask(text)).toBe(task);
  });

  it("keeps short and complex coding task identity independent of route", () => {
    for (const routeDecision of ["direct", "deep"] as const) {
      expect(
        classifyTaskRequirements({
          text: "Explain code",
          routeDecision,
          inputTokens: 50,
          outputTokens: 100
        })
      ).toEqual({ task: "coding", requiredCapabilities: [], inputTokens: 50, outputTokens: 100 });
    }
  });

  it("uses conversation without eventual-task capabilities for clarification", () => {
    expect(
      classifyTaskRequirements({
        text: "Debug code and return JSON",
        routeDecision: "clarify",
        inputTokens: 50,
        outputTokens: 100
      })
    ).toMatchObject({ task: "conversation", requiredCapabilities: [] });
  });

  it("requires structured output even when coding or summary wins precedence", () => {
    for (const text of ["Debug code and return JSON", "Summarize as JSON"]) {
      expect(
        classifyTaskRequirements({
          text,
          routeDecision: "direct",
          inputTokens: 50,
          outputTokens: 100
        }).requiredCapabilities
      ).toEqual(["structuredOutput"]);
    }
  });

  it("does not infer action capabilities from mentions of tools, images or JSON", () => {
    expect(
      classifyTaskRequirements({
        text: "Explain tools, vision, images and JSON",
        routeDecision: "direct",
        inputTokens: 50,
        outputTokens: 100
      }).requiredCapabilities
    ).toEqual([]);
  });

  it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid token counts: %s",
    (count) => {
      for (const field of ["inputTokens", "outputTokens"] as const) {
        expect(() =>
          classifyTaskRequirements({
            text: "Hello",
            routeDecision: "direct",
            inputTokens: 0,
            outputTokens: 0,
            [field]: count
          })
        ).toThrow("nonnegative safe integers");
      }
    }
  );
});
