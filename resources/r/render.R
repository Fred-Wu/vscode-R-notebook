# Shared YAML, inline R, litedown HTML, and resource handling for both formats.
r_notebook_math_assets <- NULL

r_notebook_yaml <- function(text, evaluation_env) {
  expression <- function(x) base::eval(base::parse(text = x), envir = evaluation_env)
  value <- yaml::yaml.load(base::paste(text, collapse = "\n"), eval.expr = FALSE,
    handlers = list(expr = expression, r = expression))
  if (base::is.null(value)) return(list())
  if (!base::is.list(value) || base::is.null(base::names(value))) {
    base::stop("Notebook YAML must contain named fields.")
  }
  value
}

r_notebook_read_yaml <- function(path, evaluation_env) {
  r_notebook_yaml(base::readLines(path, warn = FALSE, encoding = "UTF-8"), evaluation_env)
}

r_notebook_read_metadata <- function(document_path, evaluation_env) {
  front <- r_notebook_front_matter(document_path)
  if (base::length(front) < 3L) return(list())
  r_notebook_yaml(front[-c(1L, base::length(front))], evaluation_env)
}

r_notebook_output_formats <- function(output) {
  if (base::length(output) == 0L) return(list())
  if (base::is.character(output)) return(stats::setNames(base::rep(list(list()), base::length(output)), output))
  if (!base::is.list(output)) return(list())
  if (base::is.null(base::names(output))) {
    return(base::unlist(base::lapply(output, r_notebook_output_formats), recursive = FALSE))
  }
  base::lapply(output, function(options) if (base::is.list(options)) options else list())
}

r_notebook_resolve_references <- function(html, labels, target = base::identity) {
  r_notebook_replace_matches(html, '<a href="#[^"]+" data-r-notebook-reference="([^"]+)">[^<]+</a>', function(matches) {
    base::vapply(matches, function(value) {
      id <- base::sub('^.*data-r-notebook-reference="([^"]+)".*$', '\\1', value)
      if (base::is.null(labels[[id]])) return(value)
      base::paste0('<a href="#', target(id), '">', labels[[id]], '</a>')
    }, base::character(1))
  })
}

# Apply format syntax only to prose, leaving literal examples intact.
r_notebook_transform_prose <- function(markdown, transform) {
  protected <- r_notebook_mask_literal_markdown(base::strsplit(markdown, "\n", fixed = TRUE)[[1L]])
  text <- base::paste(protected$markup, collapse = "\n")
  literals <- list()
  text <- r_notebook_replace_matches(text, "(`+)(?:(?!\\1).)*?\\1", function(matches) {
    base::vapply(matches, function(value) {
      token <- base::paste0("VSC_R_NOTEBOOK_INLINE_LITERAL_", base::length(literals), "_")
      while (base::grepl(token, markdown, fixed = TRUE)) token <- base::paste0(token, "X")
      literals[[token]] <<- value
      token
    }, base::character(1))
  })
  r_notebook_restore_literal_markdown(transform(text), c(protected$originals, literals))
}

r_notebook_front_matter <- function(document_path) {
  lines <- base::readLines(document_path, warn = FALSE, encoding = "UTF-8")
  r_notebook_partition_yaml(lines)$front_matter
}

# Parsing front matter must not require rmarkdown (including in .Rmd-only installs).

r_notebook_partition_yaml <- function(lines) {
  first <- base::which(base::nzchar(base::trimws(lines)))[1L]
  if (base::is.na(first) || !base::grepl("^---[[:space:]]*$", lines[[first]])) {
    return(list(front_matter = NULL, body = lines))
  }
  ends <- base::which(base::grepl("^(---|[.][.][.])[[:space:]]*$", lines))
  end <- ends[ends > first][1L]
  if (base::is.na(end)) return(list(front_matter = NULL, body = lines))
  list(front_matter = lines[first:end], body = lines[-base::seq_len(end)])
}

r_notebook_with_params <- function(metadata, evaluation_env, action) {
  if (base::is.null(metadata$params)) return(action())
  params <- base::lapply(metadata$params, function(param) {
    if (base::is.list(param) && "value" %in% base::names(param)) param$value else param
  })
  had_params <- base::exists("params", envir = evaluation_env, inherits = FALSE)
  old_params <- if (had_params) base::get("params", envir = evaluation_env)
  locked <- had_params && base::bindingIsLocked("params", evaluation_env)
  if (locked) base::stop("Cannot set notebook parameters: 'params' is locked.")
  base::assign("params", params, envir = evaluation_env)
  base::lockBinding("params", evaluation_env)
  base::on.exit({
    base::unlockBinding("params", evaluation_env)
    if (had_params) base::assign("params", old_params, envir = evaluation_env)
    else base::rm("params", envir = evaluation_env)
  }, add = TRUE)
  action()
}

