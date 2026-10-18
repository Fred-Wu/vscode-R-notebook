import { dump } from "js-yaml";

export interface YamlOption {
  description?: string;
  values?: Array<string | number | boolean | null>;
}
export type RMarkdownFormats = Record<string, Record<string, YamlOption>>;

const fields: Record<string, YamlOption> = {
  title: { description: "Document title." },
  subtitle: { description: "Document subtitle." },
  author: { description: "Author name or list of authors." },
  date: { description: "Publication date." },
  output: { description: "Output format, or a mapping of formats to their options." },
  abstract: { description: "Document abstract." },
  bibliography: { description: "Bibliography file or list of files." },
  csl: { description: "Citation Style Language file." },
  "link-citations": { description: "Link citations to bibliography entries.", values: [true, false] },
  "reference-section-title": { description: "Heading for the bibliography." },
  lang: { description: "Document language code, such as en-AU." },
  params: { description: "Named parameters passed to the document." },
  runtime: { description: "Document runtime.", values: ["static", "shiny", "shiny_prerendered"] },
  resource_files: { description: "Additional files needed by the document." },
  "header-includes": { description: "Content included in the document header." },
};

export const defaultRMarkdownFormats: RMarkdownFormats = Object.fromEntries([
  "html_document", "html_notebook", "pdf_document", "word_document", "odt_document",
  "rtf_document", "md_document", "github_document", "ioslides_presentation",
  "slidy_presentation", "beamer_presentation", "powerpoint_presentation",
].map(name => [name, {}]));

export interface YamlCompletionContext {
  parents: string[];
  key?: string;
  prefix: string;
  start: number;
  end: number;
  hasColon: boolean;
  siblings: Set<string>;
}

