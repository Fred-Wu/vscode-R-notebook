import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { resolveRExecutable } from "../Runtime/launch";

export interface MergedCellOptions {
  headerOptions: string;
  pipeOptions: string;
}

interface MergeResponse extends Partial<MergedCellOptions> {
  error?: unknown;
}

export function mergeRMarkdownCellOptions(
  notebookUri: vscode.Uri,
  scriptPath: string,
  headerOptions: string,
  pipeOptions: string,
  target: "header" | "pipe"
): Promise<MergedCellOptions> {
  return new Promise((resolve, reject) => {
    const process = spawn(
      resolveRExecutable(notebookUri),
      ["--vanilla", "--slave", `--file=${scriptPath}`],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (data: string) => {
      stdout += data;
    });
    process.stderr.on("data", (data: string) => {
      stderr += data;
    });
    process.once("error", reject);
    process.stdin.once("error", reject);
    process.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `R exited with code ${code}.`));
        return;
      }
      try {
        const response = JSON.parse(stdout) as MergeResponse;
        if (
          typeof response.headerOptions !== "string" ||
          typeof response.pipeOptions !== "string"
        ) {
          throw new Error(
            typeof response.error === "string"
              ? response.error
              : "R returned an invalid cell-option merge result."
          );
        }
        resolve({
          headerOptions: response.headerOptions,
          pipeOptions: response.pipeOptions,
        });
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.end(JSON.stringify({ headerOptions, pipeOptions, target }));
  });
}