r_notebook_replace_matches <- function(text, pattern, replacement) {
  positions <- base::gregexpr(pattern, text, perl = TRUE)
  matches <- base::regmatches(text, positions)[[1L]]
  if (base::length(matches)) {
    base::regmatches(text, positions) <- list(replacement(matches))
  }
  text
}

# Preserve ordinary Markdown heading links while removing litedown's automatic
# prefixes. Explicit IDs remain untouched in both notebook formats.
r_notebook_heading_ids <- function(html, markdown) {
  source <- r_notebook_mask_literal_markdown(base::strsplit(markdown, "\n", fixed = TRUE)[[1L]])$markup
  source <- base::paste(source, collapse = "\n")
  source <- base::gsub("(`+)(?:(?!\\1).)*?\\1", "", source, perl = TRUE)
  explicit <- base::regmatches(source, base::gregexpr('\\{#[^[:space:]}"]+', source, perl = TRUE))[[1L]]
  explicit <- base::sub("^\\{#", "", explicit)
  used <- explicit
  replacements <- list()
  html <- r_notebook_replace_matches(html, '<h[1-6] id="(?:chp|sec):[^"]+"[^>]*>.*?</h[1-6]>', function(headings) {
    base::vapply(headings, function(heading) {
      old <- base::sub('^<h[1-6] id="([^"]+)".*$', '\\1', heading)
      if (old %in% explicit) return(heading)
      label <- base::sub('^<h[1-6][^>]*>(.*?)</h[1-6]>$', '\\1', heading)
      label <- base::gsub('<span class="section-number[^"]*">.*?</span>[ ]*', '', label)
      label <- base::as.character(litedown::mark(text = label, output = "text"))
      slug <- base::tolower(base::trimws(label))
      slug <- base::gsub("[^[:alnum:]_ .-]", "", slug)
      slug <- base::gsub("[[:space:]]+", "-", slug)
      slug <- base::sub("^[^[:alpha:]]*", "", slug)
      if (!base::nzchar(slug)) slug <- "section"
      id <- slug
      suffix <- 0L
      while (id %in% used) { suffix <- suffix + 1L; id <- base::paste0(slug, "-", suffix) }
      used <<- c(used, id)
      replacements[[old]] <<- id
      base::sub(base::paste0('id="', old, '"'), base::paste0('id="', id, '"'), heading, fixed = TRUE)
    }, base::character(1))
  })
  for (old in base::names(replacements)) {
    html <- base::gsub(base::paste0('href="#', old, '"'), base::paste0('href="#', replacements[[old]], '"'), html, fixed = TRUE)
  }
  html
}

r_notebook_require_litedown <- function() {
  if (!base::requireNamespace("litedown", quietly = TRUE) || utils::packageVersion("litedown") < "1.0") {
    base::stop("Install litedown 1.0 or newer to render notebooks.")
  }
}

