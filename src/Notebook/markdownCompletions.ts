import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { load as loadYaml } from "js-yaml";
import * as vscode from "vscode";
import { NOTEBOOK_TYPE, type RNotebookCellMetadata } from "./document";
import { codeCellRenderOptions } from "./options";
import {
  configuredQuartoExecutable,
  quartoInstallationPaths,
} from "./optionCompletions";

export const markdownCompletionTriggers = [
  ".", "$", "@", ":", "\\", "=", "/", "#", "[", "]", "(", "{", "-", "`", "*", "_", ">",
];

type MarkdownSnippet = readonly [label: string, body: string, description: string];

const markdownSnippets: readonly MarkdownSnippet[] = [
  ["bold", "**${TM_SELECTED_TEXT:${1:text}}**$0", "Bold text"],
  ["italic", "*${TM_SELECTED_TEXT:${1:text}}*$0", "Italic text"],
  ["strikethrough", "~~${TM_SELECTED_TEXT:${1:text}}~~$0", "Strikethrough text"],
  ["quote", "> ${TM_SELECTED_TEXT:${1:text}}$0", "Block quote"],
  ["inline code", "`${TM_SELECTED_TEXT:${1:code}}`$0", "Inline code"],
  ["fenced code block", "```${1:language}\n${2:${TM_SELECTED_TEXT}}\n```\n$0", "Fenced code block"],
  ["heading", "# ${TM_SELECTED_TEXT:${1:Heading}}$0", "Heading"],
  ["unordered list", "- ${1:first}\n- ${2:second}\n- ${3:third}\n$0", "Unordered list"],
  ["ordered list", "1. ${1:first}\n2. ${2:second}\n3. ${3:third}\n$0", "Ordered list"],
  ["task list", "- [ ] ${1:first}\n- [ ] ${2:second}\n$0", "Task list"],
  ["link", "[${1:text}](${2:path})$0", "Link"],
  ["image", "![${1:alt}](${2:path})$0", "Image"],
  ["table", "| ${1:Column 1} | ${2:Column 2} |\n| --- | --- |\n| ${3:value} | ${4:value} |\n$0", "Table"],
  ["footnote", "[^${1:id}]$0", "Footnote reference"],
  ["citation", "[@${1:key}]$0", "Pandoc citation"],
  ["inline math", "\\$${1:expression}\\$$0", "Inline equation"],
  ["display math", "\\$\\$\n${1:expression}\n\\$\\$\n$0", "Display equation"],
  ["div", "::: {${1:.class}}\n${TM_SELECTED_TEXT:${2:Content}}\n:::\n$0", "Pandoc Div"],
  ["span", "[${TM_SELECTED_TEXT:${1:text}}]{${2:.class}}$0", "Pandoc span"],
];

const quartoSnippets: readonly MarkdownSnippet[] = [
  ["Quarto callout", "::: {.callout-${1|note,tip,important,warning,caution|}}\n## ${2:Title}\n\n${3:Content}\n:::\n$0", "Quarto callout"],
  ["Quarto shortcode", "{{< ${1:shortcode} >}}$0", "Quarto shortcode"],
  ["Quarto cross-reference", "@${1:fig-label}$0", "Quarto cross-reference"],
  ["Quarto columns", "::: {.columns}\n::: {.column}\n${1:Left}\n:::\n::: {.column}\n${2:Right}\n:::\n:::\n$0", "Quarto columns"],
  ["Quarto R code cell", "```{r}\n${1}\n```\n$0", "Executable R code cell"],
  ["Quarto inline R", "`r ${1:expression}`$0", "Inline R expression"],
];

const rMarkdownSnippets: readonly MarkdownSnippet[] = [
  ["R Markdown code chunk", "```{r ${1:label}}\n${2}\n```\n$0", "R code chunk"],
  ["R Markdown inline R", "`r ${1:expression}`$0", "Inline R expression"],
  ["R Markdown figure reference", "\\@ref(fig:${1:label})$0", "Bookdown figure reference"],
  ["R Markdown table reference", "\\@ref(tab:${1:label})$0", "Bookdown table reference"],
  ["R Markdown tabset", "## ${1:Heading} {.tabset}\n\n### ${2:Tab}\n\n${3:Content}\n$0", "R Markdown tabset"],
];

