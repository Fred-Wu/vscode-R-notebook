source(file.path("resources", "r", "execute.R"), local = TRUE)
r_notebook_load(file.path("resources", "r"))
r_notebook_math_assets <- normalizePath(file.path("dist", "katex"), winslash = "/", mustWork = TRUE)
stopifnot(requireNamespace("litedown", quietly = TRUE))
stopifnot(requireNamespace("rbibutils", quietly = TRUE))

# Heading normalization must follow cmark's block and inline parsing, and must
# preserve all source bytes except the inserted empty heading content.
heading_cases <- c(
  '## {.tabset}' = '## <!-- --> {.tabset}',
  '  ###\t{#tabs .tabset} ###  ' = '  ###\t<!-- --> {#tabs .tabset} ###  ',
  '> ## {.tabset}' = '> ## <!-- --> {.tabset}',
  '- ## {.tabset}' = '- ## <!-- --> {.tabset}',
  '> - ## {.tabset}' = '> - ## <!-- --> {.tabset}',
  '## {.tabset}##' = '## {.tabset}##',
  '## {.one} title {.two}' = '## {.one} title {.two}',
  '## \\{.tabset}' = '## \\{.tabset}',
  '## &#123;.tabset}' = '## &#123;.tabset}',
  '## `{.tabset}`' = '## `{.tabset}`',
  '## **{.tabset}**' = '## **{.tabset}**',
  '####### {.tabset}' = '####### {.tabset}',
  '    ## {.tabset}' = '    ## {.tabset}',
  '```markdown\n## {.tabset}\n```' = '```markdown\n## {.tabset}\n```',
  '> ```markdown\n> ## {.tabset}\n> ```' = '> ```markdown\n> ## {.tabset}\n> ```',
  '<div>\n## {.tabset}\n</div>' = '<div>\n## {.tabset}\n</div>',
  '<script>\n## {.tabset}\n</script>' = '<script>\n## {.tabset}\n</script>',
  '<!--\n## {.tabset}\n-->' = '<!--\n## {.tabset}\n-->',
  '{.tabset}\n---' = '{.tabset}\n---'
)
for (eol in c('\n', '\r\n')) for (trailing in c('', eol)) {
  for (i in seq_along(heading_cases)) {
    source <- paste0(gsub('\n', eol, names(heading_cases)[[i]], fixed = TRUE), trailing)
    expected <- paste0(gsub('\n', eol, heading_cases[[i]], fixed = TRUE), trailing)
    stopifnot(identical(r_notebook_empty_headings(source), expected))
  }
  # Fenced divisions precede notebook cells; they must not shift source offsets.
  source <- paste(c('::: {.cell}', '## {.tabset}', '::: payload :::', '',
    '## {#caf\u00e9 .tabset}', '', '## {.tabset}'), collapse = eol)
  expected <- paste(c('::: {.cell}', '## <!-- --> {.tabset}', '::: payload :::', '',
    '## <!-- --> {#caf\u00e9 .tabset}', '', '## <!-- --> {.tabset}'), collapse = eol)
  stopifnot(identical(r_notebook_empty_headings(source), expected))
}

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
  # Anonymous attribute-only section headings are structure, not TOC labels.
  toc_metadata <- if (quarto) list(toc = TRUE) else list(output = list(html_document = list(toc = TRUE)))
  tabset_source <- c(
    '## {.tabset}', '', '### Patient flow {.tabset}', '',
    '## {#other-tabs .tabset .tabset-pills} ##', '', '### Another panel', '',
    '# Literal `{.tabset}`', '', '```markdown', '## {.tabset}', '```'
  )
  for (eol in c('\n', '\r\n')) {
    tabsets <- r_notebook_litedown_html(paste(tabset_source, collapse = eol), toc_metadata, outline = TRUE, format = format)
    stopifnot(grepl('<h2 id="section" class="tabset"><!-- --></h2>', tabsets, fixed = TRUE),
      grepl('<h2 class="tabset tabset-pills" id="other-tabs"><!-- --></h2>', tabsets, fixed = TRUE),
      grepl('<h3 id="patient-flow" class="tabset">Patient flow</h3>', tabsets, fixed = TRUE),
      grepl('Literal <code>{.tabset}</code>', tabsets, fixed = TRUE),
      grepl('## {.tabset}', tabsets, fixed = TRUE))
    toc_html <- regmatches(tabsets, regexpr('(?s)<nav id="TOC">.*?</nav>', tabsets, perl = TRUE))
    stopifnot(grepl('href="#patient-flow"', toc_html, fixed = TRUE),
      grepl('href="#another-panel"', toc_html, fixed = TRUE),
      !grepl('href="#section"', toc_html, fixed = TRUE),
      !grepl('href="#other-tabs"', toc_html, fixed = TRUE))
  }
  heading_edges <- r_notebook_litedown_html(paste(c(
    '> ## {.tabset}', '', '- ## {#list-tabs .tabset}', '',
    '## {.tabset}##', '', '<div>', '## {.tabset}', '</div>'
  ), collapse = '\n'), toc_metadata, outline = TRUE, format = format)
  stopifnot(grepl('<blockquote>\n<h2 id="section" class="tabset"><!-- --></h2>', heading_edges, fixed = TRUE),
    grepl('<h2 class="tabset" id="list-tabs"><!-- --></h2>', heading_edges, fixed = TRUE),
    grepl('>{.tabset}##</h2>', heading_edges, fixed = TRUE),
    grepl('<div>\n## {.tabset}\n</div>', heading_edges, fixed = TRUE))
  numbered_metadata <- if (quarto) list(toc = TRUE, 'number-sections' = TRUE) else
    list(output = list(html_document = list(toc = TRUE, number_sections = TRUE)))
  numbered <- r_notebook_litedown_html('## {.tabset .unnumbered}\n\n# First',
    numbered_metadata, outline = TRUE, format = format)
  stopifnot(grepl('<h2 id="section" class="tabset unnumbered"><!-- --></h2>', numbered, fixed = TRUE),
    grepl('<span class="section-number main-number">1</span> First', numbered, fixed = TRUE))
  math <- r_notebook_litedown_html('Inline $x^2$ and display $$y^2$$.')
  stopifnot(grepl('data-r-notebook-math', math), grepl('renderMathInElement', math),
    !grepl('<script[^>]+src="https?://|<link[^>]+href="https?://', math))
  stopifnot(!"rmarkdown" %in% loadedNamespaces(), !"bookdown" %in% loadedNamespaces())
}
tryCatch({ for (extension in c("Rmd", "qmd")) run_tests(extension) }, finally = untrace(base::loadNamespace))
cat("R Markdown and Quarto execution and rendering passed without publishing packages.\n")
