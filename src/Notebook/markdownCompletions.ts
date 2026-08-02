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
import {
  inspectQuartoFormats,
  mergeQuartoFormats,
  quartoCompletionDocumentation,
  quartoFrontMatterFormatContext,
  type QuartoFormatInspection as InspectedQuartoFormats,
  type QuartoFrontMatterFormats,
  type QuartoFormats,
} from "./quartoFormats";
import {
  quartoAttributeGroupApplies,
  type QuartoAttributeContext,
  type QuartoAttributeGroup,
} from "./quartoAttributes";
import { isQuartoNotebook } from "../notebookFile";

interface QuartoCompletion {
  type?: "key" | "value";
  display?: string;
  value: string;
  description?: string;
  schema?: unknown;
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

interface QuartoEditorSupport {
  editor: QuartoEditorModule;
  attributes: QuartoAttributeGroup[];
  schemas: Record<string, unknown>;
}

interface CachedQuartoInspection {
  formats: InspectedQuartoFormats;
  frontMatter: QuartoFrontMatterFormats;
}

export class RNotebookMarkdownCompletionProvider implements
  vscode.CompletionItemProvider,
  vscode.Disposable {
  private readonly quartoModules =
    new Map<string, Promise<QuartoEditorSupport | undefined>>();
  private readonly quartoInspections =
    new Map<string, Promise<CachedQuartoInspection>>();
  private readonly quartoInspectionErrors = new Set<string>();
  private readonly yamlCompletionChanges: vscode.Disposable;

  constructor(private readonly output: vscode.OutputChannel) {
    this.yamlCompletionChanges = vscode.workspace.onDidChangeTextDocument((event) => {
      const change = event.contentChanges[0];
      if (
        event.reason !== undefined ||
        event.contentChanges.length !== 1 ||
        !change?.text ||
        [...change.text].length !== 1
      ) {
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) {
        return;
      }
      const context = this.markupContext(event.document);
      const position = event.document.positionAt(
        event.document.offsetAt(change.range.start) + change.text.length
      );
      if (
        !context ||
        !context.isQuarto ||
        !this.isFrontMatterPosition(context.cell, event.document, position) ||
        !this.startsYamlCompletionToken(
          event.document,
          position,
          change.text
        )
      ) {
        return;
      }
      void vscode.commands.executeCommand("editor.action.triggerSuggest");
    });
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionList> {
    const context = this.markupContext(document);
    if (!context) {
      return new vscode.CompletionList();
    }
    const { notebook, cell, isQuarto } = context;
    const source = document.getText();
    const inYaml = this.isFrontMatterPosition(cell, document, position);

    if (!inYaml) {
      const referenceItems = this.referenceCompletions(
        notebook,
        document,
        position,
        isQuarto
      );
      const pathItems = await this.pathCompletions(notebook, document, position);
      const currentLine = document.lineAt(position.line).text;
      if (!isQuarto || (
        !currentLine.includes("{") &&
        !/^\s*:{3,}/.test(currentLine)
      )) {
        return new vscode.CompletionList([...referenceItems, ...pathItems], false);
      }
      const [support, formats] = await Promise.all([
        this.loadQuarto(notebook.uri),
        this.quartoFormats(notebook),
      ]);
      if (!support || token.isCancellationRequested) {
        return new vscode.CompletionList([...referenceItems, ...pathItems], false);
      }
      const attributeItems = this.attributeCompletions(
        support.attributes,
        formats,
        document,
        position
      );
      return new vscode.CompletionList([
        ...referenceItems,
        ...pathItems,
        ...attributeItems,
      ], false);
    }

    if (!isQuarto) {
      return new vscode.CompletionList();
    }

    const [support, formats] = await Promise.all([
      this.loadQuarto(notebook.uri),
      this.quartoFormats(notebook),
    ]);
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
      formats: formats.document,
      project_formats: formats.project,
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
      const documentation = quartoCompletionDocumentation(
        candidate,
        support.schemas
      );
      if (documentation) {
        item.documentation = new vscode.MarkdownString(documentation);
      }
      if (candidate.suggest_on_accept) {
        item.command = { command: "editor.action.triggerSuggest", title: "Suggest" };
      }
      return item;
    });
    return new vscode.CompletionList(items, false);
  }

  clear(): void {
    this.quartoModules.clear();
    this.invalidateQuartoFormats();
  }

  prepareQuarto(notebook: vscode.NotebookDocument): void {
    if (
      notebook.notebookType !== NOTEBOOK_TYPE ||
      !isQuartoNotebook(notebook.uri.fsPath)
    ) {
      return;
    }
    void Promise.all([
      this.loadQuarto(notebook.uri),
      this.quartoFormats(notebook),
    ]);
  }

  invalidateQuartoFormats(): void {
    this.quartoInspections.clear();
    this.quartoInspectionErrors.clear();
  }

  dispose(): void {
    this.yamlCompletionChanges.dispose();
    this.quartoModules.clear();
    this.invalidateQuartoFormats();
  }

