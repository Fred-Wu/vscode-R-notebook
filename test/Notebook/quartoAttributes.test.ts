import assert from "node:assert/strict";
import test from "node:test";
import {
  quartoAttributeGroupApplies,
  type QuartoAttributeGroup,
} from "../../src/Notebook/quartoAttributes";

const dashboardFormats = {
  document: ["dashboard"],
  project: [],
};

function headingGroup(filter: string): QuartoAttributeGroup {
  return {
    contexts: ["heading"],
    formats: ["dashboard"],
    filter,
    completions: [{ value: ".example" }],
  };
}

test("applies Quarto heading filters to the complete Markdown line", () => {
  assert.equal(
    quartoAttributeGroupApplies(
      headingGroup("^# "),
      "heading",
      dashboardFormats,
      "# Sales {.}"
    ),
    true
  );
  assert.equal(
    quartoAttributeGroupApplies(
      headingGroup("^# "),
      "heading",
      dashboardFormats,
      "## Sales {.}"
    ),
    false
  );
  assert.equal(
    quartoAttributeGroupApplies(
      headingGroup("^##? "),
      "heading",
      dashboardFormats,
      "## Sales {.}"
    ),
    true
  );
  assert.equal(
    quartoAttributeGroupApplies(
      headingGroup("^#{2,} "),
      "heading",
      dashboardFormats,
      "### Sales {.}"
    ),
    true
  );
});

test("keeps Quarto filters for existing attributes", () => {
  const cardGroup: QuartoAttributeGroup = {
    contexts: ["div"],
    formats: ["dashboard"],
    filter: "\\.card",
    completions: [{ value: "padding=\"$0\"" }],
  };
  assert.equal(
    quartoAttributeGroupApplies(
      cardGroup,
      "div",
      dashboardFormats,
      "::: {.card }"
    ),
    true
  );
  assert.equal(
    quartoAttributeGroupApplies(
      cardGroup,
      "div",
      dashboardFormats,
      "::: {.valuebox }"
    ),
    false
  );
});
