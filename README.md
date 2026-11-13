# R Notebook for VS Code

R Notebook for VS Code opens R Markdown (`.rmd`) and Quarto (`.qmd`) files as VS Code notebooks. Filename extension matching is case-insensitive. It gives each notebook an inline R session and shows R results and plots below code cells while keeping the document in its original file format.

The notebook renders only the minimal information from `.rmd` and `.qmd` files needed to support the inline R session and display Markdown cells. It does not provide full R Markdown or Quarto rendering. Use the normal R Markdown or Quarto render workflow when you need a complete HTML, PDF, Word, or other published document.

## Features

- Run R code cells with inline results, plots, and table previews.
- Use a separate R session for each notebook.
- Start the notebook's R session automatically when it becomes active.
- Display Markdown cells with headings, references, and inline R results.
- Display YAML title, author, and date metadata, plus a clickable table of contents when enabled.
- Edit cell labels and options from the cell toolbar.
- Show suggestions based on installed R and Quarto tools and notebook content.
- Send code cells to [R Console for VS Code](https://marketplace.visualstudio.com/items?itemName=RConsole.vsc-r-console).
- Save and restore outputs with an optional `.r-notebook` sidecar file.
- Connect the active session to [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) viewers.

## Setup

- Install R.
- Install `knitr` 1.44 or newer and `rmarkdown`:

  ```r
  install.packages(c("knitr", "rmarkdown"))
  ```

- On Windows, install `ps` to cancel a cell without stopping its R session:

  ```r
  install.packages("ps")
  ```

- Install `bookdown` when an R Markdown document uses a `bookdown::` output format.
- Install [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r).
- Install [R Console for VS Code](https://marketplace.visualstudio.com/items?itemName=RConsole.vsc-r-console).
- Configure R through vscode-R's `r.executablePath` setting, or make R available through `R_HOME` or `PATH`.
- Install the Quarto CLI for `.qmd` notebooks.
- Set `r.notebook.quartoPath` if Quarto is not on the R session's `PATH`.
- Make Pandoc available to `rmarkdown` for R Markdown-cell display.
- Trust the VS Code workspace before running local R code.

## Use

- Open a file from the Explorer with **Open as R Notebook**.
- Use **Reopen Editor With...** and choose **R Notebook Editor** when needed.
- Save normally to write changes back to the original `.rmd` or `.qmd` file.
- Use the notebook run buttons to run one or more cells.
- Use **Run Cell in R Console** to send a cell to the interactive R Console.
- Select the gear button on a code cell to edit its label and options.
- Use **Merge to header** or **Merge to pipe** to combine R Markdown options.
- Treat `#|` pipe values as the winner when R Markdown options conflict.
- Store Quarto cell options in `#|` pipe lines.

The first Markdown cell displays the document's title, author, and date using the
native renderer's formatting. When the YAML enables a table of contents (`toc: true`
in the HTML format options), it appears below the title block and before the body.
TOC links reveal the notebook cell containing the heading. TOC depth and section
numbering follow the YAML settings. The YAML source remains available in the
collapsible **YAML front matter** section; the displayed header and TOC are not
added to the saved document.

The notebook preview uses HTML even when the publishing output is Word or PDF.
Explicit HTML outline settings take precedence; otherwise portable outline
settings from the selected publishing format are used. The TOC lists Markdown
headings such as `# Introduction` and `## Details`, rather than code-cell labels.

## R Sessions

- Use **Restart R** to start a fresh session.
- Use **Shutdown and Close** to close the notebook and stop its R process.
- Keep a closed notebook's session for 15 minutes by default.
- Use **R Notebook: Reopen Running Notebook Session...** to reopen a retained session.
- Set `r.notebook.sessionShutdownDelayMinutes` to `0` to disable automatic shutdown.

## vscode-R Integration

Each notebook owns a separate inline R process. With integration enabled, that
process attaches automatically to vscode-R, allowing its workspace, data, and
help viewers to follow the selected notebook. Switching notebooks selects the
corresponding session without sharing R objects between them.

Both settings must be enabled (the defaults):

```json
{
  "r.sessionWatcher": true,
  "r.notebook.rExtensionIntegration": true
}
```

Reload the VS Code window after changing either setting. Integration requires a
vscode-R build exposing the public managed `sess` attachment API. vscode-R manages
the matching R package; first-time installation may require consent. Notebook
attachment is automatic, so no attachment command is needed in notebook cells.

To inspect an object, run its defining cell in the notebook, then use
`utils::View(object)` in a notebook cell or the **View in R Notebook** action on
a top-level object in the R Workspace Viewer. Data frames and lists use
vscode-R's viewers. Viewer requests wait for any running notebook execution.

**Run Cell in R Console** uses a separate interactive R Console session. It has
its own objects and can become the session shown by vscode-R. Select the notebook
again to return the viewers to its inline session. **Restart R** and **Shutdown
and Close** operate on the notebook's inline session; closing its tab normally
retains that session according to `r.notebook.sessionShutdownDelayMinutes`.
Reloading or closing the VS Code window stops notebook-owned sessions.

Set `r.notebook.rExtensionIntegration` to `false` and reload to use inline
execution and Markdown rendering without automatic viewer attachment. vscode-R
remains an extension dependency and still provides R executable discovery.
This setting is separate from notebook language features, which use
`r.lsp.enabled` and the R package `languageserver`.

If integration does not start:

- Check both settings above and reload after changing them.
- If the error says vscode-R does not expose the `sess` attachment API, install a compatible vscode-R build.
- Check **Output → R Notebook Kernel** and vscode-R's output for R startup errors or pending package-installation consent.
- If the viewers show another session, select the notebook and ensure the object was created by inline execution.


| Setting                                     | Default | Purpose                                                    |
| ------------------------------------------- | ------- | ---------------------------------------------------------- |
| `r.notebook.quartoPath`                     | `""`    | Sets the Quarto executable path                            |
| `r.notebook.saveState`                      | `true`  | Saves and restores output in a `.r-notebook` sidecar file  |
| `r.notebook.rExtensionIntegration`          | `true`  | Connects the active notebook session to vscode-R           |
| `r.notebook.sessionShutdownDelayMinutes`    | `15`    | Retains a closed notebook's R session for this many minutes |

- Disable `r.notebook.saveState` to ignore existing sidecar files and stop creating new ones.

## Dependencies

- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) — Provides the R path and optional viewer integration.
- [R Console for VS Code](https://marketplace.visualstudio.com/items?itemName=RConsole.vsc-r-console) — Provides interactive console execution.
- `knitr` 1.44 or newer and `rmarkdown` — Support execution and Markdown-cell display.
- Quarto CLI — Supports `.qmd` notebooks.
- `ps` on Windows — Interrupts a cell without stopping its session.
- `bookdown` when required — Supports `bookdown::` R Markdown formats.

## Development Note

This extension's source code was written with assistance from GPT models using OpenAI's Codex. The overall feature design and logic decisions are mine; GPT models were used to generate and iterate on the implementation.

## License

- MIT
