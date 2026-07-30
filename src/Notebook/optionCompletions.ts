import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  quartoExecutableSetting,
  resolveRExecutable,
} from "../Runtime/launch";
import {
  knitrOptionCompletions,
  quartoOptionCompletions,
  type CellOptionCompletions,
  type OptionCompletion,
} from "./optionSchema";

const R_MARKDOWN_OPTIONS_EXPRESSION = [
  'if (requireNamespace("knitr", quietly=TRUE)) {',
  "  options <- knitr::opts_chunk$get()",
  '  knitr_namespace <- asNamespace("knitr")',
  '  option_types <- get("opts_chunk_attr", knitr_namespace)',
  '  dash_names <- get("dash_names", knitr_namespace)',
  "  option_names <- unique(c(names(option_types), names(options)))",
  "  option_indexes <- as.list(seq_along(option_names))",
  "  names(option_indexes) <- option_names",
  "  option_names <- option_names[unlist(dash_names(option_indexes), use.names = FALSE)]",
  "  for (name in sort(option_names)) {",
  '    type <- if (name %in% names(options)) typeof(options[[name]]) else option_types[[name]]',
  '    if (!is.character(type) || length(type) != 1L) type <- ""',
  "    pipe_name <- names(dash_names(setNames(list(TRUE), name)))[[1L]]",
  '    cat("option\\t", name, "\\t", type, "\\t", pipe_name, "\\n", sep="")',
  "  }",
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
  private readonly rMarkdownCache = new Map<string, Promise<CellOptionCompletions>>();
  private readonly quartoCache = new Map<string, Promise<OptionCompletion[]>>();

  constructor(private readonly output: vscode.OutputChannel) {}

  load(
    notebookUri: vscode.Uri,
    documentKind: "quarto" | "rMarkdown"
  ): Promise<CellOptionCompletions> {
    if (documentKind === "quarto") {
      const quarto = configuredQuartoExecutable(notebookUri);
      return this.loadQuarto(quarto).then((quartoOptions) => ({
        rMarkdown: [],
        quarto: quartoOptions,
      }));
    }
    const r = resolveRExecutable(notebookUri);
    return this.loadRMarkdown(r);
  }

  clear(): void {
    this.rMarkdownCache.clear();
    this.quartoCache.clear();
  }

  private loadRMarkdown(rExecutable: string): Promise<CellOptionCompletions> {
    let result = this.rMarkdownCache.get(rExecutable);
    if (!result) {
      result = execute(
        rExecutable,
        ["--vanilla", "--slave", "-e", R_MARKDOWN_OPTIONS_EXPRESSION]
      ).then(knitrOptionCompletions).catch((error: unknown) => {
        this.log("R Markdown", error);
        return { rMarkdown: [], quarto: [] };
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
