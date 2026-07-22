import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  quartoExecutableSetting,
  resolveRExecutable,
} from "../Runtime/launch";
import {
  quartoOptionCompletions,
  type CellOptionCompletions,
  type OptionCompletion,
} from "./optionSchema";

const R_MARKDOWN_COMPLETIONS_EXPRESSION = [
  'if (requireNamespace("knitr", quietly=TRUE)) {',
  "  options <- knitr::opts_chunk$get()",
  "  for (name in sort(names(options)))",
  '    cat("option\\t", name, "\\t", typeof(options[[name]]), "\\n", sep="")',
  "}",
  'for (package in c("rmarkdown", "bookdown")) {',
  '  if (!requireNamespace(package, quietly=TRUE)) next',
  '  namespace <- asNamespace(package)',
  '  for (name in getNamespaceExports(package)) {',
  '    fn <- get0(name, envir=namespace, mode="function", inherits=FALSE)',
  '    if (is.null(fn)) next',
  '    formal_values <- formals(fn)',
  '    if ("..." %in% names(formal_values)) formal_values[["..."]] <- NULL',
  '    required <- vapply(formal_values, identical, logical(1), quote(expr=))',
  '    if (any(required)) next',
  '    format <- tryCatch(',
  '      suppressMessages(suppressWarnings(fn())),',
  '      error=function(error) NULL',
  '    )',
  '    if (inherits(format, "rmarkdown_output_format"))',
  '      cat("format\\t", package, "::", name, "\\n", sep="")',
  '  }',
  "}",
].join("\n");

function execute(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

interface RMarkdownCompletions {
  options: OptionCompletion[];
  outputFormats: string[];
}

function rMarkdownCompletions(output: string): RMarkdownCompletions {
  const completions = new Map<string, OptionCompletion>();
  const outputFormats = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const [kind, name, type] = line.split("\t", 3);
    if (!name) {
      continue;
    }
    if (kind === "format") {
      outputFormats.add(name);
      continue;
    }
    if (kind !== "option") {
      continue;
    }
    completions.set(name, type === "logical"
      ? { name, values: ["TRUE", "FALSE"] }
      : { name });
  }
  return {
    options: [...completions.values()]
      .sort((left, right) => left.name.localeCompare(right.name)),
    outputFormats: [...outputFormats].sort((left, right) => left.localeCompare(right)),
  };
}

export function configuredQuartoExecutable(notebookUri: vscode.Uri): string {
  return quartoExecutableSetting(notebookUri) ||
    (process.platform === "win32" ? "quarto.exe" : "quarto");
}

export async function quartoInstallationPaths(quarto: string): Promise<string[]> {
  const output = await execute(quarto, ["--paths"]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function loadQuartoCompletions(quarto: string): Promise<OptionCompletion[]> {
  for (const installedPath of await quartoInstallationPaths(quarto)) {
    const schemaPath = path.join(
      installedPath,
      "editor",
      "tools",
      "yaml",
      "all-schema-definitions.json"
    );
    if (fs.existsSync(schemaPath)) {
      const definitions: unknown = JSON.parse(await fs.promises.readFile(schemaPath, "utf8"));
      return quartoOptionCompletions(definitions);
    }
  }
  throw new Error(`Could not locate the schema reported by '${quarto} --paths'.`);
}

export class CellOptionCompletionProvider {
  private readonly rMarkdownCache = new Map<string, Promise<RMarkdownCompletions>>();
  private readonly quartoCache = new Map<string, Promise<OptionCompletion[]>>();

  constructor(private readonly output: vscode.OutputChannel) {}

  load(notebookUri: vscode.Uri): Promise<CellOptionCompletions> {
    const r = resolveRExecutable(notebookUri);
    const quarto = configuredQuartoExecutable(notebookUri);
    return Promise.all([
      this.loadRMarkdown(r),
      this.loadQuarto(quarto),
    ]).then(([rMarkdown, quartoOptions]) => ({
      rMarkdown: rMarkdown.options,
      quarto: quartoOptions,
    }));
  }

  loadRMarkdownOutputFormats(notebookUri: vscode.Uri): Promise<readonly string[]> {
    return this.loadRMarkdown(resolveRExecutable(notebookUri))
      .then((completions) => completions.outputFormats);
  }

  clear(): void {
    this.rMarkdownCache.clear();
    this.quartoCache.clear();
  }

  private loadRMarkdown(rExecutable: string): Promise<RMarkdownCompletions> {
    let result = this.rMarkdownCache.get(rExecutable);
    if (!result) {
      result = execute(
        rExecutable,
        ["--vanilla", "--slave", "-e", R_MARKDOWN_COMPLETIONS_EXPRESSION]
      ).then(rMarkdownCompletions).catch((error: unknown) => {
        this.log("R Markdown", error);
        return { options: [], outputFormats: [] };
      });
      this.rMarkdownCache.set(rExecutable, result);
    }
    return result;
  }

  private loadQuarto(quartoExecutable: string): Promise<OptionCompletion[]> {
    let result = this.quartoCache.get(quartoExecutable);
    if (!result) {
      result = loadQuartoCompletions(quartoExecutable).catch((error: unknown) => {
        this.log("Quarto", error);
        return [];
      });
      this.quartoCache.set(quartoExecutable, result);
    }
    return result;
  }

  private log(source: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[Cell options] Could not load installed ${source} completions: ${message}`);
  }
}