  private startsYamlCompletionToken(
    document: vscode.TextDocument,
    position: vscode.Position,
    insertedText: string
  ): boolean {
    if (!insertedText.trim()) {
      return false;
    }
    const beforeCursor = document.lineAt(position.line).text.slice(
      0,
      position.character
    );
    const beforeInsertion = beforeCursor.slice(0, -insertedText.length);
    return (
      /^\s*$/.test(beforeInsertion) ||
      /:\s*$/.test(beforeInsertion) ||
      /^\s*-\s+$/.test(beforeInsertion) ||
      /[\[,{]\s*$/.test(beforeInsertion)
    );
  }

  private markupContext(document: vscode.TextDocument): {
    notebook: vscode.NotebookDocument;
    cell: vscode.NotebookCell;
    isQuarto: boolean;
  } | undefined {
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
      return undefined;
    }
    return {
      notebook,
      cell,
      isQuarto: isQuartoNotebook(notebook.uri.fsPath),
    };
  }

  private isFrontMatterPosition(
    cell: vscode.NotebookCell,
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    if (cell.index !== 0) {
      return false;
    }
    const source = document.getText();
    const opening = /^---[ \t]*(?:\r\n|\n|\r)/.exec(source);
    if (!opening) {
      return false;
    }
    const sourceOffset = document.offsetAt(position);
    const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/m.exec(
      source.slice(opening[0].length)
    );
    return sourceOffset >= opening[0].length && (
      !closing ||
      sourceOffset <= opening[0].length + closing.index
    );
  }

  private async quartoFormats(notebook: vscode.NotebookDocument): Promise<QuartoFormats> {
    const firstCell = notebook.getCells()[0];
    const document = firstCell?.kind === vscode.NotebookCellKind.Markup
      ? firstCell.document
      : undefined;
    const frontMatter = document
      ? quartoFrontMatterFormatContext(document.getText())
      : { specified: false, formats: [] };
    if (notebook.uri.scheme !== "file") {
      return {
        document: frontMatter.specified ? frontMatter.formats : ["html"],
        project: [],
      };
    }

    const executable = configuredQuartoExecutable(notebook.uri);
    const inspectionKey = `${executable}\0${notebook.uri.fsPath}`;
    let inspection = this.quartoInspections.get(inspectionKey);
    if (!inspection) {
      inspection = Promise.all([
        inspectQuartoFormats(executable, notebook.uri.fsPath),
        fs.promises.readFile(notebook.uri.fsPath, "utf8"),
      ]).then(([formats, source]) => ({
        formats,
        frontMatter: quartoFrontMatterFormatContext(source),
      }));
      this.quartoInspections.set(inspectionKey, inspection);
    }
    try {
      const inspected = await inspection;
      return mergeQuartoFormats(
        frontMatter,
        inspected.frontMatter,
        inspected.formats
      );
    } catch (error) {
      if (!this.quartoInspectionErrors.has(inspectionKey)) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        this.output.appendLine(
          `[Markdown completion] Could not inspect Quarto formats: ${message}`
        );
        this.quartoInspectionErrors.add(inspectionKey);
      }
    }
    return {
      document: frontMatter.specified ? frontMatter.formats : ["html"],
      project: [],
    };
  }

  private attributeCompletions(
    groups: readonly QuartoAttributeGroup[],
    formats: QuartoFormats,
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const line = document.lineAt(position.line).text;
    const beforeCursor = line.slice(0, position.character);
    const openingBrace = beforeCursor.lastIndexOf("{");
    const simpleDiv = openingBrace < 0
      ? /^(\s*:{3,}\s+)([\w.-]*)$/.exec(beforeCursor)
      : undefined;
    let context: QuartoAttributeContext | undefined;
    let token = "";
    if (simpleDiv?.[2] !== undefined) {
      context = "div";
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
      if (!quartoAttributeGroupApplies(group, context, formats, line)) {
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
      const documentKind = isQuarto ? "quarto" : "rMarkdown";
      const renderOptions = codeCellRenderOptions(source, chunk, documentKind);
      const label = renderOptions.label;
      if (/^[A-Za-z][\w:.-]*$/.test(label)) {
        codeLabels.add(label);
        if (renderOptions.figureCaption) {
          figureLabels.add(label);
        }
        if (renderOptions.tableCaption) {
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
    let result = this.quartoModules.get(executable);
    if (!result) {
      result = quartoInstallationPaths(executable).then(async (installedPaths) => {
        for (const installedPath of installedPaths) {
          const modulePath = path.join(installedPath, "editor", "tools", "vs-code.mjs");
          const attributesPath = path.join(installedPath, "editor", "tools", "attrs.yml");
          const schemasPath = path.join(
            installedPath,
            "editor",
            "tools",
            "yaml",
            "all-schema-definitions.json"
          );
          if (
            fs.existsSync(modulePath) &&
            fs.existsSync(attributesPath) &&
            fs.existsSync(schemasPath)
          ) {
            const editor = await import(pathToFileURL(modulePath).href) as QuartoEditorModule;
            const [parsed, schemas] = await Promise.all([
              fs.promises.readFile(attributesPath, "utf8").then(loadYaml),
              fs.promises.readFile(schemasPath, "utf8").then(JSON.parse),
            ]);
            return {
              editor,
              attributes: Array.isArray(parsed) ? parsed as QuartoAttributeGroup[] : [],
              schemas: schemas && typeof schemas === "object" && !Array.isArray(schemas)
                ? schemas as Record<string, unknown>
                : {},
            };
          }
        }
        throw new Error(`Could not locate the editor module reported by '${executable} --paths'.`);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[Markdown completion] Could not load Quarto: ${message}`);
        return undefined;
      });
      this.quartoModules.set(executable, result);
    }
    return result;
  }
}
