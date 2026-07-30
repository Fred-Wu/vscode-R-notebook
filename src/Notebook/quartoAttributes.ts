import {
  quartoFormatApplies,
  type QuartoFormats,
} from "./quartoFormats";

export type QuartoAttributeContext =
  "div" | "heading" | "figure" | "codeblock";

export interface QuartoAttributeGroup {
  contexts?: unknown;
  formats?: unknown;
  filter?: unknown;
  completions?: unknown;
}

export function quartoAttributeGroupApplies(
  group: QuartoAttributeGroup,
  context: QuartoAttributeContext,
  formats: QuartoFormats,
  line: string
): boolean {
  return Array.isArray(group.contexts) &&
    group.contexts.includes(context) &&
    quartoFormatApplies(
      Array.isArray(group.formats) ? group.formats : [],
      formats
    ) &&
    (
      typeof group.filter !== "string" ||
      new RegExp(group.filter).test(line)
    ) &&
    Array.isArray(group.completions);
}
