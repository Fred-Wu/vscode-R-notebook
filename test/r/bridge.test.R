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

first <- run_chunk("first", c(
  "```{r, echo=FALSE}",
  "notebook_value <- 41L",
  "notebook_value",
  "```"
))
stopifnot(identical(readLines(file.path(first, "done")), "true"))
stopifnot(grepl("41", output_text(first), fixed = TRUE))

second <- run_chunk("second", c(
  "```{r}",
  "#| echo: false",
  "notebook_value + 1L",
  "```"
), quarto_document)
stopifnot(identical(readLines(file.path(second, "done")), "true"))
stopifnot(grepl("42", output_text(second), fixed = TRUE))

failed <- run_chunk("failed", c(
  "```{r, echo=FALSE, error=FALSE}",
  "stop('expected bridge error')",
  "```"
))
stopifnot(identical(readLines(file.path(failed, "done")), "false"))
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
stopifnot(identical(readLines(file.path(text_output, "done")), "true"))
text_html <- paste(readLines(
  file.path(text_output, "result.html"),
  warn = FALSE,
  encoding = "UTF-8"
), collapse = "\n")
stopifnot(grepl("Horizon", text_html, fixed = TRUE))
stopifnot(grepl("r-notebook-markdown-title", text_html, fixed = TRUE))
