source(file.path("resources", "r", "execute.R"), local = TRUE)
stopifnot(requireNamespace("htmltools", quietly = TRUE))
stopifnot(requireNamespace("htmlwidgets", quietly = TRUE))
stopifnot(requireNamespace("plotly", quietly = TRUE))
stopifnot(requireNamespace("DT", quietly = TRUE))

test_root <- tempfile("r-notebook-test-")
dir.create(test_root)
on.exit(unlink(test_root, recursive = TRUE, force = TRUE), add = TRUE)

qmd_document <- file.path(test_root, "native.qmd")
configured_quarto <- file.path(test_root, "configured-quarto")
stopifnot(identical(
  r_notebook_quarto_executable(configured_quarto),
  configured_quarto
))
stopifnot(identical(
  r_notebook_quarto_executable(""),
  unname(Sys.which("quarto"))
))
writeLines(c(
  "---",
  "format: html",
  "execute:",
  "  warning: false",
  "---",
  ""
), qmd_document)

rmd_document <- file.path(test_root, "native.Rmd")
writeLines(c(
  "---",
  "output: html_document",
  "---",
  ""
), rmd_document)

dependency_dir <- file.path(test_root, "native-dependency")
dir.create(dependency_dir)
dependency_stylesheet <- file.path(dependency_dir, "native-dependency.css")
writeLines(c(
  ".vsc-native-dependency {",
  "  --vsc-r-notebook-native-dependency: present;",
  "}"
), dependency_stylesheet)

run_chunk <- function(
  name,
  document,
  source,
  cell_id = name,
  document_context = document,
  quarto_executable = ""
) {
  output_dir <- file.path(test_root, name)
  dir.create(output_dir)
  extension <- if (identical(tolower(tools::file_ext(document)), "qmd")) {
    ".qmd"
  } else {
    ".Rmd"
  }
  chunk_path <- file.path(output_dir, paste0("chunk", extension))
  writeLines(source, chunk_path, useBytes = TRUE)
  r_notebook_execute(
    chunk_path = chunk_path,
    document_path = document,
    native_document_path = document_context,
    document_id = document,
    cell_id = cell_id,
    cell_key = gsub("[^A-Za-z0-9_-]", "-", cell_id),
    output_dir = output_dir,
    working_dir = test_root,
    evaluation_env = .GlobalEnv,
    quarto_executable = quarto_executable
  )
  output_dir
}

output_payload <- function(output_dir, index = 1L) {
  metadata_path <- file.path(output_dir, sprintf("%06d.meta", index))
  metadata <- readLines(metadata_path, warn = FALSE)
  payload <- sub("^file: ", "", grep("^file: ", metadata, value = TRUE))
  paste(readLines(file.path(output_dir, payload), warn = FALSE), collapse = "\n")
}

cell_execution_files <- function(cell_id, pattern) {
  runtime <- getOption("vsc.r.notebook.runtime")
  cell_key <- gsub("[^A-Za-z0-9_-]", "-", cell_id)
  list.files(
    file.path(runtime$execution_dir, cell_key),
    pattern = pattern,
    recursive = TRUE,
    full.names = TRUE
  )
}

png_dimensions <- function(path) {
  connection <- file(path, "rb")
  on.exit(close(connection), add = TRUE)
  seek(connection, where = 16L, origin = "start")
  readBin(connection, integer(), n = 2L, size = 4L, endian = "big")
}

image_display_width <- function(html) {
  image <- regmatches(html, regexpr("<img[^>]*>", html, perl = TRUE))
  width <- regmatches(
    image,
    regexpr("width=\"[0-9.]+\"", image, perl = TRUE)
  )
  sub('^width="|"$', "", width)
}

rmd_without_quarto_dir <- run_chunk(
  "rmd-without-quarto",
  rmd_document,
  c(
    "```{r}",
    "#| label: fig-rmd-target",
    "#| fig-cap: Native R Markdown plot",
    "#| echo: false",
    "#| fig-width: 3",
    "#| fig-height: 2",
    "#| fig-dpi: 100",
    "#| fig-retina: 1",
    "cat('native R Markdown output\\n')",
    "plot(1:3)",
    "```"
  ),
  quarto_executable = file.path(test_root, "missing-quarto")
)
stopifnot(readLines(
  file.path(rmd_without_quarto_dir, "done"),
  warn = FALSE
) == "true")
rmd_without_quarto_html <- output_payload(rmd_without_quarto_dir)
stopifnot(grepl(
  "native R Markdown output",
  rmd_without_quarto_html,
  fixed = TRUE
))
stopifnot(!grepl(
  "## native R Markdown output",
  rmd_without_quarto_html,
  fixed = TRUE
))
stopifnot(grepl(
  "data:image/png;base64",
  rmd_without_quarto_html,
  fixed = TRUE
))
stopifnot(grepl(
  'id="fig-rmd-target"',
  rmd_without_quarto_html,
  fixed = TRUE
))
stopifnot(grepl(
  "<style>pre code{background-color:transparent}</style>",
  rmd_without_quarto_html,
  fixed = TRUE
))
stopifnot(!grepl(
  "quarto-layout",
  rmd_without_quarto_html,
  fixed = TRUE
))
stopifnot(!grepl("bs3=TRUE", rmd_without_quarto_html, fixed = TRUE))
stopifnot(!grepl(
  "padding-top: 60px",
  rmd_without_quarto_html,
  fixed = TRUE
))
rmd_without_quarto_pngs <- cell_execution_files(
  "rmd-without-quarto",
  "\\.png$"
)
stopifnot(length(rmd_without_quarto_pngs) == 1L)
stopifnot(identical(
  png_dimensions(rmd_without_quarto_pngs[[1L]]),
  c(300L, 200L)
))