// Read only indentation and mapping keys, so incomplete YAML can still complete.
// Scalar contents and user-defined mappings (e.g. params) are not schema fields.
const mapping = /^( *)(?:"([^"]+)"|'([^']+)'|([\w.-]+(?:::[\w.-]+)?))\s*:(?:[ \t]+|$)(.*)$/;
export function rMarkdownYamlContext(source: string, row: number, column: number): YamlCompletionContext | undefined {
  const lines = source.split(/\r\n|\n|\r/);
  if (!/^---[ \t]*$/.test(lines[0] ?? "") || row === 0) return undefined;
  const line = lines[row] ?? "";
  if (/^(---|\.\.\.)[ \t]*$/.test(line)) return undefined;
  const before = line.slice(0, column);
  const indent = /^ */.exec(before)![0].length;
  const stack: Array<{ key: string; indent: number }> = [];
  let scalarIndent: number | undefined;
  for (let i = 1; i < row; i++) {
    const previous = lines[i]!;
    if (/^(---|\.\.\.)[ \t]*$/.test(previous)) return undefined;
    if (!previous.trim() || /^\s*#/.test(previous)) continue;
    const depth = /^ */.exec(previous)![0].length;
    if (scalarIndent !== undefined && depth > scalarIndent) continue;
    scalarIndent = undefined;
    while (stack.length && stack.at(-1)!.indent >= depth) stack.pop();
    const entry = mapping.exec(previous);
    if (!entry) continue;
    const value = entry[5]!.trim();
    if (/^[|>][\d+-]*(?:\s|$)/.test(value)) scalarIndent = depth;
    if (!value || value.startsWith("#")) stack.push({ key: entry[2] ?? entry[3] ?? entry[4]!, indent: depth });
  }
  if (scalarIndent !== undefined && indent > scalarIndent) return undefined;
  while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
  if (indent > 0 && !stack.length) return undefined;
  const entry = mapping.exec(before);
  const key = entry ? entry[2] ?? entry[3] ?? entry[4] : undefined;
  const token = entry ? entry[5]! : before.slice(indent);
  if (!/^[\w.-]*(?:::[\w.-]*)?$/.test(token)) return undefined;
  const start = column - token.length;
  const end = column + (/^[\w.-]*(?:::[\w.-]*)?/.exec(line.slice(column))?.[0].length ?? 0);
  // Suppress duplicate keys at this mapping depth, including keys after the cursor.
  const siblings = new Set<string>();
  for (const direction of [-1, 1]) {
    for (let i = row + direction; i > 0 && i < lines.length; i += direction) {
      const other = lines[i]!;
      if (/^(---|\.\.\.)[ \t]*$/.test(other)) break;
      if (!other.trim() || /^\s*#/.test(other)) continue;
      const depth = /^ */.exec(other)![0].length;
      if (depth < indent) break;
      const sibling = mapping.exec(other);
      if (depth === indent && sibling) siblings.add(sibling[2] ?? sibling[3] ?? sibling[4]!);
    }
  }
  return { parents: stack.map(parent => parent.key), key, prefix: token, start, end,
    hasColon: /^\s*:/.test(line.slice(end)), siblings };
}

export interface YamlSuggestion {
  label: string;
  insertText: string;
  description?: string;
  value: boolean;
  suggestValues: boolean;
}

export function rMarkdownYamlSuggestions(context: YamlCompletionContext, formats: RMarkdownFormats): YamlSuggestion[] {
  const { parents, key, prefix, siblings } = context;
  let options: Record<string, YamlOption> | undefined;
  if (!parents.length) options = fields;
  else if (parents[0] === "output" && parents.length === 1) {
    options = Object.fromEntries(Object.keys(formats).map(name => [name, { values: ["default"] }]));
  } else if (parents[0] === "output" && parents.length === 2) {
    options = formats[parents[1]!] ?? formats[parents[1]!.replace(/^rmarkdown::/, "")];
  } else if (parents[0] === "output" && parents.length === 3 && parents[2] === "includes") {
    options = Object.fromEntries(["in_header", "before_body", "after_body"].map(name => [name, {}]));
  }
  if (!options) return [];
  if (key !== undefined) {
    const values = !parents.length && key === "output" ? Object.keys(formats) : options[key]?.values ?? [];
    return values.filter(value => String(value).startsWith(prefix)).map(value => ({
      label: String(value), insertText: dump(value).trim(), value: true, suggestValues: false,
    }));
  }
  return Object.entries(options).filter(([name]) => name.startsWith(prefix) && !siblings.has(name)).map(([name, option]) => ({
    label: name, insertText: name + (context.hasColon ? "" : ": "),
    description: option.description, value: false, suggestValues: Boolean(option.values?.length) || name === "output",
  }));
}

/** Inspect defaults without calling output formats or evaluating their expressions. */
export const rMarkdownFormatsExpression = String.raw`
if (!requireNamespace("rmarkdown", quietly=TRUE)) stop("Install rmarkdown for output-format completions")
result <- list()
for (pkg in c("rmarkdown", "bookdown")) {
  if (!requireNamespace(pkg, quietly=TRUE)) next
  for (name in sort(getNamespaceExports(pkg))) {
    if (!grepl("^([[:alnum:]]+_document2?|[[:alnum:]]+_presentation|html_notebook)$", name)) next
    fn <- getExportedValue(pkg, name)
    if (!is.function(fn)) next
    defaults <- formals(fn)
    options <- list()
    for (key in setdiff(names(defaults), "...")) {
      values <- list()
      if (identical(defaults[[key]], quote(expr=))) {
        options[[key]] <- list(description=paste0(pkg, "::", name, " - required argument"), values=values)
        next
      }
      expr <- defaults[[key]]
      if (is.logical(expr) && length(expr) == 1L && !is.na(expr)) values <- list(TRUE, FALSE)
      else if (is.character(expr) || is.numeric(expr)) values <- as.list(expr)
      else if (is.call(expr) && identical(expr[[1L]], as.name("c"))) {
        args <- as.list(expr)[-1L]
        if (all(vapply(args, function(x) is.character(x) && length(x) == 1L, logical(1)))) values <- args
      }
      options[[key]] <- list(description=paste0(pkg, "::", name, " - default: ", paste(deparse(expr), collapse=" ")), values=unname(values))
    }
    label <- if (pkg == "rmarkdown") name else paste0(pkg, "::", name)
    result[[label]] <- options
  }
}
cat(jsonlite::toJSON(result, auto_unbox=TRUE, null="null"))
`;
