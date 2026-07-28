# R Notebook for VS Code

Open R Markdown (`.rmd`) and Quarto (`.qmd`) files as VS Code notebooks, render markdown texts and show R results below each cell. The document remains valid R Markdown or Quarto, with optional notebook state saved beside it.

## Requirements

- R with `knitr` 1.44 or newer and `rmarkdown`
- `bookdown` when an R Markdown file selects a `bookdown::` output format
- [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r)
- [R Console for VS Code](https://marketplace.visualstudio.com/items?itemName=RConsole.vsc-r-console)
- Quarto CLI for `.qmd` files

Set the correct `r.rpath.*` option in vscode-R and keep its session watcher enabled:

```json
"r.sessionWatcher": true
```

The inline R session starts in the background when a notebook becomes active.
Change `r.notebook.sessionStartup` when a different startup time is preferred:

```json
"r.notebook.sessionStartup": "background"
```

- `background` starts the session while the active notebook is being prepared.
- `onExecution` starts the session when the first code cell runs.
- `manual` shows a **Start R Session** button and never starts the session implicitly.

## Features
 - Render markdown cells as you go. 
 - Inline display R outputs and plots beneath code cell. 
 - Autocompletion options for YAML, Markdown and R code cells. 
 - Restore outputs and plots using a `.r-notebook` file if `Save State` setting is turned on.
 
 
