source(file.path("resources", "r", "merge_options.R"), local = TRUE)

header <- paste(
  "echo=FALSE",
  "eval=FALSE",
  "fig.cap=\"Header\"",
  "dev=c(\"png\", \"pdf\")",
  sep = ", "
)
pipe <- paste(c(
  "echo: true",
  "fig-cap: Pipe",
  "fig-dim: [7, 5]",
  "render: !expr custom_renderer()"
), collapse = "\n")

merged_pipe <- merge_r_notebook_options(header, pipe, "pipe")
stopifnot(identical(merged_pipe$headerOptions, ""))
stopifnot("eval: false" %in% strsplit(
  merged_pipe$pipeOptions,
  "\n",
  fixed = TRUE
)[[1L]])
parsed_pipe <- get("yaml_load", asNamespace("xfun"))(
  strsplit(merged_pipe$pipeOptions, "\n", fixed = TRUE)[[1L]],
  envir = FALSE
)
stopifnot(
  identical(parsed_pipe$echo, TRUE),
  identical(parsed_pipe$eval, FALSE),
  identical(parsed_pipe[["fig-cap"]], "Pipe"),
  identical(parsed_pipe[["fig-dim"]], c(7L, 5L)),
  identical(parsed_pipe[["fig-format"]], expression(c("png", "pdf"))),
  identical(parsed_pipe$render, expression(custom_renderer()))
)

merged_header <- merge_r_notebook_options(header, pipe, "header")
stopifnot(identical(merged_header$pipeOptions, ""))
parsed_header <- xfun::csv_options(merged_header$headerOptions)
stopifnot(
  identical(parsed_header$echo, TRUE),
  identical(parsed_header$fig.cap, "Pipe"),
  identical(parsed_header$fig.dim, quote(c(7L, 5L))),
  identical(parsed_header$dev, quote(c("png", "pdf"))),
  identical(parsed_header$render, quote(custom_renderer()))
)

invalid <- try(
  merge_r_notebook_options("", "- option", "header"),
  silent = TRUE
)
stopifnot(inherits(invalid, "try-error"))
