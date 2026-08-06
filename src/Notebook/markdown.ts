import { serializeDocument, type ParsedCell } from "./document";
import { codeCellRenderOptions, quartoOptionLines } from "./options";
import { splitFrontMatter } from "../markdown";

interface NativeTextCell {
  id: string;
  marker: string;
  token: string;
  source: string;
}

interface NativeTextDocument {
  source: string;
  cells: NativeTextCell[];
  replacements: Array<{ token: string; source: string }>;
}

export function nativeCodeOptionSignature(cells: readonly ParsedCell[]): string {
  const options = cells.flatMap((cell) => cell.kind === "code"
    ? [{
        openingFence: cell.chunk?.openingFence ?? "",
        quartoOptions: quartoOptionLines(cell.value),
      }]
    : []
  );
  return JSON.stringify(options);
}

function divFence(source: string): string {
  let length = 3;
  for (const match of source.matchAll(/^ {0,3}(:{3,})/gm)) {
    length = Math.max(length, (match[1]?.length ?? 0) + 1);
  }
  return ":".repeat(length);
}

export function nativeTextDocument(
  cells: readonly ParsedCell[],
  markupIds: ReadonlyMap<number, string>,
  eol: string,
  documentKind: "quarto" | "rMarkdown"
): NativeTextDocument {
  const nativeCells: NativeTextCell[] = [];
  const replacements: Array<{ token: string; source: string }> = [];
  const shadowCells = cells.map((cell, index): ParsedCell => {
    if (cell.kind === "code") {
      const renderOptions = codeCellRenderOptions(cell.value, cell.chunk, documentKind);
      const validLabel = /^[A-Za-z][\w:.-]*$/.test(renderOptions.label);
      let placeholder = `<!-- r-notebook-code-cell -->${eol}`;
      if (validLabel && documentKind === "quarto") {
        const attributes = [...renderOptions.pipeOptions].map(([name, value]) => {
          const escaped = value
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/\r\n|\n|\r/g, " ");
          return `${name}="${escaped}"`;
        });
        const attributeText = attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
        placeholder = `::: {#${renderOptions.label}${attributeText}}${eol}:::${eol}`;
      } else if (validLabel) {
        const figureCaption = renderOptions.figureCaption;
        const tableCaption = renderOptions.tableCaption;
        const caption = figureCaption || tableCaption;
        if (caption) {
          const escapedCaption = caption
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          placeholder = figureCaption
            ? [
                '<div class="figure">',
                `<p class="caption">(\\#fig:${renderOptions.label}) ${escapedCaption}</p>`,
                "</div>",
                "",
              ].join(eol)
            : [
                "<table>",
                `<caption>(\\#tab:${renderOptions.label}) ${escapedCaption}</caption>`,
                "</table>",
                "",
              ].join(eol);
        }
      }
      return {
        kind: "markup",
        value: placeholder,
        languageId: "markdown",
      };
    }
    const id = markupIds.get(index);
    if (!id) {
      return cell;
    }
    const split = index === 0
      ? splitFrontMatter(cell.value)
      : { frontMatter: "", body: cell.value };
    const key = id.replace(/[^A-Za-z0-9_-]/g, "-");
    const marker = `r-notebook-markdown-${key}`;
    const token = `VSC_R_NOTEBOOK_MARKDOWN_${key}`;
    const fence = divFence(split.body);
    const separator = split.frontMatter.length === 0
      ? ""
      : /(?:\r\n|\n|\r)$/.test(split.frontMatter)
        ? eol
        : eol + eol;
    const nativeCell = { id, marker, token, source: split.body };
    nativeCells.push(nativeCell);
    replacements.push(nativeCell);
    return {
      ...cell,
      value: [
        split.frontMatter,
        separator,
        `${fence} {#${marker} .r-notebook-markdown-cell}`,
        eol,
        token,
        eol,
        fence,
        eol,
      ].join(""),
    };
  });
  return {
    source: serializeDocument(shadowCells, eol),
    cells: nativeCells,
    replacements,
  };
}
