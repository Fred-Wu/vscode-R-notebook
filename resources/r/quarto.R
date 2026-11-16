# Quarto conventions only. Execution and HTML conversion live in execute.R and
# render.R; notebook previews never load Quarto's publishing engine.
r_notebook_quarto_metadata <- function(document_path, evaluation_env, directory = base::dirname(document_path)) {
  directory <- base::normalizePath(directory, winslash = "/", mustWork = TRUE)
  directories <- directory
  repeat {
    current <- directories[[1L]]
    project <- base::file.path(current, c("_quarto.yml", "_quarto.yaml"))
    project <- project[base::file.exists(project)]
    parent <- base::dirname(current)
    if (base::length(project) || base::identical(parent, current)) break
    directories <- c(parent, directories)
  }
  # Without a project, only directory metadata beside the document applies.
  if (!base::length(project)) directories <- directory
  merge <- function(defaults, values) {
    defaults$format <- r_notebook_output_formats(defaults$format)
    if (!base::is.null(values$format)) values$format <- r_notebook_output_formats(values$format)
    result <- utils::modifyList(defaults, values)
    # The first requested publishing format determines portable defaults.
    order <- c(base::names(values$format), base::setdiff(base::names(defaults$format), base::names(values$format)))
    result$format <- result$format[order]
    result
  }
  read_config <- function(path, seen = base::character()) {
    path <- base::normalizePath(path, winslash = "/", mustWork = TRUE)
    if (path %in% seen) base::stop("Circular notebook metadata-file reference: ", path)
    values <- r_notebook_read_yaml(path, evaluation_env)
    includes <- c(values[["metadata-file"]], base::unlist(values[["metadata-files"]], use.names = FALSE))
    defaults <- list()
    for (include in includes) {
      if (!base::grepl("^([A-Za-z]:|[/\\\\])", include)) include <- base::file.path(base::dirname(path), include)
      defaults <- merge(defaults, read_config(include, c(seen, path)))
    }
    merge(defaults, values)
  }
  metadata <- if (base::length(project)) read_config(project[[1L]]) else list()
  for (dir in directories) {
    candidates <- base::file.path(dir, c("_metadata.yml", "_metadata.yaml"))
    existing <- candidates[base::file.exists(candidates)]
    if (base::length(existing)) metadata <- merge(metadata, read_config(existing[[1L]]))
  }
  document <- r_notebook_read_metadata(document_path, evaluation_env)
  includes <- c(document[["metadata-file"]], base::unlist(document[["metadata-files"]], use.names = FALSE))
  for (include in includes) {
    if (!base::grepl("^([A-Za-z]:|[/\\\\])", include)) include <- base::file.path(directory, include)
    metadata <- merge(metadata, read_config(include))
  }
  metadata <- merge(metadata, document)
  formats <- metadata$format
  selected <- if ("html" %in% base::names(formats)) formats$html else if (base::length(formats)) formats[[1L]] else list()
  metadata <- utils::modifyList(metadata, selected)
  if (base::is.list(metadata$author)) {
    metadata$author <- if (!base::is.null(metadata$author$name)) metadata$author$name else {
      base::vapply(metadata$author, function(author) {
        if (base::is.character(author)) author else if (base::is.character(author$name)) author$name else ""
      }, base::character(1))
    }
  }
  if (base::is.list(metadata$project) && base::isTRUE(metadata$project[["execute-dir"]] == "project") && base::length(project)) {
    metadata[[".notebook-root"]] <- directories[[1L]]
  }
  metadata
}

r_notebook_quarto_options <- function(metadata) {
  list(toc = metadata$toc, toc_depth = metadata[["toc-depth"]], number_sections = metadata[["number-sections"]])
}

