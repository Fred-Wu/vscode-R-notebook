# R Notebook for VS Code

R Notebook for VS Code opens R Markdown (`.rmd`) and Quarto (`.qmd`) files as VS Code notebooks. Filename extension matching is case-insensitive. It gives each notebook an inline R session and shows R results and plots below code cells while keeping the document in its original file format.

The notebook renders only the minimal information from `.rmd` and `.qmd` files needed to support the inline R session and display Markdown cells. It does not provide full R Markdown or Quarto rendering. Use the normal R Markdown or Quarto render workflow when you need a complete HTML, PDF, Word, or other published document.

## Features

- Run R code cells with inline results, plots, and table previews.
- Use a separate R session for each notebook.
- Start the notebook's R session automatically when it becomes active.
- Display Markdown cells with headings, references, and inline R results.
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
- Configure the vscode-R path for your platform:
  - Windows: `r.rpath.windows`
  - macOS: `r.rpath.mac`
  - Linux: `r.rpath.linux`
- Alternatively, make R available through `R_HOME` or `PATH`.
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

## R Sessions

- Use **Restart R** to start a fresh session.
- Use **Shutdown and Close** to close the notebook and stop its R process.
- Keep a closed notebook's session for 15 minutes by default.
- Use **R Notebook: Reopen Running Notebook Session...** to reopen a retained session.
- Set `r.notebook.sessionShutdownDelayMinutes` to `0` to disable automatic shutdown.

## vscode-R Integration

- Run inline code and display Markdown cells without the vscode-R session watcher.
- Enable both settings to use vscode-R workspace, data, and help viewers:

  ```json
  "r.sessionWatcher": true,
  "r.notebook.rExtensionIntegration": true
  ```

- Reload the VS Code window after changing either setting.
- Disable `r.notebook.rExtensionIntegration` to run without vscode-R session integration.

## Configuration

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
