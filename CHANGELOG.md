# Changelog

All notable changes to R Notebook for VS Code will be documented in this file.

## Unreleased

- Rendered data frames, data.tables, and tibbles as consistent static inline tables with column types, showing the first and last ten rows with an index-column separator for large data sets. The same preview is used by `View()` when R Extension Integration is disabled, while explicit `head(df, n)` and `tail(df, n)` results show all requested rows in the same table style.
- Fixed automatic vscode-R session attachment for notebook R processes on Windows.
- Disabled unused RStudio API emulation in inline notebook R sessions.
- Made the vscode-R session watcher optional for inline code and rendering.
- Started the hidden notebook R process automatically, independently of vscode-R integration.
- Added an R Extension Integration checkbox for inline notebook R processes.
- Renamed Restart R Session to Restart R and removed the manual start command.
- Replaced built-in notebook suggestion lists with suggestions based on installed tools and notebook contents.
- Added suggestions while typing in Quarto YAML headers without interrupting Markdown writing.
- Kept R Markdown cell-option suggestions out of Quarto notebooks.
- Kept R Markdown header and pipe options unless they are explicitly merged.
- Fixed R Markdown figure reference links so they jump to the matching plot output.
- Fixed R Markdown cell execution so it uses R Markdown directly and does not require Quarto.
- Kept R Markdown cell-option suggestions available without Quarto.
- Fixed Shutdown and Close so it closes every open tab for the notebook.

## [0.1.0] - 2026-07-23

- Initial Release