r_notebook_quarto_configure <- function(metadata) {
  options <- metadata$execute
  if (base::is.null(options)) options <- list()
  if (!base::is.list(options)) options <- list(enabled = options)
  aliases <- c("fig-width" = "fig.width", "fig-height" = "fig.height", "fig-asp" = "fig.asp",
    "fig-format" = "dev", "fig-dpi" = "dpi")
  defaults <- list(error = FALSE)
  for (name in c("eval", "error", "warning", "include", "output", "cache", base::names(aliases))) {
    value <- options[[name]]
    if (base::is.null(value)) value <- metadata[[name]]
    if (base::is.null(value)) next
    target <- if (name %in% base::names(aliases)) aliases[[name]] else name
    defaults[[target]] <- value
  }
  if (!base::is.null(defaults$warning)) defaults$message <- defaults$warning
  if (base::identical(defaults$dev, "retina")) {
    defaults$dev <- "png"
    defaults$fig.retina <- 2
  }
  knitr::opts_chunk$set(defaults)
  if (base::is.list(metadata$knitr$opts_chunk)) knitr::opts_chunk$set(metadata$knitr$opts_chunk)
  if (base::is.list(metadata$knitr$opts_knit)) knitr::opts_knit$set(metadata$knitr$opts_knit)
  if (!base::is.null(metadata[[".notebook-root"]])) knitr::opts_knit$set(root.dir = metadata[[".notebook-root"]])
  knitr::opts_hooks$set(code = function(chunk) {
    for (name in base::names(aliases)) {
      if (!base::is.null(chunk[[name]])) chunk[[aliases[[name]]]] <- chunk[[name]]
    }
    if (base::identical(chunk$dev, "retina")) { chunk$dev <- "png"; chunk$fig.retina <- 2 }
    if (base::isFALSE(options$enabled)) chunk$eval <- FALSE
    if (base::isFALSE(chunk$warning)) chunk$message <- FALSE
    if (base::isFALSE(chunk$output)) {
      chunk$results <- "hide"; chunk$fig.show <- "hide"; chunk$warning <- FALSE; chunk$message <- FALSE
    } else if (base::identical(chunk$output, "asis")) chunk$results <- "asis"
    # Source is already visible in the notebook editor.
    if (base::identical(chunk$echo, "fenced")) chunk$echo <- TRUE
    chunk
  })
  previous_chunk <- knitr::knit_hooks$get("chunk")
  knitr::knit_hooks$set(chunk = function(output, chunk) {
    caption <- chunk[["tbl-cap"]]
    if (!base::is.null(caption) && base::grepl('<table', output, fixed = TRUE) &&
        !base::grepl('<caption', output, fixed = TRUE)) {
      caption <- base::as.character(litedown::mark(text = base::as.character(caption),
        options = list(js_math = FALSE, js_highlight = FALSE)))
      caption <- base::sub('^<p>(.*?)</p>$', '\\1', caption)
      output <- base::sub('(<table[^>]*>)', base::paste0('\\1<caption>', caption, '</caption>'), output)
    }
    previous_chunk(output, chunk)
  })
}

r_notebook_quarto_markdown <- function(markdown, metadata) {
  r_notebook_transform_prose(markdown, function(text) {
    base::gsub('(?<![[:alnum:]_/@])@((?:fig|tbl|sec|eq|lst)-[[:alnum:]_:-]+)',
      '<a href="#\\1" data-r-notebook-reference="\\1">@\\1</a>', text, perl = TRUE)
  })
}

r_notebook_quarto_html <- function(html, metadata) {
  # Code placeholders and explicit figure/table/section IDs share the same
  # targets used by VS Code to reveal cells that are not currently visible.
  numbers <- list()
  counters <- c(fig = 0L, tbl = 0L, sec = 0L, eq = 0L, lst = 0L)
  tags <- base::regmatches(html, base::gregexpr('<[A-Za-z][^>]* id="((?:fig|tbl|sec|eq|lst)-[^"]+)"[^>]*>', html, perl = TRUE))[[1L]]
  for (tag in tags) {
    id <- base::sub('^.* id="([^"]+)".*$', '\\1', tag)
    if (!base::is.null(numbers[[id]])) next
    kind <- base::sub('-.*$', '', id)
    counters[[kind]] <- counters[[kind]] + 1L
    number <- base::as.character(counters[[kind]])
    if (kind == "sec") {
      heading <- base::regmatches(html, base::regexpr(base::paste0('<h[1-6] id="', id,
        '"[^>]*><span class="section-number[^"]*">[^<]+</span>'), html, perl = TRUE))
      if (base::length(heading)) number <- base::sub('^.*<span[^>]*>([^<]+)</span>$', '\\1', heading)
    }
    numbers[[id]] <- base::paste(c(fig = "Figure", tbl = "Table", sec = "Section", eq = "Equation", lst = "Listing")[[kind]], number)
  }
  html <- r_notebook_resolve_references(html, numbers)
  if (base::grepl('class="callout-', html, fixed = TRUE)) {
    html <- base::sub('</head>', paste0('<style>',
      '[class*="callout-"]{border-left:3px solid var(--vscode-textLink-foreground);padding:.6em 1em;margin:1em 0}',
      '.callout-warning,.callout-caution{border-color:var(--vscode-editorWarning-foreground)}',
      '</style></head>'), html, fixed = TRUE)
  }
  html
}

r_notebook_quarto <- list(
  metadata = r_notebook_quarto_metadata,
  options = r_notebook_quarto_options,
  configure = r_notebook_quarto_configure,
  markdown = r_notebook_quarto_markdown,
  html = r_notebook_quarto_html
)
