import assert from "node:assert/strict";
import test from "node:test";
import { quartoOptionCompletions } from "../../src/Notebook/optionSchema";

test("reads option names and values from the installed Quarto schema shape", () => {
  const definitions = {
    "engine-knitr": {
      properties: {
        echo: { type: "ref", $ref: "echo-option" },
        "fig-cap": { type: "string" },
      },
    },
    "echo-option": {
      type: "anyOf",
      anyOf: [
        { type: "boolean", completions: ["true", "false"] },
        { type: "enum", enum: ["fenced"] },
      ],
    },
  };

  assert.deepEqual(quartoOptionCompletions(definitions), [
    { name: "echo", values: ["true", "false", "fenced"] },
    { name: "fig-cap" },
  ]);
});
