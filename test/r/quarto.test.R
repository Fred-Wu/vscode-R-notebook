source(file.path("resources", "r", "execute.R"), local = TRUE)
r_notebook_load(file.path("resources", "r"))
r_notebook_math_assets <- normalizePath(file.path("dist", "katex"), winslash = "/", mustWork = TRUE)

run_quarto_tests <- function() {
  root <- tempfile("notebook-quarto-project-")
  dir.create(root)
  on.exit(unlink(root, recursive = TRUE), add = TRUE)
  nested <- file.path(root, "reports"); dir.create(nested)
  document <- file.path(nested, "notebook.qmd")
  env <- new.env(parent = globalenv())
  writeLines(c("format:", "  html:", "    toc: true", "    toc-depth: 1",
    "execute:", "  warning: false", "  fig-width: 4", "  output: false",
    "params:", "  value: 40"), file.path(root, "_quarto.yml"))
  writeLines(c("author:", "  - name: Example Author", "format:", "  html:",
    "    toc-depth: 2"), file.path(nested, "_metadata.yml"))
  writeLines(c("---", "title: Unsaved report", "format: html", "execute:",
    "  output: true", "params:", "  value: 42", "---"), document)
  metadata <- r_notebook_quarto_metadata(document, env)
  stopifnot(isTRUE(metadata$toc), metadata[["toc-depth"]] == 2,
    identical(metadata$author, "Example Author"), metadata$params$value == 42)

  # Snapshot text is elsewhere; inheritance still uses the original document.
  snapshot <- file.path(root, "snapshot.qmd")
  writeLines(readLines(document), snapshot)
  stopifnot(identical(r_notebook_quarto_metadata(snapshot, env, nested), metadata))
  run <- function(id, code) {
    dir <- file.path(root, id); dir.create(dir)
    chunk <- file.path(dir, "chunk.qmd")
    writeLines(c("```{r}", code, "```"), chunk)
    r_notebook_execute(chunk, document, snapshot, document, id, id, dir, nested, env)
    texts <- list.files(dir, "^[0-9]+[.]txt$", full.names = TRUE)
    html <- paste(vapply(texts, function(path) paste(readLines(path, warn = FALSE), collapse="\n"), character(1)), collapse="\n")
    list(success=identical(readLines(file.path(dir,"done")), "true"), html=html)
  }
  result <- run("inherited", c('stopifnot(params$value == 42, knitr::opts_current$get("fig.width") == 4)',
    'warning("suppressed warning"); message("suppressed message"); 42'))
  stopifnot(result$success, grepl("42", result$html), !grepl("suppressed", result$html),
    !grepl("Unsaved report", result$html))
  result <- run("cell-overrides", c('#| fig-width: 3', '#| fig-format: svg', '#| fig-dpi: 72',
    '#| fig-cap: A figure', '#| label: fig-demo',
    'stopifnot(knitr::opts_current$get("fig.width") == 3, knitr::opts_current$get("dev") == "svg")', 'plot(1:3)'))
  stopifnot(result$success, grepl("<svg", result$html), grepl("A figure", result$html), grepl('id="fig-demo"', result$html))
  result <- run("hidden", c('#| output: false', 'hidden_value <- 7; print(hidden_value); plot(1:3)'))
  stopifnot(result$success, !nzchar(result$html), env$hidden_value == 7)
  result <- run("asis", c('#| output: asis', 'cat("**Formatted result**")'))
  stopifnot(result$success, grepl('<strong>Formatted result</strong>', result$html, fixed=TRUE))
  result <- run("caption", c('#| tbl-cap: Table caption', 'data.frame(x=1:3)'))
  stopifnot(result$success, grepl('<caption>Table caption</caption>', result$html, fixed=TRUE))
  failed <- run("default-error", 'stop("expected failure")')
  stopifnot(!failed$success)
  continued <- run("allow-error", c('#| error: true', 'stop("allowed failure")', 'after_error <- TRUE'))
  stopifnot(continued$success, isTRUE(env$after_error))

  # Project-wide execute.enabled cannot be undone by a cell-local eval flag.
  writeLines(c("---", "execute:", "  enabled: false", "---"), snapshot)
  skipped <- run("disabled", c('#| eval: true', 'stop("must not execute")'))
  stopifnot(skipped$success, !nzchar(skipped$html))

  writeLines(c("---", "project:", "  execute-dir: project", "---"), snapshot)
  writeLines('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="3"/></svg>', file.path(root, "project.svg"))
  rooted <- run("project-root", c('#| output: asis',
    'stopifnot(file.exists("_quarto.yml")); cat(\'<img src="project.svg">\')'))
  stopifnot(rooted$success, grepl('<svg', rooted$html), !grepl('src="project.svg"', rooted$html, fixed=TRUE))

  # Shared litedown conversion preserves literal reference examples and callouts.
  html <- r_notebook_litedown_html(paste(c('# Intro {#sec-intro}', '',
    '::: {.callout-note}', 'A **note**.', ':::', '', '`@sec-intro` and @sec-intro.', '',
    '```markdown', '@fig-absent', '```'), collapse="\n"),
    list("number-sections"=TRUE), outline=TRUE, format=r_notebook_quarto)
  stopifnot(grepl('href="#sec-intro">Section 1</a>', html, fixed=TRUE),
    grepl('<code>@sec-intro</code>', html, fixed=TRUE), grepl('@fig-absent', html, fixed=TRUE),
    grepl('class="callout-note"', html, fixed=TRUE), grepl('<strong>note</strong>', html, fixed=TRUE))
}

# Neither the adapter nor the shared pipeline may launch publishing tools.
trace(base::system2, tracer=quote(stop("Unexpected external renderer")), print=FALSE)
trace(base::loadNamespace, tracer=quote({
  if (is.character(package) && any(package %in% c("rmarkdown", "bookdown", "quarto"))) stop("Unexpected publishing package")
}), print=FALSE)
tryCatch(run_quarto_tests(), finally={ untrace(base::system2); untrace(base::loadNamespace) })
cat("Quarto metadata, chunk options, and references passed without publishing tools.\n")
