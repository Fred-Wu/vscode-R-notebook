source(file.path("resources", "r", "execute.R"), local = TRUE)

stopifnot(requireNamespace("knitr", quietly = TRUE))
stopifnot(requireNamespace("rmarkdown", quietly = TRUE))

test_root <- tempfile("r-notebook-bridge-test-")
dir.create(test_root)
on.exit(unlink(test_root, recursive = TRUE, force = TRUE), add = TRUE)

document <- file.path(test_root, "notebook.Rmd")
writeLines(c(
  "---",
  "output: html_document",
  "---",
  ""
), document)

quarto_document <- file.path(test_root, "notebook.qmd")
writeLines(c(
  "---",
  "format: html",
  "---",
  ""
), quarto_document)

run_chunk <- function(name, source, notebook = document) {
  output_dir <- file.path(test_root, name)
  dir.create(output_dir)
  extension <- if (identical(tolower(tools::file_ext(notebook)), "qmd")) {
    ".qmd"
  } else {
    ".Rmd"
  }
  chunk_path <- file.path(output_dir, paste0("chunk", extension))
  writeLines(source, chunk_path, useBytes = TRUE)
  r_notebook_execute(
    chunk_path = chunk_path,
    document_path = notebook,
    native_document_path = notebook,
    document_id = notebook,
    cell_id = name,
    cell_key = name,
    output_dir = output_dir,
    working_dir = test_root,
    evaluation_env = .GlobalEnv,
    quarto_executable = ""
  )
  output_dir
}

output_text <- function(output_dir) {
  metadata_paths <- list.files(
    output_dir,
    pattern = "^[0-9]{6}\\.meta$",
    full.names = TRUE
  )
  payloads <- vapply(metadata_paths, function(metadata_path) {
    metadata <- readLines(metadata_path, warn = FALSE)
    payload <- sub("^file: ", "", grep("^file: ", metadata, value = TRUE))
    paste(
      readLines(file.path(output_dir, payload), warn = FALSE),
      collapse = "\n"
    )
  }, character(1L))
  paste(payloads, collapse = "\n")
}

assert_done <- function(output_dir, expected) {
  actual <- readLines(file.path(output_dir, "done"), warn = FALSE)
  if (!identical(actual, expected)) {
    cat("Unexpected bridge status in", output_dir, ": expected", expected,
        "but received", actual, "\n", file = stderr())
    cat(output_text(output_dir), "\n", file = stderr())
  }
  stopifnot(identical(actual, expected))
}

first <- run_chunk("first", c(
  "```{r, echo=FALSE}",
  "notebook_value <- 41L",
  "notebook_value",
  "```"
))
assert_done(first, "true")
stopifnot(grepl("41", output_text(first), fixed = TRUE))

second <- run_chunk("second", c(
  "```{r}",
  "#| echo: false",
  "notebook_value + 1L",
  "```"
), quarto_document)
assert_done(second, "true")
stopifnot(grepl("42", output_text(second), fixed = TRUE))

failed <- run_chunk("failed", c(
  "```{r, echo=FALSE, error=FALSE}",
  "stop('expected bridge error')",
  "```"
))
assert_done(failed, "false")
failed_metadata <- readLines(file.path(failed, "000001.meta"), warn = FALSE)
stopifnot("kind: error" %in% failed_metadata)
stopifnot(grepl("expected bridge error", output_text(failed), fixed = TRUE))

text_document <- file.path(test_root, "text.qmd")
writeLines(c(
  "---",
  "title: \"Horizon\"",
  "format: html",
  "---",
  "",
  "::: {#r-notebook-markdown-title .r-notebook-markdown-cell}",
  "VSC_R_NOTEBOOK_MARKDOWN_title",
  ":::"
), text_document, useBytes = TRUE)
text_output <- file.path(test_root, "text-render")
dir.create(text_output)
text_cells <- file.path(text_output, "cells.json")
writeLines(
  '[{"token":"VSC_R_NOTEBOOK_MARKDOWN_title","source":"# Text"}]',
  text_cells,
  useBytes = TRUE
)
r_notebook_render_text(
  cells_path = text_cells,
  native_document_path = text_document,
  output_dir = text_output,
  working_dir = test_root,
  evaluation_env = .GlobalEnv,
  quarto_executable = ""
)
assert_done(text_output, "true")
text_html <- paste(readLines(
  file.path(text_output, "result.html"),
  warn = FALSE,
  encoding = "UTF-8"
), collapse = "\n")
stopifnot(grepl("Horizon", text_html, fixed = TRUE))
stopifnot(grepl("r-notebook-markdown-title", text_html, fixed = TRUE))


# Fenced examples must never execute apparent inline R expressions.
r_notebook_inline_probe <- 0L
inline_source <- c(
  "Inside literal code:",
  "````markdown",
  "`r {r_notebook_inline_probe <- 1L; stop('fenced code executed')}`",
  "````",
  "Outside `r 2 + 2`."
)
inline_output <- r_notebook_inline_markdown(inline_source, .GlobalEnv)
stopifnot(identical(r_notebook_inline_probe, 0L))
stopifnot(grepl("fenced code executed", inline_output, fixed = TRUE))
stopifnot(grepl("Outside 4.", inline_output, fixed = TRUE))


# Four-space indented Markdown is also literal code, not inline R.
r_notebook_inline_probe <- 0L
indented_output <- r_notebook_inline_markdown(c(
  "    `r {r_notebook_inline_probe <- 1L; stop('indented code executed')}`",
  "Outside `r 6 + 1`."
), .GlobalEnv)
stopifnot(identical(r_notebook_inline_probe, 0L))
stopifnot(grepl("indented code executed", indented_output, fixed = TRUE))
stopifnot(grepl("Outside 7.", indented_output, fixed = TRUE))
