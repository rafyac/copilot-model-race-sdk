import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ModelInfo } from "@github/copilot-sdk";
import {
  DEFAULT_JUDGE,
  DEFAULT_MODELS,
  DEFAULT_PROMPT,
  allRaceInputsSupplied,
  defaultModelsInOrder,
  initialRaceConfig,
  modelChoiceLabel,
  parseArgs,
  pricingFor,
  resolveModel,
} from "./model-race.ts";

const models = [
  model("mai-code-1-flash-internal", "MAI-Code-1-Flash"),
  model("claude-haiku-4.5", "Claude Haiku 4.5"),
  model("gpt-5-mini", "GPT-5 mini"),
  model("gpt-5.5", "GPT-5.5"),
];

function model(id: string, name: string): ModelInfo {
  return { id, name, capabilities: { limits: {} } } as ModelInfo;
}

describe("model race CLI config", () => {
  it("parses flags and boolean switches", () => {
    assert.deepEqual(
      parseArgs([
        "--models",
        "mai,gpt-5-mini",
        "--prompt",
        "Say OK",
        "--judge",
        "gpt-5.5",
        "--no-stream",
      ]),
      {
        models: "mai,gpt-5-mini",
        prompt: "Say OK",
        judge: "gpt-5.5",
        stream: false,
      },
    );
  });

  it("uses defaults when no race inputs are supplied", () => {
    assert.deepEqual(initialRaceConfig({}), {
      modelQueries: DEFAULT_MODELS,
      userPrompt: DEFAULT_PROMPT,
      judgeEnabled: true,
      judgeQuery: DEFAULT_JUDGE,
    });
  });

  it("recognizes a fully specified direct run", () => {
    assert.equal(
      allRaceInputsSupplied({
        models: "mai,gpt-5-mini",
        prompt: "Say OK",
        judge: false,
      }),
      true,
    );
    assert.equal(allRaceInputsSupplied({ models: "mai", prompt: "Say OK" }), false);
  });
});

describe("model race model resolution", () => {
  it("resolves exact ids, display names, and the mai alias", () => {
    assert.equal(resolveModel(models, "gpt-5-mini").id, "gpt-5-mini");
    assert.equal(resolveModel(models, "Claude Haiku").id, "claude-haiku-4.5");
    assert.equal(resolveModel(models, "mai").id, "mai-code-1-flash-internal");
  });

  it("keeps selected defaults in query order and removes duplicates", () => {
    assert.deepEqual(
      defaultModelsInOrder(models, ["gpt-5-mini", "mai", "gpt-5-mini"]).map((m) => m.id),
      ["gpt-5-mini", "mai-code-1-flash-internal"],
    );
  });

  it("formats labels without duplicating matching name/id values", () => {
    assert.equal(modelChoiceLabel(model("auto", "auto")), "auto");
    assert.equal(modelChoiceLabel(models[0]), "MAI-Code-1-Flash (mai-code-1-flash-internal)");
  });

  it("returns undefined pricing for new or unknown models", () => {
    assert.equal(pricingFor(model("future-model-1", "Future Model 1")), undefined);
    assert.deepEqual(pricingFor(models[0]), { input: 0.75, output: 4.5 });
  });
});
