import {
  DEFAULT_SCHEMA,
  load as loadYaml,
  Type as YamlType,
} from "js-yaml";
import { sourceLines, type ChunkMetadata } from "./document";
import type { OptionCompletion } from "./optionSchema";
import { isQuartoNotebook } from "../notebookFile";

export const CELL_OPTIONS_MIME = "application/vnd.r-notebook.cell-options+json";

const cellOptionYamlSchema = DEFAULT_SCHEMA.extend([
  new YamlType("!expr", {
    kind: "scalar",
    construct: (value: string | null) => value ?? "",
  }),
  new YamlType("!r", {
    kind: "scalar",
    construct: (value: string | null) => value ?? "",
  }),
]);

export interface CellOptionsFormData {
  requestId: string;
  documentKind: "quarto" | "rMarkdown";
  label: string;
  headerOptions: string;
  quartoOptions: string;
  rMarkdownCompletions: OptionCompletion[];
  quartoCompletions: OptionCompletion[];
}

export function cellOptionsRequestId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const requestId = (metadata as { rNotebookCellOptions?: unknown })
    .rNotebookCellOptions;
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : undefined;
}

const openingFencePattern = /^((?: {0,3})(?:`{3,}|~{3,}))[ \t]*\{(.*)\}[ \t]*(\r\n|\n|\r)?$/;

export function chunkHeader(openingFence: string): string | undefined {
  return openingFencePattern.exec(openingFence)?.[2];
}

export function chunkEngine(header: string): string | undefined {
  const normalized = header.trim().replace(/^\{(.*)\}$/, "$1").trim();
  const engine = normalized.split(/[\s,]+/, 1)[0]?.trim().toLowerCase();
  return engine && !/^[.#=]/.test(engine) && !engine.includes("=")
    ? engine
    : undefined;
}

interface ChunkHeaderFields {
  label: string;
  options: string;
}

export function chunkHeaderFields(
  header: string,
  engine: string
): ChunkHeaderFields {
  const normalized = header.trim().replace(/^\{(.*)\}$/, "$1").trim();
  const parsedEngine = chunkEngine(normalized);
  if (parsedEngine !== engine.toLowerCase()) {
    throw new Error(`The chunk header does not use the expected '${engine}' engine.`);
  }
  const remainder = normalized.slice(parsedEngine.length).trim();
  if (!remainder) {
    return { label: "", options: "" };
  }
  if (remainder.startsWith(",")) {
    return { label: "", options: remainder.slice(1).trim() };
  }
  const separator = remainder.indexOf(",");
  if (separator < 0) {
    return remainder.includes("=")
      ? { label: "", options: remainder }
      : { label: remainder, options: "" };
  }
  return {
    label: remainder.slice(0, separator).trim(),
    options: remainder.slice(separator + 1).trim(),
  };
}

export function updateChunkHeaderFields(
  chunk: ChunkMetadata,
  label: string,
  options: string
): ChunkMetadata {
  const normalizedLabel = label.trim();
  if (normalizedLabel && !/^[^\s,{}]+$/.test(normalizedLabel)) {
    throw new Error("The chunk label cannot contain spaces, commas, or braces.");
  }
  const normalizedOptions = options.trim().replace(/^,\s*/, "");
  if (/\r|\n/.test(normalizedOptions)) {
    throw new Error("R Markdown header options must stay on one line.");
  }
  const header = [
    chunk.engine,
    normalizedLabel ? ` ${normalizedLabel}` : "",
    normalizedOptions ? `, ${normalizedOptions}` : "",
  ].join("");
  return updateChunkHeader(chunk, header);
}

export function updateChunkHeader(
  chunk: ChunkMetadata,
  header: string
): ChunkMetadata {
  const match = openingFencePattern.exec(chunk.openingFence);
  if (!match?.[1]) {
    throw new Error("The cell has an invalid native chunk opening fence.");
  }
  const normalized = header.trim().replace(/^\{(.*)\}$/, "$1").trim();
  const engine = chunkEngine(normalized);
  if (!engine) {
    throw new Error("Enter a chunk engine followed by any options, for example: r, echo=FALSE");
  }
  if (engine !== chunk.engine.toLowerCase()) {
    throw new Error(`The chunk engine must remain '${chunk.engine}'.`);
  }
  return {
    ...chunk,
    openingFence: `${match[1]}{${normalized}}${match[3] ?? ""}`,
  };
}

export function quartoOptionLines(source: string): string[] {
  const lines = source.split(/\r\n|\n|\r/);
  const options: string[] = [];
  let started = false;
  for (const line of lines) {
    if (!started && line.trim().length === 0) {
      continue;
    }
    const match = /^\s*#\|\s?(.*)$/.exec(line);
    if (!match) {
      break;
    }
    started = true;
    options.push(match[1] ?? "");
  }
  return options;
}

interface QuartoOptionFields {
  label: string;
  options: string;
}

export function quartoOptionFields(source: string): QuartoOptionFields {
  let label = "";
  const options: string[] = [];
  for (const line of quartoOptionLines(source)) {
    const match = /^\s*label\s*:\s*(.*)$/i.exec(line);
    if (match && !label) {
      label = match[1] ?? "";
    } else {
      options.push(line);
    }
  }
  return { label, options: options.join("\n") };
}

export function codeCellLabel(
  source: string,
  chunk: ChunkMetadata | undefined
): string {
  const quartoLabel = quartoOptionFields(source).label.trim();
  if (quartoLabel || !chunk) {
    return quartoLabel;
  }
  const header = chunkHeader(chunk.openingFence);
  return header === undefined
    ? ""
    : chunkHeaderFields(header, chunk.engine).label.trim();
}

export function removeHeaderLabelShadowedByPipe(
  source: string,
  chunk: ChunkMetadata
): ChunkMetadata | undefined {
  if (!quartoOptionFields(source).label.trim()) {
    return undefined;
  }
  const header = chunkHeader(chunk.openingFence);
  if (header === undefined) {
    return undefined;
  }
  const fields = chunkHeaderFields(header, chunk.engine);
  return fields.label
    ? updateChunkHeaderFields(chunk, "", fields.options)
    : undefined;
}

interface CodeCellRenderOptions {
  label: string;
  pipeOptions: ReadonlyMap<string, string>;
  figureCaption?: string;
  tableCaption?: string;
}

function optionValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value).toLowerCase();
}

function rMarkdownOptionFields(options: string): string[] {
  const fields: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < options.length; index += 1) {
    const character = options[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth = Math.max(0, depth - 1);
    } else if (character === "," && depth === 0) {
      fields.push(options.slice(start, index).trim());
      start = index + 1;
    }
  }
  fields.push(options.slice(start).trim());
  return fields.filter(Boolean);
}

export function codeCellRenderOptions(
  source: string,
  chunk: ChunkMetadata | undefined,
  documentKind: "quarto" | "rMarkdown"
): CodeCellRenderOptions {
  let headerFigureCaption: string | undefined;
  let headerTableCaption: string | undefined;
  const header = documentKind === "rMarkdown" && chunk ? chunkHeader(chunk.openingFence) : undefined;
  if (chunk && header !== undefined) {
    const fields = chunkHeaderFields(header, chunk.engine);
    for (const option of rMarkdownOptionFields(fields.options)) {
      const separator = option.indexOf("=");
      if (separator < 1) {
        continue;
      }
      const name = option.slice(0, separator).trim();
      if (name !== "fig.cap" && name !== "tab.cap") {
        continue;
      }
      let value = option.slice(separator + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (name === "fig.cap") {
        headerFigureCaption = value;
      } else {
        headerTableCaption = value;
      }
    }
  }

  const pipeOptions = new Map<string, string>();
  const quartoLines = quartoOptionLines(source);
  if (quartoLines.length > 0) {
    try {
      const parsed = loadYaml(quartoLines.join("\n"), {
        schema: cellOptionYamlSchema,
      });
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed)) {
          if (name !== "label" && /^[A-Za-z_:][\w:.-]*$/.test(name)) {
            pipeOptions.set(name, optionValue(value));
          }
        }
      }
    } catch {
      // The editor can temporarily contain incomplete YAML while the user types.
    }
  }
  const tablePipeName = documentKind === "quarto" ? "tbl-cap" : "tab-cap";
  return {
    label: codeCellLabel(source, chunk),
    pipeOptions,
    figureCaption: documentKind === "quarto" || pipeOptions.has("fig-cap")
      ? pipeOptions.get("fig-cap")
      : headerFigureCaption,
    tableCaption: documentKind === "quarto" || pipeOptions.has(tablePipeName)
      ? pipeOptions.get(tablePipeName)
      : headerTableCaption,
  };
}

export function updateQuartoOptionLines(
  source: string,
  optionText: string
): string {
  const lines = sourceLines(source);
  let first = 0;
  while (first < lines.length && lines[first]?.content.trim().length === 0) {
    first += 1;
  }
  let last = first;
  while (last < lines.length && /^\s*#\|(?:\s|$)/.test(lines[last]?.content ?? "")) {
    last += 1;
  }
  const start = lines[first]?.start ?? source.length;
  const end = last > first ? lines[last - 1]?.end ?? start : start;
  const eol = /\r\n|\n|\r/.exec(source)?.[0] ?? "\n";
  const optionLines = optionText
    .replace(/\r\n|\r/g, "\n")
    .split("\n");
  while (optionLines.length > 0 && optionLines[optionLines.length - 1] === "") {
    optionLines.pop();
  }
  const replacement = optionLines.length === 0
    ? ""
    : optionLines
      .map((line) => line.length > 0 ? `#| ${line}${eol}` : `#|${eol}`)
      .join("");
  return source.slice(0, start) + replacement + source.slice(end);
}

export function updateQuartoOptionFields(
  source: string,
  label: string,
  options: string
): string {
  const normalizedLabel = label.trim();
  if (/\r|\n/.test(normalizedLabel)) {
    throw new Error("The Quarto label must stay on one line.");
  }
  const lines = [
    ...(normalizedLabel ? [`label: ${normalizedLabel}`] : []),
    options.replace(/\r\n|\r/g, "\n").replace(/^\n+|\n+$/g, ""),
  ].filter((line) => line.length > 0);
  return updateQuartoOptionLines(source, lines.join("\n"));
}

export function rMarkdownStatusHeader(
  notebookPath: string,
  chunk: ChunkMetadata,
  source: string
): string | undefined {
  if (isQuartoNotebook(notebookPath)) {
    return undefined;
  }
  const header = chunkHeader(chunk.openingFence);
  if (header === undefined) {
    return undefined;
  }
  const fields = chunkHeaderFields(header, chunk.engine);
  if (!fields.label && !fields.options && quartoOptionLines(source).length > 0) {
    return undefined;
  }
  return `{${header.trim()}}`;
}
