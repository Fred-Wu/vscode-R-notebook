extra_paths <- Sys.getenv("R_NOTEBOOK_LSP_LIB_PATHS")
if (nzchar(extra_paths)) {
  .libPaths(c(.libPaths(), strsplit(extra_paths, "\n", fixed = TRUE)[[1L]]))
}
if (identical(Sys.getenv("R_NOTEBOOK_LSP_RENV"), "true") &&
    requireNamespace("renv", quietly = TRUE)) {
  .libPaths(c(.libPaths(), renv::paths$cache()))
}
if (!requireNamespace("languageserver", quietly = TRUE)) {
  stop("Install the R package 'languageserver' to enable notebook language features.")
}
# Cells are virtual documents; lintr must use their live text, not a disk cache.
options(languageserver.lint_cache = FALSE)
# uvr's installed packages are dependencies, not workspace source. Traversing
# their trees can block the server before it handles the first notebook cell.
# Keep languageserver's defaults and any project-specific exclusions.
index_exclude <- getOption("languageserver.index_exclude")
if (is.null(index_exclude)) {
  settings <- get0("lsp_settings", asNamespace("languageserver"), inherits = FALSE)
  if (!is.null(settings)) index_exclude <- settings$get("index_exclude")
}
options(languageserver.index_exclude = unique(c(index_exclude, "**/.uvr/**")))
if (identical(Sys.getenv("R_NOTEBOOK_LSP_INDEX"), "false")) {
  options(languageserver.index_mode = "off")
}
languageserver::run(
  port = as.integer(Sys.getenv("R_NOTEBOOK_LSP_PORT")),
  debug = identical(Sys.getenv("R_NOTEBOOK_LSP_DEBUG"), "true")
)
