import { describe, expect, it } from "vitest";
import {
  mergeModelRequestOptions,
  parseOpenAiReasoningEffort,
  toOpenAiServiceTierParam,
} from "../src/llm/model-options.js";

describe("model request options", () => {
  it("treats thinking as a reasoning effort alias when merging", () => {
    expect(mergeModelRequestOptions({ thinking: "medium" })).toEqual({
      reasoningEffort: "medium",
    });
  });

  it("maps summarize fast/default tiers to OpenAI request params", () => {
    expect(toOpenAiServiceTierParam("fast")).toBe("priority");
    expect(toOpenAiServiceTierParam("default")).toBeUndefined();
    expect(toOpenAiServiceTierParam("flex")).toBe("flex");
  });

  it("accepts only live-supported OpenAI reasoning efforts", () => {
    expect(parseOpenAiReasoningEffort("off")).toBe("none");
    expect(parseOpenAiReasoningEffort("min")).toBe("low");
    expect(parseOpenAiReasoningEffort("mid")).toBe("medium");
    expect(parseOpenAiReasoningEffort("x-high")).toBe("xhigh");
    expect(() => parseOpenAiReasoningEffort("minimal")).toThrow(/expected none, low/);
  });
});
