# R Notebook for VS Code

Open R Markdown (`.rmd`) and Quarto (`.qmd`) files as VS Code notebooks, render markdown texts and show R results below each cell. The document remains valid R Markdown or Quarto, with optional notebook state saved beside it.

## Requirements

- R with `knitr` 1.44 or newer and `rmarkdown`
- `bookdown` when an R Markdown file selects a `bookdown::` output format
- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r)
- [R Console for VS Code](https://marketplace.visualstudio.com/items?itemName=RConsole.vsc-r-console)
- Quarto CLI for `.qmd` files

Set the correct `r.rpath.*` option in vscode-R. Its `r.sessionWatcher` setting is
optional: inline code and rendering work without it. Enable the session watcher
when the inline session should appear in vscode-R features such as the workspace
and data viewers. Reload VS Code after changing this setting.

In R Markdown notebooks, applying cell-option edits keeps both chunk-header and
`#|` pipe options. Use **Merge to header** or **Merge to pipe** to combine and
de-duplicate them. Pipe values win conflicts, matching knitr. Quarto notebooks
always use pipe options.

The inline R session starts in the background when a notebook becomes active.
Change `r.notebook.sessionStartup` when a different startup time is preferred:

```json
"r.notebook.sessionStartup": "background"
```

- `background` starts the session while the active notebook is being prepared.
- `onExecution` starts the session when the first code cell runs.
- `manual` shows **Start R Session** until the session starts, then shows **Restart R Session**. It never starts the session implicitly.

## Features
 - Render markdown cells as you go. 
 - Inline display R outputs and plots beneath code cell. 
 - Context-aware Quarto and R Markdown suggestions from installed tools and notebook contents, with automatic suggestions in Quarto YAML headers.
 - Restore outputs and plots using a `.r-notebook` file if `Save State` setting is turned on.
 
 
