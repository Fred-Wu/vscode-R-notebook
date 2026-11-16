source(file.path("resources", "r", "execute.R"), local = TRUE)
r_notebook_load(file.path("resources", "r"))
r_notebook_math_assets <- normalizePath(file.path("dist", "katex"), winslash = "/", mustWork = TRUE)
stopifnot(requireNamespace("litedown", quietly = TRUE))
stopifnot(requireNamespace("rbibutils", quietly = TRUE))

# Both complete notebook paths must work without loading rmarkdown or locating Pandoc.
trace(base::loadNamespace, tracer = quote({
  if (identical(package, "rmarkdown") || identical(package, "bookdown")) {
    stop("Unexpected publishing dependency: ", package)
  }
}), print = FALSE)

run_tests <- function(extension) {
  quarto <- identical(extension, "qmd")
  format <- if (quarto) r_notebook_quarto else r_notebook_rmd
  root <- tempfile("r-notebook-litedown-test & ")
  dir.create(root)
  on.exit(unlink(root, recursive = TRUE), add = TRUE)
  document <- file.path(root, paste0("notebook.", extension))
  writeLines(c("---", if (quarto) "format: html" else "output: html_document", "params:", "  value: 42", "---"), document)
  env <- new.env(parent = globalenv())
  run <- function(id, code, header = "") {
    directory <- file.path(root, id)
    dir.create(directory, showWarnings = FALSE)
    chunk <- file.path(directory, "chunk.Rmd")
    writeLines(c(paste0("```{r", header, "}"), code, "```"), chunk)
    r_notebook_execute(chunk, document, document, document, id, id, directory, root, env)
    files <- list.files(directory, "^[0-9]+\\.meta$", full.names = TRUE)
    output <- paste(vapply(files, function(file) {
      payload <- sub("^file: ", "", grep("^file: ", readLines(file), value = TRUE))
      connection <- file(file.path(directory, payload), open = "rb")
      on.exit(close(connection))
      paste(readLines(connection, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
    }, character(1)), collapse = "\n")
    list(success = identical(readLines(file.path(directory, "done")), "true"), html = output)
  }
  setup <- run("setup", c("x <- params$value", "knitr::opts_chunk$set(warning=FALSE, comment='PREFIX')"))
  stopifnot(setup$success, identical(env$x, 42L), !exists("params", env, inherits = FALSE))
  result <- run("result", c("x + 1", "warning('hidden warning')", "message('visible message')"))
  stopifnot(result$success, grepl("43", result$html), grepl("PREFIX", result$html),
    !grepl("hidden warning", result$html), identical(grepl("visible message", result$html), !quarto))
  named <- run("named", "x <- x + 1", " named")
  rerun <- run("named", "x <- x + 1", " named")
  stopifnot(named$success, rerun$success, identical(env$x, 44))
  failed <- run("failed", "stop('expected cell failure')", ", error=FALSE")
  stopifnot(!failed$success, grepl("expected cell failure", failed$html))
  stopifnot(run("recovery", "x")$success)
  skipped <- run("skipped", c("", "#| eval: false", "stop('must not execute')"))
  stopifnot(skipped$success, !grepl("must not execute", skipped$html))
  env$params <- "preserve me"
  stopifnot(run("parameters", "stopifnot(params$value == 42)")$success,
    identical(env$params, "preserve me"))
  rm("params", envir = env)
  defaults <- run("defaults", c(
    'stopifnot(knitr::opts_chunk$get("fig.width") == 7, knitr::opts_chunk$get("fig.height") == 5,',
    '  knitr::opts_chunk$get("dpi") == 96, knitr::opts_chunk$get("fig.retina") == 2)'
  ))
  stopifnot(defaults$success)
  if (!quarto) {
    writeLines(c("html_document:", "  toc: true", "  toc_depth: 1"), file.path(root, "_output.yml"))
    stopifnot(identical(r_notebook_rmd_options(r_notebook_rmd_metadata(document, env))$toc, TRUE))
    unlink(file.path(root, "_output.yml"))
  }
  table <- run("table", "data.frame(a=1:100, b=letters[1:100])")
  stopifnot(table$success, grepl("<table", table$html), grepl("80 rows omitted", table$html))
  custom <- run("custom", c(
    'knit_print.notebook_table <- function(x, ...) knitr::asis_output("Custom table printer")',
    'structure(data.frame(a=1), class=c("notebook_table", "data.frame"))'
  ))
  stopifnot(custom$success, grepl("Custom table printer", custom$html))
  plot <- run("plot", "plot(1:3)")
  stopifnot(plot$success, grepl("data:image/png;base64,", plot$html, fixed = TRUE))

  # Exercise dependency metadata and rich printing with a real htmlwidget.
  # Plotly contains a literal Ctrl-Z in a JS string. Text-mode reads on Windows
  # truncate that line, corrupting the embedded script while R still succeeds.
  template <- paste0('var binaryMarker = "', rawToChar(as.raw(26)), '"; ',
    'var template = \'<h1 id="chp:example">Literal heading</h1><img src="not-an-asset.png">\';')
  writeLines(c(template, 'HTMLWidgets.widget({name:"probe",type:"output",factory:function(el){return {renderValue:function(x){el.textContent=x.value;},resize:function(){}};}});'), file.path(root, "probe.js"))
  writeLines('.probe { color: rgb(12, 34, 56); }', file.path(root, "probe.css"))
  env$widget_dir <- root
  widget <- run("widget", c(
    'htmlwidgets::createWidget("probe", list(value="widget result"), package="htmlwidgets",',
    '  dependencies=list(htmltools::htmlDependency("probe", "1.0", src=c(file=widget_dir), script="probe.js", stylesheet="probe.css")))'
  ))
  stopifnot(widget$success, grepl("widget result", widget$html),
    grepl("HTMLWidgets.widget", widget$html, fixed = TRUE),
    grepl(template, widget$html, fixed = TRUE),
    grepl("rgb(12, 34, 56)", widget$html, fixed = TRUE),
    !grepl('src="[^" ]+[.]js"', widget$html))

  env$show_toc <- TRUE
  writeLines(c("---", 'title: "`r params$value`"', "params:", "  value: 'Live title'",
    if (quarto) c("format:", "  docx: default", "  html:", "    toc: !expr show_toc",
      "    toc-depth: 2", "    number-sections: true") else
      c("output:", "  word_document: default", "  html_document:", "    toc: !expr show_toc",
      "    toc_depth: 2", "    number_sections: true"), "---",
    "::: {#first .r-notebook-markdown-cell}", "TOKEN_FIRST", ":::",
    "::: {#second .r-notebook-markdown-cell}", "TOKEN_SECOND", ":::"), document)
  snapshot <- readLines(document)
  cells <- file.path(root, "cells.json")
  writeLines(jsonlite::toJSON(list(
    list(token="TOKEN_FIRST", source=paste(c("# Intro", "", "Value `r x`.", "", "See \\@ref(fig:demo) and \\@ref(intro).[^note]", "", "```r", "stop('literal must not execute')", "```"), collapse="\n")),
    list(token="TOKEN_SECOND", source=paste(c("## More", "", '<p class="caption">(\\#fig:demo) Figure</p>', "", "[^note]: Shared footnote."), collapse="\n"))
  ), auto_unbox=TRUE), cells)
  if (quarto) {
    sources <- readLines(cells)
    sources <- gsub("# Intro", "# Intro {#sec-intro}", sources, fixed=TRUE)
    sources <- gsub("\\\\@ref(fig:demo)", "@fig-demo", sources, fixed=TRUE)
    sources <- gsub("\\\\@ref(intro)", "@sec-intro", sources, fixed=TRUE)
    # Replace the caption placeholder through the parsed JSON to avoid escaping differences.
    parsed <- jsonlite::fromJSON(paste(sources, collapse="\n"), simplifyVector=FALSE)
    parsed[[2L]]$source <- sub('<p class="caption">.*?</p>', '<div id="fig-demo" fig-cap="Figure"></div>', parsed[[2L]]$source)
    writeLines(jsonlite::toJSON(parsed, auto_unbox=TRUE), cells)
  }
  for (toc in c(TRUE, FALSE)) {
    env$show_toc <- toc
    writeLines(snapshot, document)
    directory <- file.path(root, paste0("text-", toc)); dir.create(directory)
    r_notebook_render_text(cells, document, directory, root, env)
    stopifnot(identical(readLines(file.path(directory, "done")), "true"))
    html <- paste(readLines(file.path(directory, "result.html")), collapse="\n")
    stopifnot(grepl("Live title", html), identical(grepl('id="TOC"', html), toc),
      grepl('id="first"', html), grepl('id="second"', html), grepl("Value 44", html),
      grepl(if (quarto) 'href="#fig-demo">Figure 1</a>' else 'href="#demo">1</a>', html, fixed=TRUE),
      grepl(if (quarto) 'href="#sec-intro">Section 1</a>' else 'href="#intro">1</a>', html, fixed=TRUE),
      grepl('id="fn-note"', html), grepl("literal must not execute", html),
      !exists("params", env, inherits=FALSE))
  }
  writeLines(c('@Book{example2026, author={Jane Example}, title={A Test Book}, publisher={Test Press}, year={2026}}'), file.path(root,"references.bib"))
  old_wd <- setwd(root); on.exit(setwd(old_wd), add=TRUE)
  # Rewriting a referenced resource must change the next embedded preview.
  for (color in c("red", "blue")) {
    generated <- run(paste0("image-", color), c(
      'png("generated plot.PNG", width=100, height=100)',
      'par(mar=rep(0, 4))', paste0('plot.new(); rect(0, 0, 1, 1, col="', color, '")'), 'dev.off()'
    ))
    stopifnot(generated$success, file.exists("generated plot.PNG"))
    preview <- r_notebook_litedown_html('![Latest plot](generated%20plot.PNG)')
    stopifnot(grepl(xfun::base64_uri("generated plot.PNG"), preview, fixed=TRUE))
  }
  citations <- r_notebook_litedown_html("A citation [@example2026].", list(bibliography="references.bib"))
  stopifnot(grepl('id="refs"', citations), grepl("Example", citations))
  # Literal bookdown syntax and explicit heading IDs must survive unchanged.
  literal <- r_notebook_litedown_html('`\\@ref(fig:demo)`\n\n# Explicit {#sec:keep}\n\n# Repeated\n\n# Repeated')
  stopifnot(grepl('id="sec:keep"', literal), grepl('id="repeated"', literal),
    grepl('id="repeated-1"', literal), grepl('\\@ref(fig:demo)', literal, fixed=TRUE))
  math <- r_notebook_litedown_html('Inline $x^2$ and display $$y^2$$.')
  stopifnot(grepl('data-r-notebook-math', math), grepl('renderMathInElement', math),
    !grepl('<script[^>]+src="https?://|<link[^>]+href="https?://', math))
  stopifnot(!"rmarkdown" %in% loadedNamespaces(), !"bookdown" %in% loadedNamespaces())
}
tryCatch({ for (extension in c("Rmd", "qmd")) run_tests(extension) }, finally = untrace(base::loadNamespace))
cat("R Markdown and Quarto execution and rendering passed without publishing packages.\n")