rmd_explicit_comment_dir <- run_chunk(
  "rmd-explicit-comment",
  rmd_document,
  c(
    "```{r, echo=FALSE, comment='CUSTOM: '}",
    "cat('explicit R Markdown comment\\n')",
    "```"
  ),
  quarto_executable = file.path(test_root, "missing-quarto")
)
rmd_explicit_comment_html <- output_payload(rmd_explicit_comment_dir)
stopifnot(grepl(
  "CUSTOM:[[:space:]]+explicit R Markdown comment",
  rmd_explicit_comment_html,
  perl = TRUE
))

rmd_default_plot_dir <- run_chunk(
  "rmd-default-plot",
  rmd_document,
  c(
    "```{r}",
    "#| echo: false",
    "plot(1:10)",
    "```"
  ),
  quarto_executable = file.path(test_root, "missing-quarto")
)
rmd_default_plot_html <- output_payload(rmd_default_plot_dir)
rmd_default_plot_pngs <- cell_execution_files(
  "rmd-default-plot",
  "\\.png$"
)
stopifnot(length(rmd_default_plot_pngs) == 1L)

rmd_compact_data_frame_dir <- run_chunk(
  "rmd-compact-data-frame",
  rmd_document,
  c(
    "```{r, echo=FALSE}",
    "compact_rmd_value <- data.frame(",
    "  marker = sprintf('RMD-ROW-%03d', 1:120),",
    "  unsafe = rep('<RMD & value>', 120)",
    ")",
    "compact_rmd_value",
    "```"
  )
)
rmd_compact_data_frame_html <- output_payload(rmd_compact_data_frame_dir)
stopifnot(grepl(
  "class=\"vsc-r-notebook-data-frame\"",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(grepl(
  "data-vsc-r-notebook-data-frame-theme",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(grepl("RMD-ROW-010", rmd_compact_data_frame_html, fixed = TRUE))
stopifnot(!grepl("RMD-ROW-011", rmd_compact_data_frame_html, fixed = TRUE))
stopifnot(!grepl("RMD-ROW-051", rmd_compact_data_frame_html, fixed = TRUE))
stopifnot(!grepl("RMD-ROW-070", rmd_compact_data_frame_html, fixed = TRUE))
stopifnot(grepl("RMD-ROW-111", rmd_compact_data_frame_html, fixed = TRUE))
stopifnot(grepl("RMD-ROW-120", rmd_compact_data_frame_html, fixed = TRUE))
stopifnot(grepl(
  ">[[:space:]]*111[[:space:]]*</td>",
  rmd_compact_data_frame_html,
  perl = TRUE
))
stopifnot(!grepl(
  ">[[:space:]]*11[[:space:]]*</td>",
  rmd_compact_data_frame_html,
  perl = TRUE
))
stopifnot(grepl(
  "100 rows omitted",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(grepl(
  "vsc-r-notebook-data-frame-types",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(grepl(
  "&lt;char&gt;",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(grepl(
  "vsc-r-notebook-data-frame-break",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(grepl(
  paste0(
    '<tr class="vsc-r-notebook-data-frame-break">[[:space:]]*',
    '<td>[[:space:]]*<span>-</span><span>-</span><span>-</span>',
    '[[:space:]]*</td>[[:space:]]*',
    '<td>[[:space:]]*</td>[[:space:]]*',
    '<td>[[:space:]]*</td>'
  ),
  rmd_compact_data_frame_html,
  perl = TRUE
))
stopifnot(!grepl(
  "vsc-r-notebook-data-frame-break\"><td colspan",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(grepl(
  "width:auto!important;min-width:0!important",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(!grepl(
  "min-width:100%",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(grepl(
  "120 rows × 2 columns",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(grepl(
  "&lt;RMD &amp; value&gt;",
  rmd_compact_data_frame_html,
  fixed = TRUE
))
stopifnot(!grepl("<RMD & value>", rmd_compact_data_frame_html, fixed = TRUE))

stopifnot(r_notebook_compact_data_frame_source("df"))
stopifnot(r_notebook_compact_data_frame_source("(df)"))
stopifnot(r_notebook_compact_data_frame_source("View(df)"))
stopifnot(!r_notebook_compact_data_frame_source("head(df, 20)"))
stopifnot(!r_notebook_compact_data_frame_source("tail(df, 20)"))
stopifnot(!r_notebook_compact_data_frame_source("utils::head(df, 20)"))
stopifnot(!r_notebook_compact_data_frame_source("df %>% head(20)"))
stopifnot(r_notebook_compact_data_frame_source("transform(df, y = 1)"))
stopifnot(r_notebook_compact_data_frame_source("invalid("))

rmd_explicit_data_frame_rows_dir <- run_chunk(
  "rmd-explicit-data-frame-rows",
  rmd_document,
  c(
    "```{r, echo=FALSE}",
    "explicit_rows <- data.frame(",
    "  head_marker = sprintf('HEAD-ROW-%03d', 1:40),",
    "  tail_marker = sprintf('TAIL-ROW-%03d', 1:40)",
    ")",
    "head(explicit_rows, 30)",
    "tail(explicit_rows, 30)",
    "```"
  )
)
rmd_explicit_data_frame_rows_html <- output_payload(
  rmd_explicit_data_frame_rows_dir
)
stopifnot(grepl(
  "class=\"vsc-r-notebook-data-frame\"",
  rmd_explicit_data_frame_rows_html,
  fixed = TRUE
))
stopifnot(grepl(
  "HEAD-ROW-011",
  rmd_explicit_data_frame_rows_html,
  fixed = TRUE
))
stopifnot(grepl(
  "TAIL-ROW-021",
  rmd_explicit_data_frame_rows_html,
  fixed = TRUE
))
stopifnot(!grepl(
  '<tr class="vsc-r-notebook-data-frame-break">',
  rmd_explicit_data_frame_rows_html,
  fixed = TRUE
))

stopifnot(identical(
  base::unname(base::vapply(
    list(
      integer = 1L,
      numeric = 1.5,
      character = "a",
      logical = TRUE,
      factor = factor("a"),
      ordered = ordered("a"),
      date = as.Date("2020-01-01"),
      idate = structure(1L, class = c("IDate", "Date")),
      integer64 = structure(1, class = "integer64"),
      expression = expression(x)
    ),
    r_notebook_data_frame_type,
    character(1L)
  )),
  c(
    "int", "num", "char", "lgcl", "fctr", "ord", "Date", "IDat", "i64",
    "expr"
  )
))

rmd_tabular_classes_dir <- run_chunk(
  "rmd-tabular-classes",
  rmd_document,
  c(
    "```{r, echo=FALSE}",
    "styled_data_table <- data.frame(",
    "  marker = sprintf('DT-ROW-%03d', 1:40), value = 1:40",
    ")",
    "if (requireNamespace('data.table', quietly = TRUE)) {",
    "  data.table::setDT(styled_data_table)",
    "} else class(styled_data_table) <- c('data.table', 'data.frame')",
    "styled_tibble <- data.frame(",
    "  marker = sprintf('TBL-ROW-%03d', 1:40), value = 1:40",
    ")",
    "if (requireNamespace('dplyr', quietly = TRUE)) {",
    "  styled_tibble <- dplyr::as_tibble(styled_tibble)",
    "} else class(styled_tibble) <- c('tbl_df', 'tbl', 'data.frame')",
    "styled_data_table",
    "styled_tibble",
    "```"
  )
)
rmd_tabular_classes_html <- output_payload(rmd_tabular_classes_dir)
for (marker in c(
  "DT-ROW-010",
  "DT-ROW-031",
  "TBL-ROW-010",
  "TBL-ROW-031"
)) {
  stopifnot(grepl(marker, rmd_tabular_classes_html, fixed = TRUE))
}
stopifnot(!grepl("DT-ROW-011", rmd_tabular_classes_html, fixed = TRUE))
stopifnot(!grepl("TBL-ROW-011", rmd_tabular_classes_html, fixed = TRUE))
stopifnot(lengths(regmatches(
  rmd_tabular_classes_html,
  gregexpr(
    'class="vsc-r-notebook-data-frame"',
    rmd_tabular_classes_html,
    fixed = TRUE
  )
)) == 2L)

previous_integration_flag <- base::Sys.getenv(
  "VSCODE_R_NOTEBOOK_R_EXTENSION_INTEGRATION",
  unset = NA_character_
)
base::Sys.setenv(VSCODE_R_NOTEBOOK_R_EXTENSION_INTEGRATION = "0")
rmd_inline_view_dir <- run_chunk(
  "rmd-inline-view",
  rmd_document,
  c(
    "```{r, echo=FALSE}",
    "fallback_view_value <- data.frame(",
    "  marker = sprintf('VIEW-ROW-%03d', 1:40),",
    "  value = 1:40",
    ")",
    "View(fallback_view_value)",
    "```"
  )
)
if (base::is.na(previous_integration_flag)) {
  base::Sys.unsetenv("VSCODE_R_NOTEBOOK_R_EXTENSION_INTEGRATION")
} else {
  base::Sys.setenv(
    VSCODE_R_NOTEBOOK_R_EXTENSION_INTEGRATION = previous_integration_flag
  )
}
rmd_inline_view_html <- output_payload(rmd_inline_view_dir)
stopifnot(grepl(
  "class=\"vsc-r-notebook-data-frame\"",
  rmd_inline_view_html,
  fixed = TRUE
))
stopifnot(grepl("VIEW-ROW-010", rmd_inline_view_html, fixed = TRUE))
stopifnot(!grepl("VIEW-ROW-011", rmd_inline_view_html, fixed = TRUE))
stopifnot(grepl("VIEW-ROW-031", rmd_inline_view_html, fixed = TRUE))
stopifnot(grepl("VIEW-ROW-040", rmd_inline_view_html, fixed = TRUE))
stopifnot(grepl("20 rows omitted", rmd_inline_view_html, fixed = TRUE))
stopifnot(grepl("&lt;int&gt;", rmd_inline_view_html, fixed = TRUE))
stopifnot(!base::exists("View", envir = .GlobalEnv, inherits = FALSE))

knit_engines_before_execution <- knitr::knit_engines$get()
inline_renderer_before_execution <- function(value) value
assign(
  ".QuartoInlineRender",
  inline_renderer_before_execution,
  envir = .GlobalEnv
)
basic_dir <- run_chunk("basic", qmd_document, c(
  "```{r}",
  "#| echo: false",
  "#| fig-format: png",
  "#| fig-width: 4",
  "#| fig-height: 3",
  "#| fig-dpi: 72",
  "#| warning: true",
  "shared_notebook_value <- data.frame(x = 1:2, label = c('one', 'two'))",
  "cat('inline text\\n')",
  "shared_notebook_value",
  "warning('inline warning')",
  "plot(1:3, 3:1)",
  "```"
))
stopifnot(readLines(file.path(basic_dir, "done"), warn = FALSE) == "true")
stopifnot(length(list.files(basic_dir, pattern = "^[0-9]{6}\\.meta$")) == 1L)
basic_html <- output_payload(basic_dir)
stopifnot(grepl("inline text", basic_html, fixed = TRUE))
stopifnot(grepl("inline warning", basic_html, fixed = TRUE))
stopifnot(grepl("one", basic_html, fixed = TRUE))
stopifnot(grepl(
  "class=\"vsc-r-notebook-data-frame\"",
  basic_html,
  fixed = TRUE
))
stopifnot(grepl("data:image/png;base64", basic_html, fixed = TRUE))
stopifnot(grepl(
  "--vsc-r-notebook-plot-width:4in",
  basic_html,
  fixed = TRUE
))
stopifnot(grepl(
  "width:var(--vsc-r-notebook-plot-width);max-width:100%;height:auto",
  basic_html,
  fixed = TRUE
))

qmd_default_plot_dir <- run_chunk(
  "qmd-default-plot",
  qmd_document,
  c(
    "```{r}",
    "#| echo: false",
    "plot(1:10)",
    "```"
  )
)
qmd_default_plot_html <- output_payload(qmd_default_plot_dir)
qmd_default_plot_pngs <- cell_execution_files(
  "qmd-default-plot",
  "\\.png$"
)
stopifnot(length(qmd_default_plot_pngs) == 1L)
stopifnot(identical(
  png_dimensions(rmd_default_plot_pngs[[1L]]),
  png_dimensions(qmd_default_plot_pngs[[1L]])
))
stopifnot(identical(
  image_display_width(rmd_default_plot_html),
  image_display_width(qmd_default_plot_html)
))

qmd_matched_plot_dir <- run_chunk(
  "qmd-matched-plot",
  qmd_document,
  c(
    "```{r}",
    "#| echo: false",
    "#| fig-width: 3",
    "#| fig-height: 2",
    "#| fig-dpi: 100",
    "#| fig-retina: 1",
    "plot(1:3)",
    "```"
  )
)
qmd_matched_plot_html <- output_payload(qmd_matched_plot_dir)
qmd_matched_plot_pngs <- cell_execution_files(
  "qmd-matched-plot",
  "\\.png$"
)
stopifnot(length(qmd_matched_plot_pngs) == 1L)
stopifnot(identical(
  png_dimensions(rmd_without_quarto_pngs[[1L]]),
  png_dimensions(qmd_matched_plot_pngs[[1L]])
))
stopifnot(identical(
  image_display_width(rmd_without_quarto_html),
  image_display_width(qmd_matched_plot_html)
))

leading_options_dir <- run_chunk("leading-options", qmd_document, c(
  "```{r}",
  "",
  "#| echo: false",
  "#| warning: false",
  "#| message: false",
  "message('hidden leading-option message')",
  "warning('hidden leading-option warning')",
  "1 + 1",
  "```"
))
leading_options_html <- output_payload(leading_options_dir)
stopifnot(!grepl("hidden leading-option message", leading_options_html, fixed = TRUE))
stopifnot(!grepl("hidden leading-option warning", leading_options_html, fixed = TRUE))
stopifnot(exists("shared_notebook_value", envir = .GlobalEnv, inherits = FALSE))
stopifnot(identical(
  get(".QuartoInlineRender", envir = .GlobalEnv, inherits = FALSE),
  inline_renderer_before_execution
))
stopifnot(identical(knitr::knit_engines$get(), knit_engines_before_execution))
rm(".QuartoInlineRender", envir = .GlobalEnv)

plain_dir <- run_chunk("plain", qmd_document, c(
  "```{r}",
  "a <- 10",
  "a",
  "```"
))
plain_html <- output_payload(plain_dir)
stopifnot(grepl("[1] 10", plain_html, fixed = TRUE))
stopifnot(grepl(
  ".cell-output-stdout pre code,.cell-output-stderr pre code{background-color:transparent}",
  plain_html,
  fixed = TRUE
))
stopifnot(grepl(
  "name=\"generator\" content=\"pandoc\"",
  plain_html,
  fixed = TRUE
))
stopifnot(!grepl("color: #1a1a1a", plain_html, fixed = TRUE))
stopifnot(!grepl("a &lt;- 10", plain_html, fixed = TRUE))

native_plot_size_dir <- run_chunk("native-plot-size", qmd_document, c(
  "```{r}",
  "#| echo: false",
  "#| fig-width: 5",
  "#| fig-dpi: 300",
  "#| out-width: 50%",
  "plot(1:10)",
  "```"
))
native_plot_size_html <- output_payload(native_plot_size_dir)
stopifnot(!grepl(
  "style=\"--vsc-r-notebook-plot-width:",
  native_plot_size_html,
  fixed = TRUE
))
stopifnot(grepl("style=\"width:50.0%\"", native_plot_size_html, fixed = TRUE))

cached_quarto_context <- getOption("vsc.r.notebook.runtime")$quarto_context

precedence_dir <- run_chunk("precedence", qmd_document, c(
  "```{r, warning=FALSE}",
  "#| echo: false",
  "#| warning: true",
  "warning('pipe option wins')",
  "```"
))
stopifnot(grepl("pipe option wins", output_payload(precedence_dir), fixed = TRUE))
stopifnot(!exists(".QuartoInlineRender", envir = .GlobalEnv, inherits = FALSE))
stopifnot(identical(
  getOption("vsc.r.notebook.runtime")$quarto_context,
  cached_quarto_context
))

alignment_dir <- run_chunk("alignment", qmd_document, c(
  "```{r}",
  "#| echo: false",
  "#| fig-align: center",
  "plot(1:3)",
  "```"
))
alignment_html <- output_payload(alignment_dir)
stopifnot(grepl("quarto-figure-center", alignment_html, fixed = TRUE))
stopifnot(grepl(
  ".quarto-figure-center>figure>p",
  alignment_html,
  fixed = TRUE
))

layout_dir <- run_chunk("layout", qmd_document, c(
  "```{r}",
  "#| echo: false",
  "#| fig-format: png",
  "#| fig-width: !expr 1 + 2",
  "#| fig-height: 2",
  "#| fig-dpi: 300",
  "#| fig-retina: 1",
  "#| layout: [[45, -10, 45], [100]]",
  "plot(1:3)",
  "plot(3:1)",
  "plot(2:4)",
  "```"
))
layout_html <- output_payload(layout_dir)
stopifnot(grepl("quarto-layout-row", layout_html, fixed = TRUE))
stopifnot(grepl("quarto-figure-spacer", layout_html, fixed = TRUE))
stopifnot(grepl(
  ".quarto-layout-row{display:flex",
  layout_html,
  fixed = TRUE
))
stopifnot(grepl(
  ".quarto-layout-cell img{max-width:100%",
  layout_html,
  fixed = TRUE
))
stopifnot(grepl(
  ".quarto-layout-cell img{width:100%;height:auto}",
  layout_html,
  fixed = TRUE
))
stopifnot(grepl(
  "style=\"--vsc-r-notebook-plot-width:3in\"",
  layout_html,
  fixed = TRUE
))
stopifnot(grepl(
  ".cell[style*=\"--vsc-r-notebook-plot-width\"] .quarto-layout-row{width:var(--vsc-r-notebook-plot-width);max-width:100%}",
  layout_html,
  fixed = TRUE
))
stopifnot(grepl(
  "style=\"flex-basis: 100.0%;justify-content: center;\"",
  layout_html,
  fixed = TRUE
))
stopifnot(!grepl("data:text/css", layout_html, fixed = TRUE))
layout_pngs <- cell_execution_files("layout", "\\.png$")
stopifnot(length(layout_pngs) == 3L)
stopifnot(all(vapply(layout_pngs, function(path) {
  identical(png_dimensions(path), c(900L, 600L))
}, logical(1))))

rmd_layout_dir <- run_chunk("rmd-layout", rmd_document, c(
  "```{r}",
  "#| echo: false",
  "#| fig-width: 3",
  "#| fig-height: 2",
  "#| fig-dpi: 100",
  "#| fig-retina: 1",
  "#| layout: [[45, -10, 45], [100]]",
  "plot(1:3)",
  "plot(3:1)",
  "plot(2:4)",
  "```"
))
rmd_layout_html <- output_payload(rmd_layout_dir)
stopifnot(!grepl("container-fluid main-container", rmd_layout_html, fixed = TRUE))
stopifnot(!grepl("bs3=TRUE", rmd_layout_html, fixed = TRUE))
stopifnot(length(gregexpr(
  "data:image/png;base64",
  rmd_layout_html,
  fixed = TRUE
)[[1L]]) == 3L)
rmd_layout_pngs <- cell_execution_files("rmd-layout", "\\.png$")
stopifnot(length(rmd_layout_pngs) == 3L)
stopifnot(all(vapply(rmd_layout_pngs, function(path) {
  identical(png_dimensions(path), c(300L, 200L))
}, logical(1))))

qmd_source_dir <- run_chunk("qmd-source", qmd_document, c(
  "```{r}",
  "qmd_source_result <- 42L",
  "qmd_source_result",
  "```"
))
qmd_source_html <- output_payload(qmd_source_dir)
stopifnot(!grepl("qmd_source_result", qmd_source_html, fixed = TRUE))
stopifnot(grepl("42", qmd_source_html, fixed = TRUE))

rmd_source_dir <- run_chunk("rmd-source", rmd_document, c(
  "```{r}",
  "rmd_source_result <- 43L",
  "rmd_source_result",
  "```"
))
rmd_source_html <- output_payload(rmd_source_dir)
stopifnot(!grepl("rmd_source_result", rmd_source_html, fixed = TRUE))
stopifnot(grepl("43", rmd_source_html, fixed = TRUE))

setup_dir <- run_chunk("setup", qmd_document, c(
  "```{r}",
  "#| include: false",
  "knitr::opts_chunk$set(comment = '@@', echo = FALSE)",
  "knitr::opts_knit$set('native-session-option' = 'persisted')",
  "knitr::opts_hooks$set('native-option' = function(options) {",
  "  if (isTRUE(options[['native-option']])) options$comment <- 'NATIVE:'",
  "  options",
  "})",
  "knitr::knit_hooks$set(chunk = function(output, options) {",
  "  if (identical(options$label, 'hook-target')) paste0(output, 'NATIVE-CHUNK-HOOK') else output",
  "})",
  "```"
))
stopifnot(readLines(file.path(setup_dir, "done"), warn = FALSE) == "true")
stopifnot(length(list.files(setup_dir, pattern = "^[0-9]{6}\\.meta$")) == 0L)

native_option_dir <- run_chunk("native-option", qmd_document, c(
  "```{r}",
  "#| native-option: true",
  "c(knitr::opts_knit$get('native-session-option'), 1 + 1)",
  "```"
))
stopifnot(grepl("NATIVE:.*2", output_payload(native_option_dir)))
stopifnot(grepl("persisted", output_payload(native_option_dir), fixed = TRUE))

native_hook_dir <- run_chunk("native-hook", qmd_document, c(
  "```{r}",
  "#| label: hook-target",
  "1 + 1",
  "```"
))
stopifnot(grepl("NATIVE-CHUNK-HOOK", output_payload(native_hook_dir), fixed = TRUE))

pre_evaluation_setup <- run_chunk("pre-evaluation-setup", qmd_document, c(
  "```{r}",
  "#| include: false",
  "knitr::opts_hooks$set('pre-evaluation-change' = function(options) {",
  "  knitr::opts_chunk$set(comment = 'PRE-EVALUATION:')",
  "  options",
  "})",
  "```"
))
stopifnot(readLines(file.path(pre_evaluation_setup, "done"), warn = FALSE) == "true")
run_chunk("pre-evaluation-target", qmd_document, c(
  "```{r}",
  "#| pre-evaluation-change: true",
  "1 + 1",
  "```"
))
pre_evaluation_followup <- run_chunk("pre-evaluation-followup", qmd_document, c(
  "```{r}",
  "1 + 2",
  "```"
))
stopifnot(grepl("PRE-EVALUATION:.*3", output_payload(pre_evaluation_followup)))

hidden_dir <- run_chunk("hidden", qmd_document, c(
  "```{r}",
  "#| echo: false",
  "#| output: false",
  "cat('must not be displayed')",
  "plot(1:3)",
  "```"
))
stopifnot(readLines(file.path(hidden_dir, "done"), warn = FALSE) == "true")
hidden_metadata <- list.files(hidden_dir, pattern = "^[0-9]{6}\\.meta$")
if (length(hidden_metadata) > 0L) {
  hidden_html <- output_payload(hidden_dir)
  stopifnot(!grepl("must not be displayed", hidden_html, fixed = TRUE))
  stopifnot(!grepl("data:image", hidden_html, fixed = TRUE))
}

reference_source_dir <- run_chunk("reference-source", rmd_document, c(
  "```{r native-reference, include=FALSE}",
  "native_reference_runs <- get0('native_reference_runs', ifnotfound = 0L) + 1L",
  "```"
))
stopifnot(readLines(file.path(reference_source_dir, "done"), warn = FALSE) == "true")

reference_dir <- run_chunk("reference", rmd_document, c(
  "```{r, ref.label='native-reference', echo=FALSE}",
  "```"
))
stopifnot(readLines(file.path(reference_dir, "done"), warn = FALSE) == "true")
stopifnot(identical(native_reference_runs, 2L))

explicit_unnamed_source <- run_chunk("explicit-unnamed-source", rmd_document, c(
  "```{r unnamed-chunk-1, include=FALSE}",
  "explicit_unnamed_runs <- get0('explicit_unnamed_runs', ifnotfound = 0L) + 1L",
  "```"
))
stopifnot(readLines(file.path(explicit_unnamed_source, "done"), warn = FALSE) == "true")
explicit_unnamed_reference <- run_chunk("explicit-unnamed-reference", rmd_document, c(
  "```{r, ref.label='unnamed-chunk-1', echo=FALSE}",
  "```"
))
stopifnot(readLines(file.path(explicit_unnamed_reference, "done"), warn = FALSE) == "true")
stopifnot(identical(explicit_unnamed_runs, 2L))

rmd_figure_dir <- run_chunk("rmd-figure", rmd_document, c(
  "```{r native-expression, echo=FALSE, fig.width=1+2, fig.height=2, dpi=100, dev='png', fig.retina=1, fig.keep='last'}",
  "plot(1:3)",
  "plot(3:1)",
  "```"
))
rmd_pngs <- cell_execution_files("rmd-figure", "\\.png$")
stopifnot(length(rmd_pngs) == 1L)
stopifnot(identical(png_dimensions(rmd_pngs[[1]]), c(300L, 200L)))

svg_dir <- run_chunk("svg-device", rmd_document, c(
  "```{r native-svg, echo=FALSE, dev='svg', fig.keep='first'}",
  "plot(1:3)",
  "plot(3:1)",
  "```"
))
svg_files <- cell_execution_files("svg-device", "\\.svg$")
stopifnot(length(svg_files) == 1L)
stopifnot(grepl("data:image/svg+xml", output_payload(svg_dir), fixed = TRUE))

continued_error_dir <- run_chunk("continued-error", qmd_document, c(
  "```{r}",
  "#| echo: false",
  "#| error: true",
  "stop('displayed native error')",
  "cat('execution continued\\n')",
  "```"
))
stopifnot(readLines(file.path(continued_error_dir, "done"), warn = FALSE) == "true")
continued_error_html <- output_payload(continued_error_dir)
stopifnot(grepl("displayed native error", continued_error_html, fixed = TRUE))
stopifnot(grepl("execution continued", continued_error_html, fixed = TRUE))

eval_dir <- run_chunk("eval-false", rmd_document, c(
  "```{r, eval=FALSE, echo=FALSE}",
  "native_eval_false_value <- 99",
  "```"
))
stopifnot(readLines(file.path(eval_dir, "done"), warn = FALSE) == "true")
stopifnot(!exists("native_eval_false_value", envir = .GlobalEnv, inherits = FALSE))
stopifnot(length(list.files(eval_dir, pattern = "^[0-9]{6}\\.meta$")) == 0L)

error_dir <- run_chunk("error", rmd_document, c(
  "```{r, error=FALSE, echo=FALSE}",
  "stop('expected cell error')",
  "```"
))
stopifnot(readLines(file.path(error_dir, "done"), warn = FALSE) == "false")
error_metadata <- readLines(file.path(error_dir, "000001.meta"), warn = FALSE)
stopifnot(any(error_metadata == "kind: error"))

params_document <- file.path(test_root, "params.qmd")
writeLines(c(
  "---",
  "format: html",
  "params:",
  "  native_value: 73",
  "---",
  ""
), params_document)
params_dir <- run_chunk("params", params_document, c(
  "```{r}",
  "#| echo: false",
  "params$native_value",
  "```"
))
stopifnot(grepl("73", output_payload(params_dir), fixed = TRUE))

unsaved_document <- file.path(test_root, "unsaved.qmd")
writeLines(c(
  "---",
  "format: html",
  "execute:",
  "  warning: true",
  "---",
  ""
), unsaved_document)
unsaved_context <- file.path(test_root, "unsaved-context.qmd")
writeLines(c(
  "---",
  "format: html",
  "execute:",
  "  warning: false",
  "---",
  ""
), unsaved_context)
unsaved_dir <- run_chunk(
  "unsaved",
  unsaved_document,
  c(
    "```{r}",
    "#| echo: false",
    "cat('current document context')",
    "warning('stale document context')",
    "```"
  ),
  document_context = unsaved_context
)
unsaved_html <- output_payload(unsaved_dir)
stopifnot(grepl("current document context", unsaved_html, fixed = TRUE))
stopifnot(!grepl("stale document context", unsaved_html, fixed = TRUE))

multi_device_document <- file.path(test_root, "multi-device.qmd")
writeLines(c(
  "---",
  "format: html",
  "knitr:",
  "  opts_chunk:",
  "    dev: [png, svg]",
  "---",
  ""
), multi_device_document)
multi_device_dir <- run_chunk("multi-device", multi_device_document, c(
  "```{r}",
  "#| echo: false",
  "plot(1:3)",
  "```"
))
stopifnot(readLines(file.path(multi_device_dir, "done"), warn = FALSE) == "true")
stopifnot(length(cell_execution_files("multi-device", "\\.png$")) == 1L)
stopifnot(length(cell_execution_files("multi-device", "\\.svg$")) == 1L)

cache_document <- file.path(test_root, "cache.qmd")
writeLines(c(
  "---",
  "format: html",
  "---",
  ""
), cache_document)
cache_source <- c(
  "```{r}",
  "#| cache: true",
  "#| echo: false",
  "native_cache_runs <- get0('native_cache_runs', ifnotfound = 0L) + 1L",
  "native_cache_runs",
  "```"
)
cache_first_dir <- run_chunk(
  "cache-first",
  cache_document,
  cache_source,
  cell_id = "cache-cell"
)
cache_second_dir <- run_chunk(
  "cache-second",
  cache_document,
  cache_source,
  cell_id = "cache-cell"
)
stopifnot(readLines(file.path(cache_first_dir, "done"), warn = FALSE) == "true")
stopifnot(readLines(file.path(cache_second_dir, "done"), warn = FALSE) == "true")
stopifnot(identical(native_cache_runs, 1L))
stopifnot(length(cell_execution_files("cache-cell", "\\.RData$")) == 1L)

repeat_document <- file.path(test_root, "repeat.Rmd")
writeLines(c(
  "---",
  "output: html_document",
  "---",
  ""
), repeat_document)
repeat_first <- run_chunk("repeat-first", repeat_document, c(
  "```{r repeated-source, include=FALSE}",
  "repeated_source_value <- 1L",
  "```"
), cell_id = "repeated-cell")
stopifnot(readLines(file.path(repeat_first, "done"), warn = FALSE) == "true")
repeat_second <- run_chunk("repeat-second", repeat_document, c(
  "```{r repeated-source, include=FALSE}",
  "repeated_source_value <- 2L",
  "```"
), cell_id = "repeated-cell")
stopifnot(readLines(file.path(repeat_second, "done"), warn = FALSE) == "true")
repeat_reference <- run_chunk("repeat-reference", repeat_document, c(
  "```{r, ref.label='repeated-source', echo=FALSE}",
  "```"
))
stopifnot(readLines(file.path(repeat_reference, "done"), warn = FALSE) == "true")
stopifnot(identical(repeated_source_value, 2L))

word_document <- file.path(test_root, "word-output.Rmd")
writeLines(c(
  "---",
  "output: word_document",
  "---",
  ""
), word_document)
word_output_dir <- run_chunk("word-output", word_document, c(
  "```{r, echo=FALSE}",
  "data.frame(native_column = 1:3)",
  "```"
))
word_output_html <- output_payload(word_output_dir)
stopifnot(grepl("native_column", word_output_html, fixed = TRUE))
stopifnot(length(cell_execution_files("word-output", "\\.docx$")) == 0L)

filter_path <- file.path(test_root, "native-filter.lua")
writeLines(c(
  "function CodeBlock(block)",
  "  block.text = string.gsub(block.text, 'before%-native%-filter', 'after-native-filter')",
  "  return block",
  "end"
), filter_path)
filter_document <- file.path(test_root, "filter.qmd")
writeLines(c(
  "---",
  "format: html",
  "filters: [native-filter.lua]",
  "---",
  ""
), filter_document)
filter_dir <- run_chunk("filter", filter_document, c(
  "```{r}",
  "#| echo: false",
  "cat('before-native-filter')",
  "```"
))
filter_html <- output_payload(filter_dir)
stopifnot(grepl("after-native-filter", filter_html, fixed = TRUE))
stopifnot(!grepl("before-native-filter", filter_html, fixed = TRUE))

project_dir <- file.path(test_root, "native-project")
project_document_dir <- file.path(project_dir, "documents")
dir.create(project_document_dir, recursive = TRUE)
writeLines(c(
  "project:",
  "  type: default",
  "format: html",
  "filters: [project-filter.lua]"
), file.path(project_dir, "_quarto.yml"))
writeLines(c(
  "function CodeBlock(block)",
  "  block.text = string.gsub(block.text, 'before%-project%-filter', 'after-project-filter')",
  "  return block",
  "end"
), file.path(project_dir, "project-filter.lua"))
project_filter_document <- file.path(project_document_dir, "nested.qmd")
writeLines("", project_filter_document)
project_filter_dir <- run_chunk(
  "project-filter",
  project_filter_document,
  c(
    "```{r}",
    "#| echo: false",
    "cat('before-project-filter')",
    "```"
  )
)
project_filter_html <- output_payload(project_filter_dir)
stopifnot(grepl("after-project-filter", project_filter_html, fixed = TRUE))
stopifnot(!grepl("before-project-filter", project_filter_html, fixed = TRUE))

rmd_filter_document <- file.path(test_root, "filter.Rmd")
writeLines(c(
  "---",
  "output:",
  "  html_document:",
  "    pandoc_args:",
  "      - --lua-filter=native-filter.lua",
  "---",
  ""
), rmd_filter_document)
rmd_filter_dir <- run_chunk("rmd-filter", rmd_filter_document, c(
  "```{r, echo=FALSE, dev='png'}",
  "cat('before-native-filter')",
  "plot(1:3)",
  "```"
))
rmd_filter_html <- output_payload(rmd_filter_dir)
stopifnot(grepl("before-native-filter", rmd_filter_html, fixed = TRUE))
stopifnot(!grepl("after-native-filter", rmd_filter_html, fixed = TRUE))
stopifnot(grepl("data:image/png;base64", rmd_filter_html, fixed = TRUE))

qmd_asis_dir <- run_chunk("qmd-asis", params_document, c(
  "```{r}",
  "#| echo: false",
  "#| output: asis",
  "cat('---\\nQMD-INNER-MARKER\\n---\\nQMD-VISIBLE\\n')",
  "```"
))
qmd_asis_html <- output_payload(qmd_asis_dir)
stopifnot(grepl("QMD-INNER-MARKER", qmd_asis_html, fixed = TRUE))
stopifnot(grepl("QMD-VISIBLE", qmd_asis_html, fixed = TRUE))

rmd_asis_dir <- run_chunk("rmd-asis", repeat_document, c(
  "```{r, echo=FALSE, results='asis'}",
  "cat('---\\nRMD-INNER-MARKER\\n---\\nRMD-VISIBLE\\n')",
  "```"
))
rmd_asis_html <- output_payload(rmd_asis_dir)
stopifnot(grepl("RMD-INNER-MARKER", rmd_asis_html, fixed = TRUE))
stopifnot(grepl("RMD-VISIBLE", rmd_asis_html, fixed = TRUE))

qmd_dependency_dir <- run_chunk("qmd-dependency", params_document, c(
  "```{r}",
  "#| echo: false",
  "htmltools::browsable(htmltools::attachDependencies(",
  "  htmltools::tags$span(class = 'vsc-native-dependency', 'QMD-DEPENDENCY-BODY'),",
  "  htmltools::htmlDependency(",
  "    name = 'qmd-native-dependency',",
  "    version = '1.0.0',",
  "    src = c(file = dependency_dir),",
  "    stylesheet = 'native-dependency.css',",
  "    all_files = FALSE",
  "  )",
  "))",
  "```"
))
qmd_dependency_html <- output_payload(qmd_dependency_dir)
stopifnot(grepl("QMD-DEPENDENCY-BODY", qmd_dependency_html, fixed = TRUE))
stopifnot(grepl(
  "--vsc-r-notebook-native-dependency: present",
  qmd_dependency_html,
  fixed = TRUE
))

rmd_dependency_dir <- run_chunk("rmd-dependency", rmd_document, c(
  "```{r, echo=FALSE}",
  "htmltools::browsable(htmltools::attachDependencies(",
  "  htmltools::tags$span(class = 'vsc-native-dependency', 'RMD-DEPENDENCY-BODY'),",
  "  htmltools::htmlDependency(",
  "    name = 'rmd-native-dependency',",
  "    version = '1.0.0',",
  "    src = c(file = dependency_dir),",
  "    stylesheet = 'native-dependency.css',",
  "    all_files = FALSE",
  "  )",
  "))",
  "```"
))
rmd_dependency_html <- output_payload(rmd_dependency_dir)
stopifnot(grepl("RMD-DEPENDENCY-BODY", rmd_dependency_html, fixed = TRUE))
stopifnot(grepl(
  "--vsc-r-notebook-native-dependency: present",
  rmd_dependency_html,
  fixed = TRUE
))

widget_dir <- run_chunk("widget", params_document, c(
  "```{r}",
  "#| echo: false",
  "plotly::plot_ly(x = 1:3, y = 3:1)",
  "```"
))
widget_metadata <- readLines(file.path(widget_dir, "000001.meta"), warn = FALSE)
stopifnot(any(widget_metadata == "mime: text/html"))
widget_html <- output_payload(widget_dir)
stopifnot(grepl("<head", widget_html, fixed = TRUE))
stopifnot(grepl("HTMLWidgets.staticRender", widget_html, fixed = TRUE))
stopifnot(grepl(
  "data-vsc-r-notebook-htmlwidgets",
  widget_html,
  fixed = TRUE
))
stopifnot(!grepl(
  "data-vsc-r-notebook-dt-theme",
  widget_html,
  fixed = TRUE
))
stopifnot(
  regexpr(
    "data-vsc-r-notebook-htmlwidgets",
    widget_html,
    fixed = TRUE
  )[[1L]] > regexpr("data-for=\"htmlwidget-", widget_html, fixed = TRUE)[[1L]]
)

dt_dir <- run_chunk("dt-widget", params_document, c(
  "```{r}",
  "#| echo: false",
  "DT::datatable(head(iris), options = list(pageLength = 3))",
  "```"
))
dt_html <- output_payload(dt_dir)
stopifnot(grepl("datatables", dt_html, ignore.case = TRUE))
stopifnot(grepl("data-for=\"htmlwidget-", dt_html, fixed = TRUE))
stopifnot(grepl(
  "data-vsc-r-notebook-htmlwidgets",
  dt_html,
  fixed = TRUE
))
stopifnot(grepl(
  "data-vsc-r-notebook-dt-theme",
  dt_html,
  fixed = TRUE
))
stopifnot(grepl(
  "div.datatables{color:var(--vscode-editor-foreground)}",
  dt_html,
  fixed = TRUE
))
stopifnot(grepl(
  "color:var(--vscode-editor-foreground)",
  dt_html,
  fixed = TRUE
))
native_dt_color <- regexpr("div.datatables", dt_html, fixed = TRUE)[[1L]]
notebook_dt_color <- regexpr(
  "data-vsc-r-notebook-dt-theme",
  dt_html,
  fixed = TRUE
)[[1L]]
stopifnot(native_dt_color > 0L)
stopifnot(notebook_dt_color > native_dt_color)

rmd_dt_dir <- run_chunk("rmd-dt-widget", rmd_document, c(
  "```{r, echo=FALSE}",
  "DT::datatable(head(iris), options = list(pageLength = 3))",
  "```"
))
rmd_dt_html <- output_payload(rmd_dt_dir)
stopifnot(grepl("datatables", rmd_dt_html, ignore.case = TRUE))
stopifnot(grepl(
  "data-vsc-r-notebook-htmlwidgets",
  rmd_dt_html,
  fixed = TRUE
))
stopifnot(grepl(
  "data-vsc-r-notebook-dt-theme",
  rmd_dt_html,
  fixed = TRUE
))