interface RMarkdownFrontMatterField {
  name: string;
  description: string;
  values?: readonly string[];
  block?: boolean;
}

const rMarkdownFrontMatterFields: readonly RMarkdownFrontMatterField[] = [
  { name: "abstract", description: "Document abstract" },
  { name: "always_allow_html", description: "Allow HTML dependencies in non-HTML output", values: ["true", "false"] },
  { name: "author", description: "Document author" },
  { name: "bibliography", description: "Bibliography file" },
  { name: "csl", description: "Citation style file" },
  { name: "date", description: "Document date" },
  { name: "description", description: "Document description" },
  { name: "header-includes", description: "Content added to the document header", block: true },
  { name: "keywords", description: "Document keywords", block: true },
  { name: "knit", description: "Custom knit function" },
  { name: "lang", description: "Document language" },
  { name: "link-citations", description: "Link citations to bibliography entries", values: ["true", "false"] },
  { name: "nocite", description: "Bibliography entries included without citation" },
  { name: "output", description: "R Markdown output format", block: true },
  { name: "pagetitle", description: "HTML page title" },
  { name: "params", description: "Parameterized report values", block: true },
  { name: "resource_files", description: "Additional files required by the document", block: true },
  { name: "runtime", description: "Document runtime", values: ["static", "shiny", "shiny_prerendered"] },
  { name: "site", description: "R Markdown site generator" },
  { name: "subtitle", description: "Document subtitle" },
  { name: "title", description: "Document title" },
];

interface QuartoCompletion {
  type?: "key" | "value";
  display?: string;
  value: string;
  description?: string;
  suggest_on_accept?: boolean;
}

interface QuartoCompletionResult {
  token: string;
  completions: QuartoCompletion[];
}

interface QuartoEditorModule {
  getCompletions(context: {
    code: string;
    filetype: "markdown";
    path: string;
    position: { row: number; column: number };
    line: string;
    formats: string[];
    project_formats: string[];
    client: "vscode";
  }): Promise<QuartoCompletionResult | null>;
}

interface QuartoAttributeCompletion {
  value?: unknown;
  doc?: unknown;
}

interface QuartoAttributeGroup {
  contexts?: unknown;
  formats?: unknown;
  filter?: unknown;
  completions?: unknown;
}

interface QuartoEditorSupport {
  editor: QuartoEditorModule;
  attributes: QuartoAttributeGroup[];
}