r_notebook_read_script <- function(path) {
  # Windows text-mode reads treat a literal Ctrl-Z in JavaScript as EOF.
  connection <- base::file(path, open = "rb")
  base::on.exit(base::close(connection))
  base::paste(base::readLines(connection, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
}

r_notebook_litedown_html <- function(markdown, metadata = list(), knit_meta = list(), outline = FALSE, format = r_notebook_rmd) {
  r_notebook_require_litedown()
  settings <- format$options(metadata)
  markdown <- format$markdown(markdown, metadata)
  # Passing only preview metadata avoids loading publishing formats or templates.
  fields <- c(if (outline) c("title", "subtitle", "author", "date"), "bibliography")
  meta <- metadata[base::intersect(base::names(metadata), fields)]
  meta["css"] <- list(base::character())
  meta["js"] <- list(base::character())
  options <- list(toc = FALSE, number_sections = outline && base::isTRUE(settings$number_sections),
    cross_refs = FALSE, js_math = FALSE, js_highlight = FALSE, embed_resources = "all", embed_cleanup = FALSE)
  dependencies <- base::Filter(function(x) base::inherits(x, "html_dependency"), knit_meta)
  header <- ""
  if (base::length(dependencies)) {
    header <- htmltools::renderDependencies(htmltools::resolveDependencies(dependencies),
      srcType = "file", encodeFunc = base::identity)
    header <- base::gsub('<link href="([^"]+)" rel="stylesheet"',
      '<link rel="stylesheet" href="\\1"', header)
    # htmltools escapes attribute values; litedown expects filesystem paths.
    # Embed through its metadata API so characters such as & and quotes never
    # become part of a filename or break an intermediate HTML attribute.
    header <- r_notebook_replace_matches(header,
      '<script[^>]* src="[^"]+"[^>]*>\\s*</script>|<link[^>]* rel="stylesheet"[^>]*>',
      function(tags) base::vapply(tags, function(tag) {
        script <- base::startsWith(tag, "<script")
        attribute <- if (script) "src" else "href"
        pattern <- base::paste0(' ', attribute, '="([^"]+)"')
        path <- base::sub(base::paste0('.*', pattern, '.*'), '\\1', tag)
        for (entity in c('&quot;', '&#39;', '&lt;', '&gt;', '&amp;')) {
          path <- base::gsub(entity, c('&quot;'='"', '&#39;'="'", '&lt;'='<', '&gt;'='>', '&amp;'='&')[[entity]], path, fixed = TRUE)
        }
        if (!base::file.exists(path)) return(base::as.character(litedown::mark(text = tag, options = options)))
        content <- if (script) r_notebook_read_script(path) else {
          embedded <- base::as.character(litedown::mark(
            text = c('---', 'output:', '  html:', '    template: "$css$"', '---', ' '),
            meta = list(css = path), options = options))
          base::substr(embedded, base::regexpr('>', embedded)[[1L]] + 1L,
            base::regexpr('</[^>]+>$', embedded)[[1L]] - 1L)
        }
        opening <- base::sub(pattern, '', base::sub('>.*$', '>', tag))
        if (!script) opening <- base::sub('^<link', '<style', base::sub(' rel="stylesheet"', '', opening, fixed = TRUE))
        base::paste0(opening, '\n', content, '\n</', if (script) 'script' else 'style', '>')
      }, base::character(1)))
  }
  # Pass only evaluated preview metadata, never the publishing configuration.
  bibliography <- if (!base::is.null(meta$bibliography)) {
    yaml::as.yaml(list(bibliography = meta$bibliography))
  } else base::character()
  text <- c("---", "output:", "  html:", "    template: true", bibliography, "---", markdown)
  html <- base::as.character(litedown::mark(text = text, output = "html", options = options, meta = meta))
  math_initializer <- ""
  prose <- base::gsub('(?s)<(pre|code|script)[ >].*?</\\1>', '', html, perl = TRUE)
  if (base::grepl('\\(', prose, fixed = TRUE) || base::grepl('$$', prose, fixed = TRUE) ||
      base::grepl('\\begin{', prose, fixed = TRUE)) {
    assets <- r_notebook_math_assets
    if (base::is.null(assets) || !base::file.exists(base::file.path(assets, "katex.min.js"))) {
      base::stop("The notebook's bundled math assets are missing. Reinstall the extension.")
    }
    cached <- base::getOption("vsc.r.notebook.math")
    if (!base::identical(cached$path, assets)) {
      embedded <- base::as.character(litedown::mark(
        text = c('---', 'output:', '  html:', '    template: "$css$"', '---', ' '),
        meta = list(css = base::file.path(assets, 'katex.min.css')),
        options = list(embed_resources = TRUE, js_math = FALSE, js_highlight = FALSE)))
      scripts <- base::vapply(base::file.path(assets, c('katex.min.js', 'auto-render.min.js')), function(path) {
        base::paste(c('<script>', r_notebook_read_script(path), '</script>'), collapse = "\n")
      }, base::character(1))
      embedded <- base::paste(c(embedded, scripts), collapse = "\n")
      cached <- list(path = assets, html = embedded)
      base::options(vsc.r.notebook.math = cached)
    }
    header <- base::paste(header, cached$html, sep = "\n")
    # Standalone cell outputs initialize themselves. Markdown previews initialize
    # each inserted cell in the renderer, including cells revealed after scrolling.
    math_initializer <- base::paste0('<script data-r-notebook-math>',
      'if(window.renderMathInElement)window.renderMathInElement(document.body,{throwOnError:false});',
      '</script>')
  }
  html <- r_notebook_heading_ids(html, markdown)
  html <- format$html(html, metadata)
  # Match the renderer's existing title/author/date extraction contract.
  html <- base::sub('<header class="frontmatter">', '<header id="header" class="frontmatter">', html, fixed = TRUE)
  if (outline && base::isTRUE(settings$toc)) {
    headings <- base::regmatches(html, base::gregexpr('<h[1-6] id="[^"]+"[^>]*>.*?</h[1-6]>', html, perl = TRUE))[[1L]]
    depth <- if (base::is.numeric(settings$toc_depth)) settings$toc_depth else 3L
    headings <- headings[base::as.integer(base::substr(headings, 3L, 3L)) <= depth &
      !base::grepl('class="[^"]*\\bunlisted\\b', headings, perl = TRUE)]
    if (base::length(headings)) {
      levels <- base::as.integer(base::substr(headings, 3L, 3L))
      levels <- levels - base::min(levels)
      # A jump from h1 to h4 still represents one nested TOC list.
      if (base::length(levels) > 1L) for (i in 2L:base::length(levels)) {
        levels[[i]] <- base::min(levels[[i]], levels[[i - 1L]] + 1L)
      }
      headings <- base::gsub('<a\\b[^>]*>|</a>', '', headings, perl = TRUE)
      links <- base::sub('^<h[1-6] id="([^"]+)"[^>]*>(.*?)</h[1-6]>$', '<a href="#\\1">\\2</a>', headings)
      toc <- litedown::mark(text = base::paste0(base::strrep("  ", levels), "- ", links),
        options = list(auto_identifiers = FALSE, js_highlight = FALSE))
      html <- base::sub("<main>", base::paste0('<nav id="TOC">', toc, '</nav>\n<main>'), html, fixed = TRUE)
    }
  }
  # Insert assets after all document transformations. JavaScript strings can
  # contain HTML tags and heading IDs that must remain unchanged.
  if (base::nzchar(header)) html <- base::sub('</head>', base::paste0(header, '\n</head>'), html, fixed = TRUE)
  if (base::nzchar(math_initializer)) html <- base::sub('</body>', base::paste0(math_initializer, '\n</body>'), html, fixed = TRUE)
  html
}

r_notebook_prepare_html <- function(html, cell_output = FALSE) {
  pattern <- "<link[[:space:]][^>]*href=\"data:text/css,([^\"]*)\"[^>]*>"
  locations <- base::gregexpr(pattern, html, perl = TRUE)
  links <- base::regmatches(html, locations)[[1L]]
  if (base::length(links) > 0L) {
    encoded <- base::sub(pattern, "\\1", links, perl = TRUE)
    styles <- base::paste0(
      "<style>",
      base::vapply(encoded, function(value) {
        input <- base::charToRaw(value)
        output <- base::raw(base::length(input))
        input_index <- 1L
        output_index <- 1L
        while (input_index <= base::length(input)) {
          if (
            input[[input_index]] == base::as.raw(37L) &&
              input_index + 2L <= base::length(input)
          ) {
            digits <- base::as.integer(input[(input_index + 1L):(input_index + 2L)])
            digits[digits > 96L] <- digits[digits > 96L] - 32L
            digits[digits > 57L] <- digits[digits > 57L] - 7L
            output[[output_index]] <- base::as.raw(
              base::sum((digits - 48L) * c(16L, 1L))
            )
            input_index <- input_index + 3L
          } else {
            output[[output_index]] <- input[[input_index]]
            input_index <- input_index + 1L
          }
          output_index <- output_index + 1L
        }
        base::rawToChar(output[base::seq_len(output_index - 1L)])
      }, base::character(1)),
      "</style>"
    )
    base::regmatches(html, locations) <- list(styles)
  }

  output_style <- if (base::isTRUE(cell_output)) "<style>pre code{background-color:transparent}</style>" else ""
  dt_theme_style <- ""
  if (base::grepl("div.datatables", html, fixed = TRUE)) {
    dt_theme_style <- base::paste0(
      "<style data-vsc-r-notebook-dt-theme>",
      "div.datatables{",
      "color:var(--vscode-editor-foreground)}",
      "</style>"
    )
  }
  widget_bootstrap <- ""
  if (
    base::grepl("window.HTMLWidgets.staticRender", html, fixed = TRUE) &&
      base::grepl("data-for=\"htmlwidget-", html, fixed = TRUE)
  ) {
    widget_bootstrap <- base::paste0(
      "<script type=\"application/javascript\" ",
      "data-vsc-r-notebook-htmlwidgets>",
      "if(window.HTMLWidgets&&",
      "typeof window.HTMLWidgets.staticRender===\"function\")",
      "{window.HTMLWidgets.staticRender();}",
      "</script>"
    )
  }
  if (base::grepl("</head>", html, fixed = TRUE)) {
    html <- base::sub(
      "</head>",
      base::paste0(output_style, dt_theme_style, "</head>"),
      html,
      fixed = TRUE
    )
  } else {
    html <- base::paste0(output_style, dt_theme_style, html)
  }
  if (
    base::nzchar(widget_bootstrap) &&
      base::grepl("</body>", html, fixed = TRUE)
  ) {
    return(base::sub(
      "</body>",
      base::paste0(widget_bootstrap, "</body>"),
      html,
      fixed = TRUE
    ))
  }
  base::paste0(html, widget_bootstrap)
}

r_notebook_mask_literal_markdown <- function(
  markup,
  token_prefix = "VSC_R_NOTEBOOK_FENCED_LINE_"
) {
  # knitr's inline parser is deliberately independent of Pandoc. Mask complete
  # literal fenced code blocks so examples of `r expressions` are not run.
  masked <- markup
  originals <- list()
  active_marker <- ""
  active_length <- 0L
  # Containers are ordered: list indentation and quote prefixes can alternate.
  # A zero denotes a quote; positive widths denote list-item indentation.
  containers <- integer()
  paragraph_open <- FALSE
  if (base::length(markup) > 0L) for (index in base::seq_along(markup)) {
    line <- markup[[index]]
    # Measure container indentation in columns while preserving original text.
    tab <- base::regexpr("\t", line, fixed = TRUE)[[1L]]
    while (tab > 0L) {
      line <- base::paste0(base::substr(line, 1L, tab - 1L),
        base::strrep(" ", 4L - (tab - 1L) %% 4L), base::substring(line, tab + 1L))
      tab <- base::regexpr("\t", line, fixed = TRUE)[[1L]]
    }
    matched <- 0L
    for (container in containers) {
      if (container == 0L) {
        if (!base::grepl("^ {0,3}>[ \t]?", line, perl = TRUE)) break
        line <- base::sub("^ {0,3}>[ \t]?", "", line, perl = TRUE)
      } else if (!base::nzchar(base::trimws(line))) {
        line <- ""
      } else {
        if (!base::startsWith(line, base::strrep(" ", container))) break
        line <- base::substring(line, container + 1L)
      }
      matched <- matched + 1L
    }
    if (matched < base::length(containers)) {
      containers <- containers[base::seq_len(matched)]
      active_marker <- ""
      paragraph_open <- FALSE
    }
    if (!base::nzchar(active_marker)) repeat {
      quote <- base::regmatches(line, base::regexpr("^ {0,3}>[ \t]?", line, perl = TRUE))
      if (base::length(quote) && base::nzchar(quote)) {
        containers <- c(containers, 0L)
        line <- base::substring(line, base::nchar(quote) + 1L)
      } else {
        prefix <- base::regmatches(line, base::regexpr(
          "^ {0,3}(?:[-+*]|[0-9]+[.)]) +", line, perl = TRUE
        ))
        if (!base::length(prefix) || !base::nzchar(prefix)) break
        padding <- base::attr(base::regexpr(" +$", prefix), "match.length")
        # Five or more spaces after a marker start indented code within the item.
        width <- base::nchar(prefix) - if (padding > 4L) padding - 1L else 0L
        containers <- c(containers, width)
        line <- base::substring(line, width + 1L)
      }
      paragraph_open <- FALSE
    }
    opening <- base::regmatches(
      line, base::regexec("^ {0,3}(`{3,}|~{3,})", line, perl = TRUE)
    )[[1L]]
    is_fence <- FALSE
    if (base::nzchar(active_marker)) {
      is_fence <- TRUE
      closing <- base::paste0(
        "^ {0,3}", active_marker,
        "{", active_length, ",}[ \t]*$"
      )
      if (base::grepl(closing, line, perl = TRUE)) {
        active_marker <- ""
      }
    } else if (base::length(opening) >= 2L) {
      active_marker <- base::substr(opening[[2L]], 1L, 1L)
      active_length <- base::nchar(opening[[2L]])
      is_fence <- TRUE
    } else if (!paragraph_open && base::grepl("^(?: {4}|\\t)", line, perl = TRUE)) {
      # An indented block cannot interrupt an existing paragraph.
      is_fence <- TRUE
    }
    paragraph_open <- !is_fence && base::nzchar(base::trimws(line)) &&
      !base::grepl("^ {0,3}(?:#{1,6}[ \t]|[-*_]{3,}[ \t]*$)", line, perl = TRUE)
    if (!is_fence) next
    token <- base::paste0(token_prefix, index, "_")
    while (base::any(base::grepl(token, markup, fixed = TRUE))) {
      token <- base::paste0(token, "X")
    }
    masked[[index]] <- token
    originals[[token]] <- markup[[index]]
  }

  list(markup = masked, originals = originals)
}

r_notebook_restore_literal_markdown <- function(result, originals) {
  for (token in base::names(originals)) {
    position <- base::regexpr(token, result, fixed = TRUE)[[1L]]
    if (position > 0L) {
      result <- base::paste0(
        base::substr(result, 1L, position - 1L),
        originals[[token]],
        base::substr(
          result,
          position + base::nchar(token),
          base::nchar(result)
        )
      )
    }
  }
  result
}

r_notebook_inline_markdown <- function(markup, evaluation_env) {
  protected <- r_notebook_mask_literal_markdown(markup)
  parsed <- utils::getFromNamespace("parse_inline", "knitr")(
    protected$markup,
    utils::getFromNamespace("all_patterns", "knitr")$md
  )
  result <- utils::getFromNamespace("inline_exec", "knitr")(
    parsed,
    envir = evaluation_env
  )
  r_notebook_restore_literal_markdown(result, protected$originals)
}

r_notebook_render_text <- function(
  cells_path,
  native_document_path,
  output_dir,
  working_dir,
  evaluation_env,
  document_path = native_document_path
) {
  success <- FALSE
  base::on.exit(
    r_notebook_finish_request(output_dir, success, "native text render"),
    add = TRUE
  )

  tryCatch({
    if (!base::requireNamespace("knitr", quietly = TRUE)) {
      base::stop("The R package 'knitr' is required to render notebook text.")
    }
    if (!base::requireNamespace("jsonlite", quietly = TRUE)) {
      base::stop("The R package 'jsonlite' is required to render notebook text.")
    }
    knitr_state <- r_notebook_snapshot_knitr()
    base::on.exit(
      r_notebook_restore_knitr(knitr_state),
      add = TRUE
    )
    knitr::render_markdown()
    runtime <- base::getOption("vsc.r.notebook.runtime")
    if (base::is.environment(runtime)) {
      r_notebook_apply_session_state(runtime, runtime$knit_code)
    }

    previous_directory <- base::setwd(working_dir)
    base::on.exit(base::setwd(previous_directory), add = TRUE)

    format <- r_notebook_format(native_document_path)
    r_notebook_require_litedown()
    cells <- jsonlite::fromJSON(cells_path, simplifyVector = FALSE)
    document <- base::paste(base::readLines(
      native_document_path,
      warn = FALSE,
      encoding = "UTF-8"
    ), collapse = "\n")
    metadata <- format$metadata(native_document_path, evaluation_env, base::dirname(document_path))
    preview <- r_notebook_with_params(metadata, evaluation_env, function() {
      for (field in base::intersect(base::names(metadata), c("title", "subtitle", "author", "date"))) {
        if (base::is.character(metadata[[field]])) {
          metadata[[field]] <- base::vapply(metadata[[field]], function(value) {
            r_notebook_inline_markdown(value, evaluation_env)
          }, base::character(1))
        }
      }
      for (cell in cells) {
        rendered <- r_notebook_inline_markdown(
          base::strsplit(cell$source, "\n", fixed = TRUE)[[1L]], evaluation_env)
        parts <- base::strsplit(document, cell$token, fixed = TRUE)[[1L]]
        if (base::length(parts) != 2L) {
          base::stop("The native text snapshot contains an invalid cell boundary.")
        }
        document <- base::paste0(parts[[1L]], rendered, parts[[2L]])
      }
      list(document = document, metadata = metadata)
    })
    document <- preview$document
    metadata <- preview$metadata
    body <- r_notebook_partition_yaml(base::strsplit(document, "\n", fixed = TRUE)[[1L]])$body
    html <- r_notebook_litedown_html(base::paste(body, collapse = "\n"), metadata, outline = TRUE, format = format)
    html <- r_notebook_prepare_html(html)
    base::writeLines(
      html,
      base::file.path(output_dir, "result.html"),
      useBytes = TRUE
    )
    success <- TRUE
  }, error = function(error) {
    base::writeLines(
      base::conditionMessage(error),
      base::file.path(output_dir, "error.txt"),
      useBytes = TRUE
    )
  })
  base::invisible(success)
}
