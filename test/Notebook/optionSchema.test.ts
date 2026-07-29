import assert from "node:assert/strict";
import test from "node:test";
import {
  knitrOptionCompletions,
  quartoOptionCompletions,
} from "../../src/Notebook/optionSchema";

test("uses installed knitr options for both R Markdown cell option styles", () => {
  assert.deepEqual(knitrOptionCompletions([
    "option\techo\tlogical",
    "option\terror\tlogical",
    "option\tfig.align\tcharacter",
    "option\tfig.keep\tcharacter",
    "option\tfig.show\tcharacter",
    "option\tfig.width\tdouble",
    "option\tresults\tcharacter",
    "option\ttidy\tlogical",
    "ignored\twarning\tlogical",
    "",
  ].join("\n")), {
    rMarkdown: [
      { name: "echo", values: ["TRUE", "FALSE"] },
      { name: "error", values: ["FALSE", "TRUE", "0", "1", "2"] },
      {
        name: "fig.align",
        values: ["'default'", "'left'", "'right'", "'center'"],
      },
      {
        name: "fig.keep",
        values: ["'high'", "'none'", "'all'", "'first'", "'last'"],
      },
      {
        name: "fig.show",
        values: ["'asis'", "'hold'", "'animate'", "'hide'"],
      },
      { name: "fig.width" },
      {
        name: "results",
        values: ["'markup'", "'asis'", "'hold'", "'hide'", "FALSE"],
      },
      {
        name: "tidy",
        values: ["FALSE", "TRUE", "'formatR'", "'styler'"],
      },
    ],
    quarto: [
      { name: "echo", values: ["true", "false"] },
      { name: "error", values: ["false", "true", "0", "1", "2"] },
      {
        name: "fig-align",
        values: ["default", "left", "right", "center"],
      },
      {
        name: "fig-keep",
        values: ["high", "none", "all", "first", "last"],
      },
      {
        name: "fig-show",
        values: ["asis", "hold", "animate", "hide"],
      },
      { name: "fig-width" },
      {
        name: "results",
        values: ["markup", "asis", "hold", "hide", "false"],
      },
      {
        name: "tidy",
        values: ["false", "true", "formatR", "styler"],
      },
    ],
  });
});

test("keeps Quarto option names separate from knitr option names", () => {
  const definitions = {
    "engine-knitr": {
      properties: {
        echo: { type: "ref", $ref: "echo-option" },
        "fig-cap": { type: "string" },
        "fig-width": { type: "number" },
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
    { name: "fig-width" },
  ]);
});