export class RNotebookMarkdownCompletionProvider implements
  vscode.CompletionItemProvider,
  vscode.Disposable {
  private readonly modules = new Map<string, Promise<QuartoEditorSupport | undefined>>();

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly loadRMarkdownOutputFormats: (
      notebookUri: vscode.Uri
    ) => Promise<readonly string[]>
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionList> {
    const documentKey = document.uri.toString();
    const notebook = vscode.workspace.notebookDocuments.find((candidate) =>
      candidate.notebookType === NOTEBOOK_TYPE &&
      candidate.getCells().some((cell) =>
        cell.document.uri.toString() === documentKey
      )
    );
    const cell = notebook?.getCells().find((candidate) =>
      candidate.document.uri.toString() === documentKey
    );
    if (!notebook || !cell || cell.kind !== vscode.NotebookCellKind.Markup) {
      return new vscode.CompletionList();
    }

    const source = document.getText();
    const sourceOffset = document.offsetAt(position);
    const opening = cell.index === 0
      ? /^---[ \t]*(?:\r\n|\n|\r)/.exec(source)
      : undefined;
    const closing = opening
      ? /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/m.exec(source.slice(opening[0].length))
      : undefined;
    const inYaml = Boolean(
      opening &&
      sourceOffset >= opening[0].length &&
      (!closing || sourceOffset <= opening[0].length + closing.index)
    );
    const isQuarto = notebook.uri.path.toLowerCase().endsWith(".qmd");

    if (!inYaml) {
      const referenceItems = this.referenceCompletions(
        notebook,
        document,
        position,
        isQuarto
      );
      const pathItems = await this.pathCompletions(notebook, document, position);
      const currentLine = document.lineAt(position.line).text;
      const support = isQuarto && (currentLine.includes("{") || /^\s*:{3,}/.test(currentLine))
        ? await this.loadQuarto(notebook.uri)
        : undefined;
      const attributeItems = support
        ? this.attributeCompletions(support.attributes, document, position)
        : [];
      const contextualItems = [...referenceItems, ...pathItems, ...attributeItems];
      if (contextualItems.length > 0) {
        return new vscode.CompletionList(contextualItems, false);
      }
      if (context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter) {
        return new vscode.CompletionList();
      }
      const formatSnippets = isQuarto ? quartoSnippets : rMarkdownSnippets;
      const items = [...formatSnippets, ...markdownSnippets].map(([label, body, description], index) => {
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString(body);
        item.detail = description;
        item.sortText = index < formatSnippets.length ? `0${index}` : `1${index}`;
        return item;
      });
      return new vscode.CompletionList(items, false);
    }

    if (!isQuarto) {
      const items = await this.rMarkdownYamlCompletions(
        notebook.uri,
        document,
        position
      );
      return new vscode.CompletionList(items, false);
    }

    const support = await this.loadQuarto(notebook.uri);
    if (!support || token.isCancellationRequested) {
      return new vscode.CompletionList();
    }
    const line = document.lineAt(position.line).text.slice(0, position.character);
    const completion = await support.editor.getCompletions({
      code: source,
      filetype: "markdown",
      path: notebook.uri.fsPath,
      position: { row: position.line, column: position.character },
      line,
      formats: [],
      project_formats: [],
      client: "vscode",
    });
    if (!completion || token.isCancellationRequested) {
      return new vscode.CompletionList();
    }

    const replaceStart = position.character - completion.token.length;
    if (replaceStart < 0) {
      return new vscode.CompletionList();
    }
    const range = new vscode.Range(position.line, replaceStart, position.line, position.character);
    const items = completion.completions.map((candidate) => {
      const label = candidate.display || candidate.value.replace(/:\s*$/, "");
      const item = new vscode.CompletionItem(
        label,
        candidate.type === "value"
          ? vscode.CompletionItemKind.Value
          : vscode.CompletionItemKind.Field
      );
      item.insertText = candidate.value.includes("$")
        ? new vscode.SnippetString(candidate.value)
        : candidate.value;
      item.range = range;
      item.filterText = candidate.value;
      if (candidate.description) {
        item.documentation = new vscode.MarkdownString(candidate.description);
      }
      if (candidate.suggest_on_accept) {
        item.command = { command: "editor.action.triggerSuggest", title: "Suggest" };
      }
      return item;
    });
    return new vscode.CompletionList(items, false);
  }

  clear(): void {
    this.modules.clear();
  }

  dispose(): void {
    this.modules.clear();
  }

  private async rMarkdownYamlCompletions(
    notebookUri: vscode.Uri,
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[]> {
    const outputItems = await this.rMarkdownOutputCompletions(
      notebookUri,
      document,
      position
    );
    if (outputItems) {
      return outputItems;
    }

    const beforeCursor = document.lineAt(position.line).text.slice(0, position.character);
    const valueMatch = /^([A-Za-z][\w-]*):\s*([\w-]*)$/.exec(beforeCursor);
    if (valueMatch?.[1] && valueMatch[2] !== undefined) {
      const field = rMarkdownFrontMatterFields.find(({ name }) => name === valueMatch[1]);
      const valueToken = valueMatch[2];
      if (!field?.values) {
        return [];
      }
      const range = new vscode.Range(
        position.line,
        position.character - valueToken.length,
        position.line,
        position.character
      );
      return field.values
        .filter((value) => value.startsWith(valueToken.toLowerCase()))
        .map((value) => {
          const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
          item.range = range;
          return item;
        });
    }

    const fieldMatch = /^([A-Za-z-]*)$/.exec(beforeCursor);
    if (!fieldMatch?.[1] && beforeCursor.length > 0) {
      return [];
    }
    const fieldToken = fieldMatch?.[1] ?? "";
    const range = new vscode.Range(
      position.line,
      position.character - fieldToken.length,
      position.line,
      position.character
    );
    return rMarkdownFrontMatterFields
      .filter(({ name }) => name.startsWith(fieldToken.toLowerCase()))
      .map((field) => {
        const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
        item.insertText = field.block
          ? new vscode.SnippetString(`${field.name}:\n  $0`)
          : `${field.name}: `;
        item.range = range;
        item.detail = field.description;
        if (field.name === "output" || field.values) {
          item.command = { command: "editor.action.triggerSuggest", title: "Suggest" };
        }
        return item;
      });
  }

  private async rMarkdownOutputCompletions(
    notebookUri: vscode.Uri,
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    const beforeCursor = document.lineAt(position.line).text.slice(0, position.character);
    const sameLine = /^\s*output:\s*([\w:.-]*)$/.exec(beforeCursor);
    let token = sameLine?.[1];
    let mappingValue = false;
    if (token === undefined) {
      const indentation = /^\s*/.exec(beforeCursor)?.[0].length ?? 0;
      if (indentation === 0) {
        return undefined;
      }
      for (let line = position.line - 1; line >= 0; line -= 1) {
        const text = document.lineAt(line).text;
        if (text.trim().length === 0) {
          continue;
        }
        const parentIndentation = /^\s*/.exec(text)?.[0].length ?? 0;
        if (parentIndentation >= indentation) {
          continue;
        }
        if (!/^\s*output:\s*(?:#.*)?$/.test(text)) {
          return undefined;
        }
        token = /[\w:.-]*$/.exec(beforeCursor)?.[0] ?? "";
        mappingValue = true;
        break;
      }
    }
    if (token === undefined) {
      return undefined;
    }

    const formats = await this.loadRMarkdownOutputFormats(notebookUri);
    const range = new vscode.Range(
      position.line,
      position.character - token.length,
      position.line,
      position.character
    );
    return formats
      .filter((name) => {
        const normalizedToken = token.toLowerCase();
        const shortName = name.split("::").at(-1) ?? name;
        return name.toLowerCase().startsWith(normalizedToken) ||
          shortName.toLowerCase().startsWith(normalizedToken);
      })
      .map((name) => {
        const item = new vscode.CompletionItem(
          name,
          vscode.CompletionItemKind.Value
        );
        item.insertText = mappingValue
          ? `${name}: default`
          : name;
        item.range = range;
        item.filterText = `${name.split("::").at(-1) ?? name} ${name}`;
        item.detail = "Installed R Markdown output format";
        return item;
      });
  }

  private attributeCompletions(
    groups: readonly QuartoAttributeGroup[],
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const line = document.lineAt(position.line).text;
    const beforeCursor = line.slice(0, position.character);
    const openingBrace = beforeCursor.lastIndexOf("{");
    const simpleDiv = openingBrace < 0
      ? /^(\s*:{3,}\s+)([\w.-]*)$/.exec(beforeCursor)
      : undefined;
    let context: "div" | "heading" | "figure" | "codeblock" | undefined;
    let attributes = "";
    let token = "";
    if (simpleDiv?.[2] !== undefined) {
      context = "div";
      attributes = simpleDiv[2];
      token = simpleDiv[2];
    } else if (openingBrace >= 0) {
      const beforeBrace = line.slice(0, openingBrace);
      if (/^\s*:{3,}/.test(beforeBrace)) {
        context = "div";
      } else if (/^\s*#{1,6}\s/.test(beforeBrace)) {
        context = "heading";
      } else if (/^\s*(?:`{3,}|~{3,})/.test(beforeBrace)) {
        context = "codeblock";
      } else if (/!\[[^\]]*\]\([^)]*\)\s*$/.test(beforeBrace)) {
        context = "figure";
      }
      const closingBrace = line.indexOf("}", openingBrace);
      if (!context || (closingBrace >= 0 && position.character > closingBrace)) {
        return [];
      }
      attributes = line.slice(openingBrace + 1, closingBrace < 0 ? line.length : closingBrace);
      token = beforeCursor.slice(openingBrace + 1).split(/\s+/).pop() ?? "";
    }
    if (!context) {
      return [];
    }

    const range = new vscode.Range(
      position.line,
      position.character - token.length,
      position.line,
      position.character
    );
    const items = new Map<string, vscode.CompletionItem>();
    for (const group of groups) {
      if (
        !Array.isArray(group.contexts) ||
        !group.contexts.includes(context) ||
        (Array.isArray(group.formats) && group.formats.length > 0) ||
        (typeof group.filter === "string" && !new RegExp(group.filter).test(attributes)) ||
        !Array.isArray(group.completions)
      ) {
        continue;
      }
      for (const candidate of group.completions as QuartoAttributeCompletion[]) {
        if (
          typeof candidate.value !== "string" ||
          (simpleDiv && !candidate.value.startsWith("."))
        ) {
          continue;
        }
        const value = simpleDiv ? candidate.value.slice(1) : candidate.value;
        if (items.has(value)) {
          continue;
        }
        const item = new vscode.CompletionItem(
          value.replace(/\$0/g, ""),
          vscode.CompletionItemKind.Property
        );
        item.insertText = value.includes("$0")
          ? new vscode.SnippetString(value)
          : value;
        item.range = range;
        if (typeof candidate.doc === "string") {
          item.documentation = new vscode.MarkdownString(candidate.doc);
        }
        items.set(value, item);
      }
    }
    return [...items.values()];
  }

  private referenceCompletions(
    notebook: vscode.NotebookDocument,
    document: vscode.TextDocument,
    position: vscode.Position,
    isQuarto: boolean
  ): vscode.CompletionItem[] {
    const beforeCursor = document.lineAt(position.line).text.slice(0, position.character);
    const match = isQuarto
      ? /@([^@;[\]\s!,]*)$/.exec(beforeCursor)
      : /\\@ref\(([^)]*)$/.exec(beforeCursor);
    if (!match) {
      return [];
    }
    const token = match[1] ?? "";
    const markdownLabels = new Set<string>();
    const codeLabels = new Set<string>();
    const figureLabels = new Set<string>();
    const tableLabels = new Set<string>();
    for (const cell of notebook.getCells()) {
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        for (const label of cell.document.getText().matchAll(/\{#([A-Za-z][\w:.-]*)/g)) {
          if (label[1]) {
            markdownLabels.add(label[1]);
          }
        }
        continue;
      }
      const chunk = (cell.metadata as RNotebookCellMetadata).rNotebook;
      const source = cell.document.getText();
      const renderOptions = codeCellRenderOptions(source, chunk);
      const label = renderOptions.label;
      if (/^[A-Za-z][\w:.-]*$/.test(label)) {
        codeLabels.add(label);
        if (renderOptions.attributes.get("fig-cap")) {
          figureLabels.add(label);
        }
        if (renderOptions.attributes.get("tbl-cap")) {
          tableLabels.add(label);
        }
      }
    }

    if (!isQuarto) {
      const range = new vscode.Range(
        position.line,
        position.character - token.length,
        position.line,
        position.character
      );
      const typedKind = /^(fig|tab):(.*)$/.exec(token);
      if (typedKind?.[1] !== undefined) {
        const kind = typedKind[1];
        const labels = kind === "fig" ? figureLabels : tableLabels;
        return [...labels]
          .map((label) => `${kind}:${label}`)
          .filter((target) => target.startsWith(token))
          .map((target) => {
            const item = new vscode.CompletionItem(target, vscode.CompletionItemKind.Value);
            item.range = range;
            item.insertText = `${target})`;
            item.detail = `R Markdown ${kind === "fig" ? "figure" : "table"} reference`;
            return item;
          });
      }
      const items = [...markdownLabels]
        .filter((label) => label.startsWith(token))
        .map((label) => {
          const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Value);
          item.range = range;
          item.insertText = `${label})`;
          item.detail = "R Markdown section reference";
          return item;
        });
      for (const [kind, labels] of [
        ["fig:", figureLabels],
        ["tab:", tableLabels],
      ] as const) {
        if (labels.size === 0 || !kind.startsWith(token)) {
          continue;
        }
        const item = new vscode.CompletionItem(kind, vscode.CompletionItemKind.Value);
        item.range = range;
        item.command = { command: "editor.action.triggerSuggest", title: "Suggest" };
        items.push(item);
      }
      return items;
    }

    const labels = new Set([...markdownLabels, ...codeLabels]);
    const range = new vscode.Range(
      position.line,
      position.character - token.length - 1,
      position.line,
      position.character
    );
    return [...labels].filter((label) => label.startsWith(token)).map((label) => {
      const reference = `@${label}`;
      const item = new vscode.CompletionItem(reference, vscode.CompletionItemKind.Value);
      item.range = range;
      item.filterText = reference;
      item.insertText = reference;
      item.detail = "Notebook reference";
      item.sortText = `0${label}`;
      return item;
    });
  }

  private async pathCompletions(
    notebook: vscode.NotebookDocument,
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[]> {
    if (notebook.uri.scheme !== "file") {
      return [];
    }
    const beforeCursor = document.lineAt(position.line).text.slice(0, position.character);
    const match = /!?\[[^\]]*\]\(([^)\s]*)$/.exec(beforeCursor);
    const token = match?.[1];
    if (token === undefined || /^(?:[a-z]+:|#)/i.test(token)) {
      return [];
    }
    const separator = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
    const directoryPart = separator >= 0 ? token.slice(0, separator + 1) : "";
    const namePart = separator >= 0 ? token.slice(separator + 1) : token;
    const baseDirectory = token.startsWith("/")
      ? vscode.workspace.getWorkspaceFolder(notebook.uri)?.uri.fsPath
      : path.dirname(notebook.uri.fsPath);
    if (!baseDirectory) {
      return [];
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(
        path.resolve(
          baseDirectory,
          (token.startsWith("/") ? directoryPart.slice(1) : directoryPart) || "."
        ),
        { withFileTypes: true }
      );
    } catch {
      return [];
    }
    const range = new vscode.Range(
      position.line,
      position.character - namePart.length,
      position.line,
      position.character
    );
    return entries
      .filter((entry) => !entry.name.startsWith(".") && entry.name.startsWith(namePart))
      .map((entry) => {
        const item = new vscode.CompletionItem(
          entry.name,
          entry.isDirectory() ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
        );
        item.insertText = entry.isDirectory() ? `${entry.name}/` : entry.name;
        item.range = range;
        if (entry.isDirectory()) {
          item.command = { command: "editor.action.triggerSuggest", title: "Suggest" };
        }
        return item;
      });
  }

  private loadQuarto(notebookUri: vscode.Uri): Promise<QuartoEditorSupport | undefined> {
    const executable = configuredQuartoExecutable(notebookUri);
    let result = this.modules.get(executable);
    if (!result) {
      result = quartoInstallationPaths(executable).then(async (installedPaths) => {
        for (const installedPath of installedPaths) {
          const modulePath = path.join(installedPath, "editor", "tools", "vs-code.mjs");
          const attributesPath = path.join(installedPath, "editor", "tools", "attrs.yml");
          if (fs.existsSync(modulePath) && fs.existsSync(attributesPath)) {
            const editor = await import(pathToFileURL(modulePath).href) as QuartoEditorModule;
            const parsed = loadYaml(await fs.promises.readFile(attributesPath, "utf8"));
            return {
              editor,
              attributes: Array.isArray(parsed) ? parsed as QuartoAttributeGroup[] : [],
            };
          }
        }
        throw new Error(`Could not locate the editor module reported by '${executable} --paths'.`);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[Markdown completion] Could not load Quarto: ${message}`);
        return undefined;
      });
      this.modules.set(executable, result);
    }
    return result;
  }
}
