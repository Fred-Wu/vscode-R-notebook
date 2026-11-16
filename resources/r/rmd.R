# R Markdown metadata and bookdown reference conventions.

r_notebook_rmd_metadata <- function(document_path, evaluation_env = base::globalenv(), directory = base::dirname(document_path)) {
  value <- r_notebook_read_metadata(document_path, evaluation_env)
  read_config <- function(names) {
    paths <- base::ifelse(base::grepl("^([A-Za-z]:|[/\\\\])", names), names, base::file.path(directory, names))
    path <- paths[base::file.exists(paths)][1L]
    if (base::is.na(path)) list() else r_notebook_read_yaml(path, evaluation_env)
  }
  merge <- function(defaults, output) {
    defaults <- r_notebook_output_formats(defaults)
    output <- r_notebook_output_formats(output)
    combined <- utils::modifyList(defaults, output)
    combined[c(base::names(output), base::setdiff(base::names(defaults), base::names(output)))]
  }
  site <- read_config(c("_site.yml", "_site.yaml"))
  common <- read_config(c(value$output_yaml, "_output.yml", "_output.yaml"))
  value$output <- merge(merge(site$output, common), value$output)
  value
}

r_notebook_rmd_options <- function(metadata) {
  output <- metadata$output
  if (!base::is.list(output) || base::length(output) == 0L) return(list())
  options <- if (base::is.list(output[[1L]])) output[[1L]] else list()
  html <- base::which(base::grepl("(^|::)html_(document2?|notebook|vignette)$", base::names(output)))
  if (base::length(html) && base::is.list(output[[html[[1L]]]])) {
    options <- utils::modifyList(options, output[[html[[1L]]]])
  }
  options
}

r_notebook_bookdown_markdown <- function(markdown) {
  r_notebook_transform_prose(markdown, function(text) {
    counters <- c(fig = 0L, tab = 0L)
    text <- r_notebook_replace_matches(text, '\\(\\\\#((?:fig|tab):[A-Za-z][\\w:.-]*)\\)', function(matches) {
      base::vapply(matches, function(value) {
        id <- base::sub('^\\(\\\\#(.*)\\)$', '\\1', value)
        kind <- base::sub(":.*", "", id)
        counters[[kind]] <<- counters[[kind]] + 1L
        base::paste0('<span id="', id, '" class="ref-number-', kind, '">', counters[[kind]], '</span>')
      }, base::character(1))
    })
    text <- base::gsub('\\\\@ref\\(([A-Za-z][\\w:.-]*)\\)', '<a href="#\\1" data-r-notebook-reference="\\1">\\1</a>', text, perl = TRUE)
    text
  })
}

r_notebook_bookdown_html <- function(html) {
  numbers <- list()
  captions <- base::regmatches(html, base::gregexpr('<span id="((?:fig|tab):[^"]+)" class="ref-number-[^"]+">([0-9]+)</span>', html, perl = TRUE))[[1L]]
  for (caption in captions) {
    id <- base::sub('^<span id="([^"]+)".*$', '\\1', caption)
    numbers[[id]] <- base::sub('^.*>([0-9]+)</span>$', '\\1', caption)
  }
  headings <- base::regmatches(html, base::gregexpr('<h[1-6] id="([^"]+)"[^>]*><span class="section-number[^"]*">([^<]+)</span>', html, perl = TRUE))[[1L]]
  for (heading in headings) {
    id <- base::sub('^<h[1-6] id="([^"]+)".*$', '\\1', heading)
    numbers[[id]] <- base::sub('^.*<span[^>]*>([^<]+)</span>$', '\\1', heading)
  }
  r_notebook_resolve_references(html, numbers, function(id) base::sub("^(fig|tab):", "", id))
}

r_notebook_rmd <- list(
  metadata = r_notebook_rmd_metadata,
  options = r_notebook_rmd_options,
  configure = function(metadata) base::invisible(),
  markdown = function(markdown, metadata) r_notebook_bookdown_markdown(markdown),
  html = function(html, metadata) r_notebook_bookdown_html(html)
)
