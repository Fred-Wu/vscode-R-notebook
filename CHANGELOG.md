# Changelog

All notable changes to R Notebook for VS Code will be documented in this file.

## Unreleased

- Made the vscode-R session watcher optional for inline code and rendering.
- Added background, first-run, and manual choices for starting notebook R sessions.
- Added a visible startup message and a Start R Session button for manual startup.
- In manual startup mode, show Start R Session before the session starts and Restart R Session after it starts.
- Replaced built-in notebook suggestion lists with suggestions based on installed tools and notebook contents.
- Added suggestions while typing in Quarto YAML headers without interrupting Markdown writing.
- Kept R Markdown cell-option suggestions out of Quarto notebooks.
- Fixed R Markdown figure reference links so they jump to the matching plot output.
- Fixed R Markdown cell execution so it uses R Markdown directly and does not require Quarto.
- Kept R Markdown cell-option suggestions available without Quarto.
- Fixed Shutdown and Close so it closes every open tab for the notebook.

## [0.1.0] - 2026-07-23

- Initial Release
