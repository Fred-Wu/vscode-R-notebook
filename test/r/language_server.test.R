local({
  root <- tempfile("notebook-lsp-index-")
  dir.create(root)
  on.exit(unlink(root, recursive = TRUE), add = TRUE)
  for (directory in c("R", ".uvr/library/example/R", "nested/.uvr/library/example/R", ".git", "generated")) {
    dir.create(file.path(root, directory), recursive = TRUE, showWarnings = FALSE)
    writeLines("unopened_project_function <- function(x) x + 1", file.path(root, directory, "helper.R"))
  }
  ns <- asNamespace("languageserver")
  # Exercise the complete startup script without starting its TCP server.
  trace("run", where = ns, tracer = quote(stop("notebook test startup configured")), print = FALSE)
  on.exit(untrace("run", where = ns), add = TRUE)
  original_options <- options()
  on.exit(options(original_options), add = TRUE)
  Sys.setenv(R_NOTEBOOK_LSP_INDEX = "true")
  for (custom in c(FALSE, TRUE)) {
    options(languageserver.index_exclude = if (custom) "**/generated/**" else NULL)
    failure <- tryCatch({
      sys.source("resources/r/language_server.R", envir = new.env())
      NULL
    }, error = conditionMessage)
    stopifnot(identical(failure, "notebook test startup configured"))
    exclusions <- getOption("languageserver.index_exclude")
    stopifnot("**/.uvr/**" %in% exclusions)
    if (custom) stopifnot("**/generated/**" %in% exclusions)
    else stopifnot("**/.git/**" %in% exclusions, "**/renv/**" %in% exclusions)
    get("lsp_settings", ns)$update_from_options()
    index <- get("WorkspaceIndex", ns)$new(root)
    index$discover()
    paths <- vapply(index$files$values(), function(file) file$path, character(1))
    stopifnot(any(grepl("/R/helper.R$", paths)))
    stopifnot(!any(grepl("/.uvr/", paths, fixed = TRUE)))
    if (custom) stopifnot(!any(grepl("/generated/", paths, fixed = TRUE)))
    else stopifnot(!any(grepl("/.git/", paths, fixed = TRUE)))
  }
})
cat("Notebook language server excludes installed uvr packages and keeps unopened project source indexed.\n")
