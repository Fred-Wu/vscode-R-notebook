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
  "title: \"Horizon *report*\"",
  "author: Example Author",
  "date: '2026-10-17'",
  "date-format: YYYY-MM-DD",
  "format:",
  "  html:",
  "    code-fold: true",
  "    toc: true",
  "    toc-depth: 2",
  "---",
  "",
  "::: {#r-notebook-markdown-title .r-notebook-markdown-cell}",
  "VSC_R_NOTEBOOK_MARKDOWN_title",
  ":::"
), text_document, useBytes = TRUE)
text_snapshot <- readLines(text_document, warn = FALSE)
text_output <- file.path(test_root, "text-render")
dir.create(text_output)
text_cells <- file.path(text_output, "cells.json")
writeLines(
    '[{"token":"VSC_R_NOTEBOOK_MARKDOWN_title","source":"An introductory paragraph before the headings.\\n\\n~~~text\\n# Literal heading\\n~~~\\n\\n# Text\\n\\n## Details\\n\\n### Deep section\\n\\n## Omitted {.unlisted}"}]',
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
stopifnot(grepl('id="title-block-header"', text_html, fixed = TRUE))
stopifnot(grepl("Horizon <em>report</em>", text_html, fixed = TRUE))
stopifnot(grepl("Example Author", text_html, fixed = TRUE))
stopifnot(grepl('class="date">2026-10-17', text_html, fixed = TRUE))
stopifnot(grepl('id="TOC"', text_html, fixed = TRUE))
stopifnot(grepl('href="#text"', text_html, fixed = TRUE))
stopifnot(grepl('href="#details"', text_html, fixed = TRUE))
stopifnot(!grepl('href="#deep-section"', text_html, fixed = TRUE))
  stopifnot(!grepl('href="#literal-heading"', text_html, fixed = TRUE))
  stopifnot(!grepl('href="#omitted"', text_html, fixed = TRUE))

for (publishing_format in c("pdf", "docx")) {
  preview_document <- file.path(test_root, paste0(publishing_format, ".qmd"))
  preview_output <- file.path(test_root, paste0(publishing_format, "-preview"))
  dir.create(preview_output)
  writeLines(sub("^  html:$", paste0("  ", publishing_format, ":"), text_snapshot), preview_document)
  r_notebook_render_text(text_cells, preview_document, preview_output, test_root, .GlobalEnv)
  assert_done(preview_output, "true")
  preview_html <- paste(readLines(file.path(preview_output, "result.html"), warn = FALSE), collapse = "\n")
  stopifnot(grepl('id="title-block-header"', preview_html, fixed = TRUE))
  stopifnot(grepl("Horizon <em>report</em>", preview_html, fixed = TRUE))
  stopifnot(grepl('id="TOC"', preview_html, fixed = TRUE))
  stopifnot(grepl('href="#details"', preview_html, fixed = TRUE))
  stopifnot(!grepl('href="#deep-section"', preview_html, fixed = TRUE))
}

# The notebook's forced HTML format must retain YAML TOC options in R Markdown.
for (toc in c(TRUE, FALSE)) {
  outline_dir <- file.path(test_root, paste0("rmd-outline-", toc))
  dir.create(outline_dir)
  outline_document <- file.path(test_root, paste0("outline-", toc, ".Rmd"))
  writeLines(c(
    "---",
    "title: 'Notebook *report*'",
    "author: Example Author",
    "date: '2026-10-17'",
    "output:",
    "  word_document:",
    "    reference_docx: NBHReport_template.docx",
    "  html_document:",
    "    css: style.css",
    paste0("    toc: ", tolower(toc)),
    "    toc_depth: 2",
    "    number_sections: true",
    "---",
    "",
    "::: {#r-notebook-markdown-title .r-notebook-markdown-cell}",
    "VSC_R_NOTEBOOK_MARKDOWN_title",
    ":::"
  ), outline_document)
  r_notebook_render_text(
    cells_path = text_cells,
    native_document_path = outline_document,
    output_dir = outline_dir,
    working_dir = test_root,
    evaluation_env = .GlobalEnv
  )
  assert_done(outline_dir, "true")
  outline_html <- paste(readLines(file.path(outline_dir, "result.html"), warn = FALSE), collapse = "\n")
  stopifnot(grepl('class="title', outline_html, fixed = TRUE))
  stopifnot(grepl("Notebook <em>report</em>", outline_html, fixed = TRUE))
  stopifnot(grepl('class="author">Example Author', outline_html, fixed = TRUE))
  stopifnot(grepl('class="date">2026-10-17', outline_html, fixed = TRUE))
  stopifnot(identical(grepl('id="TOC"', outline_html, fixed = TRUE), toc))
  if (toc) {
    stopifnot(grepl('href="#text"', outline_html, fixed = TRUE))
    stopifnot(grepl('href="#details"', outline_html, fixed = TRUE))
    stopifnot(!grepl('href="#deep-section"', outline_html, fixed = TRUE))
    stopifnot(grepl('class="header-section-number"', outline_html, fixed = TRUE))
  }
}


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

# Fences also remain literal inside quote and list containers.
for (literal in list(
  c("> ```markdown", "> `r {r_notebook_inline_probe <- 1L; 99}`", "> ```"),
  c("> > ~~~", "> > `r {r_notebook_inline_probe <- 1L; 99}`", "> > ~~~"),
  c("- ```markdown", "  `r {r_notebook_inline_probe <- 1L; 99}`", "  ```")
)) {
  r_notebook_inline_probe <- 0L
  rendered <- r_notebook_inline_markdown(c(literal, "", "Outside `r 2 + 2`."), .GlobalEnv)
  stopifnot(identical(r_notebook_inline_probe, 0L))
  stopifnot(grepl(paste(literal, collapse = "\n"), rendered, fixed = TRUE))
  stopifnot(grepl("Outside 4.", rendered, fixed = TRUE))
}

# An unclosed fence ends with its quote container.
quoted_output <- r_notebook_inline_markdown(c(
  "> ```", "> `r stop('literal example')`", "", "Outside `r 2 + 2`."
), .GlobalEnv)
stopifnot(grepl("Outside 4.", quoted_output, fixed = TRUE))

# Indentation in a paragraph is still prose and can contain inline R.
paragraph_output <- r_notebook_inline_markdown(c(
  "A paragraph", "    with `r 2 + 2`."
), .GlobalEnv)
stopifnot(grepl("    with 4.", paragraph_output, fixed = TRUE))
