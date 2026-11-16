import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import Module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type * as vscode from "vscode";
import { RExecutionBridge } from "../../src/Runtime/bridge";

// launch.ts remains cached between cases; its VS Code facade must follow the
// current test workspace instead of retaining the first case's deleted folder.
let currentProject: string;
let currentWorkspaceRoot: string;

for (const extension of ["Rmd", "qmd"]) test(`${extension}: unsaved notebook cells retain project libraries, metadata, and relative resources`, { timeout: 30000 }, async (t) => {
  const executable = process.env.R_EXECUTABLE || (process.platform === "win32" ? "R.exe" : "R");
  if (spawnSync(executable, ["--version"], { windowsHide: true }).status !== 0) {
    if (process.env.CI) assert.fail("CI requires R for project startup coverage");
    t.skip("Set R_EXECUTABLE or put R on PATH to test project startup");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "r-notebook-project-startup-"));
  const project = path.join(root, "project");
  currentProject = project;
  currentWorkspaceRoot = root;
  const notebookDirectory = path.join(project, "reports", "nested");
  const library = path.join(project, ".uvr", "library");
  const document = path.join(notebookDirectory, `report.${extension}`);
  const previousProfile = process.env.R_PROFILE_USER;
  const api = {
    workspace: {
      getWorkspaceFolder: () => ({ uri: { fsPath: currentProject } }),
      // The notebook's own folder must win in a multi-root workspace.
      get workspaceFolders() { return [{ uri: { fsPath: currentWorkspaceRoot } }, { uri: { fsPath: currentProject } }]; },
    },
    extensions: { getExtension: () => ({
      isActive: true,
      exports: { getRExecutablePath: async () => executable },
    }) },
  };
  const loader = Module as unknown as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
  };
  const originalLoad = loader._load;
  loader._load = function(request, parent, isMain) {
    return request === "vscode" ? api : originalLoad.call(this, request, parent, isMain);
  };
  let create: typeof import("../../src/Runtime/launch").createInlineRProcess;
  try { ({ createInlineRProcess: create } = await import("../../src/Runtime/launch")); }
  finally { loader._load = originalLoad; }
  const r = create({ fsPath: document } as vscode.Uri,
    { appendLine() {} } as unknown as vscode.OutputChannel, false);
  t.signal.addEventListener("abort", () => { void r.dispose(); }, { once: true });
  try {
    await fs.mkdir(notebookDirectory, { recursive: true });
    await fs.mkdir(library, { recursive: true });
    // Match uvr's project-relative activation without requiring uvr installation.
    // Unix R startup ignores an incomplete final line in .Rprofile.
    await fs.writeFile(path.join(project, ".Rprofile"), [
      '.libPaths(c(file.path(getwd(), ".uvr", "library"), .libPaths()))',
      'options(notebook.test.startup.directory = getwd())',
      "",
    ].join("\n"));
    await fs.writeFile(path.join(notebookDirectory, "relative.txt"), "notebook-relative");
    if (extension === "qmd") {
      await fs.writeFile(path.join(project, "_quarto.yml"), "format:\n  html:\n    toc: true\n");
      await fs.writeFile(path.join(notebookDirectory, "_metadata.yml"), "author: Inherited author\n");
    } else {
      await fs.writeFile(path.join(notebookDirectory, "_output.yml"), "html_document:\n  toc: true\n");
    }
    await fs.writeFile(path.join(notebookDirectory, "relative.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="3" fill="red"/></svg>');
    const rString = (value: string) => JSON.stringify(value.replaceAll("\\", "/"));
    const source = [
      "```{r}",
      'if (is.null(getOption("notebook.test.startup.directory"))) stop("Project .Rprofile was not loaded")',
      `stopifnot(normalizePath(getOption('notebook.test.startup.directory'), winslash='/') == normalizePath(${rString(project)}, winslash='/'))`,
      `stopifnot(normalizePath(${rString(library)}, winslash='/') %in% normalizePath(.libPaths(), winslash='/'))`,
      'stopifnot(identical(readLines("relative.txt"), "notebook-relative"))',
      'cat("project library and relative paths preserved")',
      "```",
    ].join("\n");
    await fs.writeFile(document, "Saved text that the unsaved snapshot replaces.\n");
    delete process.env.R_PROFILE_USER;
    const bridge = new RExecutionBridge(path.resolve("resources/r/execute.R"), r);
    const result = await bridge.execute(source, document, {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    }, { documentSource: source, documentId: document, cellId: "test" });
    const output = result.outputs.map(item => Buffer.from(item.data).toString()).join("\n");
    assert.equal(result.success, true, output);
    assert.match(output, /project library and relative paths preserved/);
    const preview = await bridge.renderText([{ token: "TOKEN", source: "# Preview\n\nValue: `r 42`.\n\n![Image](relative.svg)" }],
      '---\ntitle: Unsaved preview\n---\n\n::: {#preview .r-notebook-markdown-cell}\nTOKEN\n:::\n', document);
    assert.match(preview, /Unsaved preview/);
    assert.match(preview, /id="TOC"/);
    assert.match(preview, /Value: 42/);
    assert.match(preview, /<svg/);
    if (extension === "qmd") assert.match(preview, /Inherited author/);
    assert.equal(await fs.readFile(document, "utf8"), "Saved text that the unsaved snapshot replaces.\n");
  } finally {
    if (previousProfile === undefined) delete process.env.R_PROFILE_USER;
    else process.env.R_PROFILE_USER = previousProfile;
    await r.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("r-notebook-project-startup-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
