import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type * as vscode from "vscode";
import { RExecutionBridge } from "../../src/Runtime/bridge";
import { HiddenRProcess } from "../../src/Runtime/process";
import { createVscodeRAttachmentInitialization } from "../../src/Runtime/vscodeR";
import { parseDocument } from "../../src/Notebook/document";
import { nativeTextDocument } from "../../src/Notebook/markdown";

const neverCancelled = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as vscode.CancellationToken;

function outputText(result: Awaited<ReturnType<RExecutionBridge["execute"]>>): string {
  return result.outputs
    .map((output) => Buffer.from(output.data).toString("utf8"))
    .join("");
}

function rmdChunk(code: string, header = "r"): string {
  return `\`\`\`{${header}}\n${code}\n\`\`\``;
}

function qmdChunk(code: string): string {
  return `\`\`\`{r}\n${code}\n\`\`\``;
}

test("the R bridge attaches once, persists state, and isolates processes", async (t) => {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "r-notebook-attachment-test-")
  );
  const profilePath = path.join(directory, "profile.R");
  const emptyProfilePath = path.join(directory, "empty-profile.R");
  const initializerPath = path.join(directory, "init.R");
  const documentPath = path.join(directory, "notebook.Rmd");
  const quartoDocumentPath = path.join(directory, "notebook.qmd");
  const profileWorkingDirectory = path.join(directory, "profile-working-directory");
  await fsPromises.mkdir(profileWorkingDirectory);
  await fsPromises.writeFile(
    documentPath,
    "---\noutput: html_document\n---\n",
    "utf8"
  );
  await fsPromises.writeFile(
    quartoDocumentPath,
    "---\nformat: html\n---\n",
    "utf8"
  );
  await fsPromises.writeFile(
    profilePath,
    [
      "vscode_tools <- new.env(parent = baseenv())",
      "vscode_tools$.vsc.attach <- function() {",
      "  count <- base::getOption('r_notebook_test_attach_count', 0L)",
      "  base::options(r_notebook_test_attach_count = count + 1L)",
      "  base::invisible()",
      "}",
      "vscode_tools$.vsc.view <- function(x, title) {",
      "  base::options(r_notebook_test_view = list(value = x, title = title))",
      "  base::invisible()",
      "}",
      "base::attach(vscode_tools, name = 'tools:vscode')",
      "base::rm(vscode_tools)",
      "",
    ].join("\n"),
    "utf8"
  );
  await fsPromises.writeFile(
    emptyProfilePath,
    [
      `base::setwd(${JSON.stringify(profileWorkingDirectory)})`,
      "base::options(r_notebook_test_profile_term = base::Sys.getenv('TERM_PROGRAM'))",
      "",
    ].join("\n"),
    "utf8"
  );
  await fsPromises.writeFile(
    initializerPath,
    [
      "init_last <- function() {",
      "  vscode_tools <- new.env(parent = baseenv())",
      "  vscode_tools$.vsc.attach <- function() {",
      "    count <- base::getOption('r_notebook_test_attach_count', 0L)",
      "    base::options(r_notebook_test_attach_count = count + 1L)",
      "    base::options(r_notebook_test_attach_wd = base::getwd())",
      "    base::invisible()",
      "  }",
      "  base::attach(vscode_tools, name = 'tools:vscode')",
      "  vscode_tools$.vsc.attach()",
      "  base::invisible()",
      "}",
      "init_first <- function() base::invisible()",
      "init_first()",
      "",
    ].join("\n"),
    "utf8"
  );

  const executable = process.platform === "win32" ? "R.exe" : "R";
  const launchOptions = async () => ({
    executable,
    args: [
      "--no-environ",
      "--no-site-file",
      "--quiet",
      "--no-save",
      "--no-restore",
      "--interactive",
    ],
    cwd: directory,
    env: { ...process.env, R_PROFILE_USER: profilePath },
    initialization: createVscodeRAttachmentInitialization(),
  });
  const firstProcessLog: string[] = [];
  const secondProcessLog: string[] = [];
  const delayedPackageProcessLog: string[] = [];
  const firstProcess = new HiddenRProcess(launchOptions, (message) => {
    firstProcessLog.push(message);
  });
  const secondProcess = new HiddenRProcess(launchOptions, (message) => {
    secondProcessLog.push(message);
  });
  const delayedPackageProcess = new HiddenRProcess(launchOptions, (message) => {
    delayedPackageProcessLog.push(message);
  });
  const fallbackProcess = new HiddenRProcess(
    async () => ({
      ...(await launchOptions()),
      env: {
        ...process.env,
        R_PROFILE_USER: emptyProfilePath,
        VSCODE_INIT_R: "",
        VSCODE_R_NOTEBOOK_INIT_R: initializerPath,
        VSCODE_R_NOTEBOOK_SESSION_WD: directory,
        TERM_PROGRAM: "vscode",
      },
    }),
    () => undefined
  );
  const failedProcess = new HiddenRProcess(
    async () => ({
      ...(await launchOptions()),
      env: {
        ...process.env,
        R_PROFILE_USER: emptyProfilePath,
        VSCODE_INIT_R: path.join(directory, "missing-init.R"),
      },
    }),
    () => undefined
  );
  t.after(() => {
    firstProcess.dispose();
    secondProcess.dispose();
    delayedPackageProcess.dispose();
    fallbackProcess.dispose();
    failedProcess.dispose();
    return fsPromises.rm(directory, { recursive: true, force: true });
  });

  const helperPath = path.resolve("resources", "r", "execute.R");
  const firstBridge = new RExecutionBridge(helperPath, firstProcess);
  const secondBridge = new RExecutionBridge(helperPath, secondProcess);
  const delayedPackageBridge = new RExecutionBridge(helperPath, delayedPackageProcess);
  const fallbackBridge = new RExecutionBridge(helperPath, fallbackProcess);
  const workingDirectoryArtifacts: string[] = [];
  const workingDirectoryWatcher = fs.watch(directory, (_event, filename) => {
    const name = filename?.toString() ?? "";
    if (name.startsWith(".vsc-r-notebook-")) {
      workingDirectoryArtifacts.push(name);
    }
  });
  t.after(() => workingDirectoryWatcher.close());

  await firstProcess.reattach();
  await secondProcess.reattach();

  const firstExecutionSuppression = await firstBridge.execute(
    rmdChunk([
      "",
      "#| echo: false",
      "#| warning: false",
      "#| message: false",
      "library(plotly)",
      "warning('HIDDEN-FIRST-WARNING')",
      "message('HIDDEN-FIRST-MESSAGE')",
      "plotly::plot_ly(x = 1:3, y = 3:1)",
    ].join("\n")),
    documentPath,
    neverCancelled
  );
  const firstExecutionHtml = outputText(firstExecutionSuppression);
  assert.match(firstExecutionHtml, /data-for="htmlwidget-/);
  assert.doesNotMatch(firstExecutionHtml, /HIDDEN-FIRST-WARNING/);
  assert.doesNotMatch(firstExecutionHtml, /HIDDEN-FIRST-MESSAGE/);
  assert.doesNotMatch(firstExecutionHtml, /Attaching package/);
  assert.doesNotMatch(firstExecutionHtml, /Loading required package/);
  assert.doesNotMatch(firstExecutionHtml, /masked from/);
  assert.doesNotMatch(firstProcessLog.join("\n"), /HIDDEN-FIRST|Attaching package|Loading required package|masked from/);
  assert.doesNotMatch(firstProcessLog.join("\n"), /Browsing http:/);

  const firstQuartoSuppression = await secondBridge.execute(
    qmdChunk([
      "",
      "#| echo: false",
      "#| warning: false",
      "#| message: false",
      "library(plotly)",
      "warning('HIDDEN-FIRST-QMD-WARNING')",
      "message('HIDDEN-FIRST-QMD-MESSAGE')",
      "plotly::plot_ly(x = 1:3, y = 3:1)",
    ].join("\n")),
    quartoDocumentPath,
    neverCancelled
  );
  const firstQuartoHtml = outputText(firstQuartoSuppression);
  assert.match(firstQuartoHtml, /data-for="htmlwidget-/);
  assert.doesNotMatch(firstQuartoHtml, /HIDDEN-FIRST-QMD-WARNING/);
  assert.doesNotMatch(firstQuartoHtml, /HIDDEN-FIRST-QMD-MESSAGE/);
  assert.doesNotMatch(firstQuartoHtml, /Attaching package/);
  assert.doesNotMatch(firstQuartoHtml, /Loading required package/);
  assert.doesNotMatch(firstQuartoHtml, /masked from/);
  assert.doesNotMatch(secondProcessLog.join("\n"), /HIDDEN-FIRST|Attaching package|Loading required package|masked from/);
  assert.doesNotMatch(secondProcessLog.join("\n"), /Browsing http:/);

  await delayedPackageProcess.reattach();
  await delayedPackageBridge.execute(
    qmdChunk("library(ggplot2)"),
    quartoDocumentPath,
    neverCancelled
  );
  const delayedPackageSuppression = await delayedPackageBridge.execute(
    qmdChunk([
      "",
      "#| echo: false",
      "#| warning: false",
      "#| message: false",
      "library(plotly)",
      "plot_ly(data = mtcars, x = ~wt, y = ~mpg, color = ~factor(cyl), type = 'scatter', mode = 'markers')",
    ].join("\n")),
    quartoDocumentPath,
    neverCancelled
  );
  const delayedPackageHtml = outputText(delayedPackageSuppression);
  assert.match(delayedPackageHtml, /data-for="htmlwidget-/);
  assert.doesNotMatch(delayedPackageHtml, /Attaching package|masked from/);
  assert.doesNotMatch(delayedPackageProcessLog.join("\n"), /Attaching package|masked from/);

  const reportedPid = await firstBridge.execute(
    rmdChunk("Sys.getpid()"),
    documentPath,
    neverCancelled
  );
  assert.match(outputText(reportedPid), new RegExp(`\\b${firstProcess.processId}\\b`));

  const assignment = await firstBridge.execute(
    rmdChunk("notebook_process_value <- 41"),
    documentPath,
    neverCancelled
  );
  assert.equal(assignment.success, true);

  await firstBridge.execute(
    rmdChunk("workspace_view_value <- data.frame(x = 1:3)"),
    documentPath,
    neverCancelled
  );
  await firstBridge.viewObject("workspace_view_value");
  const viewedObject = await firstBridge.execute(
    rmdChunk([
      "viewed <- base::getOption('r_notebook_test_view')",
      "base::identical(viewed$title, 'workspace_view_value') &&",
      "  base::identical(viewed$value, workspace_view_value)",
    ].join("\n")),
    documentPath,
    neverCancelled
  );
  assert.match(outputText(viewedObject), /TRUE/);
  await assert.rejects(
    firstBridge.viewObject("missing_workspace_view_value"),
    /Cannot find missing_workspace_view_value in the notebook session/
  );

  const firstTextToken = "VSC_R_NOTEBOOK_MARKDOWN_first";
  const secondTextToken = "VSC_R_NOTEBOOK_MARKDOWN_second";
  const nativeTextHtml = await firstBridge.renderText(
    [
      {
        token: firstTextToken,
        source: "# Native section {#sec-native}",
      },
      {
        token: secondTextToken,
        source: [
          "::: {.callout-note}",
          "See @sec-native and @fig-aplot with value **`r notebook_process_value + 1`**.",
          "Inline math $x^2 + \\alpha$.",
          "",
          "$$\\int_0^1 x\\,dx$$",
          ":::",
        ].join("\n"),
      },
    ],
    [
      "---",
      "title: Native notebook title",
      "author: Notebook author",
      "format: html",
      "---",
      "",
      "::: {#r-notebook-markdown-first .r-notebook-markdown-cell}",
      firstTextToken,
      ":::",
      "",
      '::: {#fig-aplot fig-cap="A plot"}',
      ":::",
      "",
      "::: {#r-notebook-markdown-second .r-notebook-markdown-cell}",
      secondTextToken,
      ":::",
    ].join("\n"),
    quartoDocumentPath
  );
  assert.match(nativeTextHtml, /id="r-notebook-markdown-first"/);
  assert.match(nativeTextHtml, /id="r-notebook-markdown-second"/);
  assert.match(nativeTextHtml, /Section&nbsp;1|Section.1/);
  assert.match(nativeTextHtml, /href="#fig-aplot"/);
  assert.match(nativeTextHtml, /class="quarto-xref"/);
  assert.match(nativeTextHtml, /quarto-float-caption/);
  assert.match(nativeTextHtml, /A plot/);
  assert.match(nativeTextHtml, /callout-note/);
  assert.match(nativeTextHtml, /value <strong>42<\/strong>/);
  assert.match(nativeTextHtml, /<header id="title-block-header"/);
  assert.match(nativeTextHtml, /Native notebook title/);
  assert.match(nativeTextHtml, /Notebook author/);
  assert.match(nativeTextHtml, /<math display="inline"/);
  assert.match(nativeTextHtml, /x\^2 \+ \\alpha/);
  assert.match(nativeTextHtml, /<math display="block"/);

  const nonHtmlQuartoText = await firstBridge.renderText(
    [{ token: firstTextToken, source: "Notebook-only Quarto HTML" }],
    [
      "---",
      "format: pdf",
      "---",
      "",
      "::: {#r-notebook-markdown-first .r-notebook-markdown-cell}",
      firstTextToken,
      ":::",
    ].join("\n"),
    quartoDocumentPath
  );
  assert.match(nonHtmlQuartoText, /id="r-notebook-markdown-first"/);
  assert.match(nonHtmlQuartoText, /Notebook-only Quarto HTML/);

  const rMarkdownOnlyBridge = new RExecutionBridge(
    helperPath,
    firstProcess,
    () => path.join(directory, "missing-quarto")
  );
  const nativeRMarkdownHtml = await rMarkdownOnlyBridge.renderText(
    [
      {
        token: firstTextToken,
        source: "# R Markdown section {#sec-rmarkdown}",
      },
      {
        token: secondTextToken,
        source: [
          "See Figure \\@ref(fig:aplot) and Section \\@ref(sec-rmarkdown)",
          "with value **`r notebook_process_value + 1`**.",
          "Inline math $x^2 + \\beta$.",
          "",
          "$$\\sum_{i=1}^n i$$",
        ].join("\n"),
      },
    ],
    [
      "---",
      "title: Native R Markdown title",
      "author: R Markdown author",
      "output:",
      "  bookdown::html_document2: default",
      "---",
      "",
      "::: {#r-notebook-markdown-first .r-notebook-markdown-cell}",
      firstTextToken,
      ":::",
      "",
      '<div class="figure">',
      '<p class="caption">(\\#fig:aplot) A plot</p>',
      "</div>",
      "",
      "::: {#r-notebook-markdown-second .r-notebook-markdown-cell}",
      secondTextToken,
      ":::",
    ].join("\n"),
    documentPath
  );
  assert.match(nativeRMarkdownHtml, /id="r-notebook-markdown-first"/);
  assert.match(nativeRMarkdownHtml, /href="#fig:aplot"/);
  assert.match(nativeRMarkdownHtml, /href="#sec-rmarkdown"/);
  assert.match(nativeRMarkdownHtml, /Section\s+<a href="#sec-rmarkdown">1<\/a>/);
  assert.match(nativeRMarkdownHtml, /value\s+<strong>42<\/strong>/);
  assert.match(nativeRMarkdownHtml, /Native R Markdown title/);
  assert.match(nativeRMarkdownHtml, /R Markdown author/);
  assert.match(nativeRMarkdownHtml, /<div id="header">/);
  assert.match(nativeRMarkdownHtml, /<math display="inline"/);
  assert.match(nativeRMarkdownHtml, /<math display="block"/);
  const rMarkdownCellStart = nativeRMarkdownHtml.indexOf(
    '<div id="r-notebook-markdown-second"'
  );
  const rMarkdownCellEnd = nativeRMarkdownHtml.indexOf("</div>", rMarkdownCellStart);
  const rMarkdownCellHtml = nativeRMarkdownHtml.slice(
    rMarkdownCellStart,
    rMarkdownCellEnd
  );
  assert.match(rMarkdownCellHtml, /href="#fig:aplot"/);
  assert.match(rMarkdownCellHtml, /href="#sec-rmarkdown"/);
  assert.match(rMarkdownCellHtml, /<math display="inline"/);
  assert.match(rMarkdownCellHtml, /<math display="block"/);

  const nonHtmlRMarkdownText = await rMarkdownOnlyBridge.renderText(
    [{ token: firstTextToken, source: "Notebook-only R Markdown HTML" }],
    [
      "---",
      "title: Notebook-only R Markdown title",
      "output:",
      "  bookdown::pdf_document2: default",
      "---",
      "",
      "::: {#r-notebook-markdown-first .r-notebook-markdown-cell}",
      firstTextToken,
      ":::",
    ].join("\n"),
    documentPath
  );
  assert.match(nonHtmlRMarkdownText, /id="r-notebook-markdown-first"/);
  assert.match(nonHtmlRMarkdownText, /Notebook-only R Markdown HTML/);
  assert.match(
    nonHtmlRMarkdownText,
    /<h1 class="title toc-ignore">Notebook-only R Markdown title<\/h1>/
  );

  const figureReferenceDocument = parseDocument([
    "---",
    "output:",
    "  bookdown::html_document2: default",
    "---",
    "",
    '```{r fig-test, fig.height=4, fig.height=4, message=FALSE,fig.cap="This is a figure"}',
    "plot(cars)",
    "```",
    "",
    "\\@ref(fig:fig-test)",
  ].join("\n"));
  const figureReferenceIds = new Map<number, string>();
  for (const [index, cell] of figureReferenceDocument.cells.entries()) {
    if (cell.kind === "markup") {
      figureReferenceIds.set(index, `figure-reference-${index}`);
    }
  }
  const figureReferenceNative = nativeTextDocument(
    figureReferenceDocument.cells,
    figureReferenceIds,
    figureReferenceDocument.eol,
    "rMarkdown"
  );
  const figureReferenceHtml = await rMarkdownOnlyBridge.renderText(
    figureReferenceNative.replacements,
    figureReferenceNative.source,
    documentPath
  );
  assert.match(figureReferenceHtml, /href="#fig:fig-test">1<\/a>/);
  assert.doesNotMatch(figureReferenceHtml, />\?\?<\/a>/);

  const textProjectDirectory = path.join(directory, "text-project");
  const textProjectDocumentDirectory = path.join(textProjectDirectory, "documents");
  const textProjectDocument = path.join(textProjectDocumentDirectory, "report.qmd");
  await fsPromises.mkdir(textProjectDocumentDirectory, { recursive: true });
  await fsPromises.writeFile(
    path.join(textProjectDirectory, "_quarto.yml"),
    "project:\n  type: default\nformat: html\nfilters: [text-filter.lua]\n",
    "utf8"
  );
  await fsPromises.writeFile(
    path.join(textProjectDirectory, "text-filter.lua"),
    [
      "function Str(value)",
      "  if value.text == 'before-temp-project-filter' then",
      "    value.text = 'after-temp-project-filter'",
      "  end",
      "  return value",
      "end",
      "",
    ].join("\n"),
    "utf8"
  );
  await fsPromises.writeFile(textProjectDocument, "", "utf8");
  const projectTextToken = "VSC_R_NOTEBOOK_MARKDOWN_project";
  const projectTextHtml = await firstBridge.renderText(
    [{ token: projectTextToken, source: "before-temp-project-filter" }],
    [
      "::: {#r-notebook-markdown-project .r-notebook-markdown-cell}",
      projectTextToken,
      ":::",
    ].join("\n"),
    textProjectDocument
  );
  assert.match(projectTextHtml, /after-temp-project-filter/);
  assert.doesNotMatch(projectTextHtml, /before-temp-project-filter/);

  const sameSession = await firstBridge.execute(
    rmdChunk("notebook_process_value + 1"),
    documentPath,
    neverCancelled
  );
  const otherSession = await secondBridge.execute(
    rmdChunk('exists("notebook_process_value", inherits = FALSE)'),
    documentPath,
    neverCancelled
  );

  assert.match(outputText(sameSession), /42/);
  assert.match(outputText(otherSession), /FALSE/);

  const firstAttachCount = await firstBridge.execute(
    rmdChunk("getOption('r_notebook_test_attach_count')"),
    documentPath,
    neverCancelled
  );
  const secondAttachCount = await secondBridge.execute(
    rmdChunk("getOption('r_notebook_test_attach_count')"),
    documentPath,
    neverCancelled
  );
  assert.match(outputText(firstAttachCount), /1/);
  assert.match(outputText(secondAttachCount), /1/);

  const firstProcessId = firstProcess.processId;
  assert.ok(firstProcessId);
  await firstProcess.reattachExisting(firstProcessId);
  await assert.rejects(
    firstProcess.reattachExisting(firstProcessId + 1),
    /no longer available/
  );
  const reattachedCount = await firstBridge.execute(
    rmdChunk("getOption('r_notebook_test_attach_count')"),
    documentPath,
    neverCancelled
  );
  const preservedAfterReattach = await firstBridge.execute(
    rmdChunk("notebook_process_value"),
    documentPath,
    neverCancelled
  );
  assert.match(outputText(reattachedCount), /2/);
  assert.match(outputText(preservedAfterReattach), /41/);

  const figure = await firstBridge.execute(
    qmdChunk([
      "#| echo: false",
      "#| fig-format: png",
      "#| fig-width: !expr 1 + 2",
      "#| fig-height: 2",
      "#| fig-dpi: 300",
      "#| fig-retina: 1",
      "#| layout: [[45, -10, 45], [100]]",
      "plot(1:3, 3:1)",
      "plot(1:4, 4:1)",
      "plot(1:5, 5:1)",
    ].join("\n")),
    quartoDocumentPath,
    neverCancelled
  );
  const figureHtml = outputText(figure);
  assert.equal(
    figure.outputs[0]?.mime,
    "text/html"
  );
  const encodedPngs = [...figureHtml.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)];
  assert.equal(encodedPngs.length, 3);
  for (const match of encodedPngs) {
    const pngData = Buffer.from(match[1] ?? "", "base64");
    assert.equal(pngData.readUInt32BE(16), 900);
    assert.equal(pngData.readUInt32BE(20), 600);
  }
  assert.match(figureHtml, /quarto-layout-row/);
  assert.match(figureHtml, /quarto-figure-spacer/);

  const currentDocumentContext = await firstBridge.execute(
    qmdChunk([
      "#| echo: false",
      "cat('current unsaved context')",
      "warning('stale saved context')",
    ].join("\n")),
    quartoDocumentPath,
    neverCancelled,
    {
      documentSource: [
        "---",
        "format: html",
        "execute:",
        "  warning: false",
        "---",
        "",
      ].join("\n"),
      documentId: quartoDocumentPath,
      cellId: "unsaved-context-cell",
    }
  );
  const currentDocumentHtml = outputText(currentDocumentContext);
  assert.match(currentDocumentHtml, /current unsaved context/);
  assert.doesNotMatch(currentDocumentHtml, /stale saved context/);
  assert.equal(
    (await fsPromises.readdir(directory)).some((entry) =>
      entry.startsWith(".vsc-r-notebook-")
    ),
    false
  );
  assert.deepEqual(workingDirectoryArtifacts, []);

  const setupOptions = await firstBridge.execute(
    qmdChunk([
      "#| include: false",
      "knitr::opts_chunk$set(comment = '@@', echo = FALSE)",
      "knitr::opts_hooks$set('native-option' = function(options) {",
      "  if (isTRUE(options[['native-option']])) options$comment <- 'NATIVE:'",
      "  options",
      "})",
    ].join("\n")),
    quartoDocumentPath,
    neverCancelled
  );
  assert.equal(setupOptions.success, true);
  const arbitraryNativeOption = await firstBridge.execute(
    qmdChunk("#| native-option: true\n1 + 1"),
    quartoDocumentPath,
    neverCancelled
  );
  assert.match(outputText(arbitraryNativeOption), /NATIVE:.*2/);

  await firstBridge.execute(
    qmdChunk("#| include: false\nknitr::opts_chunk$set(comment = '##', echo = true)"),
    quartoDocumentPath,
    neverCancelled
  );

  await fallbackProcess.reattach();
  const fallbackAssignment = await fallbackBridge.execute(
    rmdChunk("fallback_notebook_value <- 17"),
    documentPath,
    neverCancelled
  );
  assert.equal(fallbackAssignment.success, true);
  const fallbackAttachCount = await fallbackBridge.execute(
    rmdChunk("getOption('r_notebook_test_attach_count')"),
    documentPath,
    neverCancelled
  );
  assert.match(outputText(fallbackAttachCount), /1/);
  const fallbackAttachDirectory = await fallbackBridge.execute(
    rmdChunk(`base::identical(base::normalizePath(base::getOption('r_notebook_test_attach_wd')), base::normalizePath(${JSON.stringify(directory)}))`),
    documentPath,
    neverCancelled
  );
  assert.match(outputText(fallbackAttachDirectory), /TRUE/);
  const fallbackProfileTerminal = await fallbackBridge.execute(
    rmdChunk("base::getOption('r_notebook_test_profile_term')"),
    documentPath,
    neverCancelled
  );
  assert.match(outputText(fallbackProfileTerminal), /vscode/);
  const fallbackPlotViewers = await fallbackBridge.execute(
    rmdChunk(
      "base::identical(base::getOption('vsc.plot'), FALSE) && " +
        "base::identical(base::getOption('vsc.use_httpgd'), FALSE)"
    ),
    documentPath,
    neverCancelled
  );
  assert.match(outputText(fallbackPlotViewers), /TRUE/);

  await assert.rejects(
    failedProcess.reattach(),
    /Cannot find the installed vscode-R session initialiser/
  );

  await assert.rejects(
    secondBridge.execute(
      rmdChunk('q(save = "no", status = 7, runLast = FALSE)'),
      documentPath,
      neverCancelled
    ),
    /exited with code 7/
  );

  const restartedAttachCount = await secondBridge.execute(
    rmdChunk("getOption('r_notebook_test_attach_count')"),
    documentPath,
    neverCancelled
  );
  assert.match(outputText(restartedAttachCount), /1/);
});
