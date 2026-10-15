r_notebook_knitr_managers <- function() {
  list(
    opts_chunk = knitr::opts_chunk,
    opts_knit = knitr::opts_knit,
    opts_hooks = knitr::opts_hooks,
    opts_template = knitr::opts_template,
    knit_hooks = knitr::knit_hooks,
    knit_engines = knitr::knit_engines
  )
}

r_notebook_snapshot_knitr <- function() {
  managers <- r_notebook_knitr_managers()
  state <- base::lapply(managers, function(manager) manager$get())
  state$knit_code <- knitr::knit_code$get()
  state
}

r_notebook_restore_knitr <- function(state) {
  managers <- r_notebook_knitr_managers()
  for (name in base::names(managers)) {
    managers[[name]]$restore(state[[name]])
  }
  knitr::knit_code$restore(state$knit_code)
  base::invisible()
}

r_notebook_apply_session_state <- function(runtime, knit_code) {
  managers <- r_notebook_knitr_managers()
  for (name in base::names(managers)) {
    patch <- runtime$manager_changes[[name]]
    if (base::length(patch$removed) > 0L) {
      managers[[name]]$delete(patch$removed)
    }
    if (base::length(patch$values) > 0L) {
      managers[[name]]$set(patch$values)
    }
  }
  knitr::knit_code$restore(knit_code)
  base::invisible()
}

r_notebook_capture_session_state <- function(
  runtime,
  before,
  cell_id,
  known_labels,
  automatic_labels
) {
  after <- r_notebook_snapshot_knitr()
  for (manager_name in base::names(runtime$manager_changes)) {
    before_values <- before[[manager_name]]
    after_values <- after[[manager_name]]
    keys <- base::union(base::names(before_values), base::names(after_values))
    patch <- runtime$manager_changes[[manager_name]]
    for (key in keys) {
      before_present <- key %in% base::names(before_values)
      after_present <- key %in% base::names(after_values)
      if (
        before_present &&
          after_present &&
          base::identical(before_values[[key]], after_values[[key]])
      ) {
        next
      }
      if (after_present) {
        patch$values[key] <- after_values[key]
        patch$removed <- base::setdiff(patch$removed, key)
      } else {
        patch$values[[key]] <- NULL
        patch$removed <- base::union(patch$removed, key)
      }
    }
    runtime$manager_changes[[manager_name]] <- patch
  }

  named_code <- after$knit_code[base::setdiff(
    base::names(after$knit_code),
    automatic_labels
  )]
  runtime$knit_code <- named_code

  available_labels <- base::names(named_code)
  if (base::is.null(available_labels)) {
    available_labels <- base::character()
  }
  for (stored_cell in base::names(runtime$cell_labels)) {
    runtime$cell_labels[[stored_cell]] <- base::intersect(
      runtime$cell_labels[[stored_cell]],
      available_labels
    )
  }
  runtime$cell_labels[[cell_id]] <- base::setdiff(
    available_labels,
    known_labels
  )
  base::invisible()
}

r_notebook_data_frame_type <- function(value) {
  if (base::is.ordered(value)) {
    return("ord")
  }
  if (base::is.factor(value)) {
    return("fctr")
  }
  if (base::inherits(value, "IDate")) {
    return("IDat")
  }
  if (base::inherits(value, "Date")) {
    return("Date")
  }
  if (base::inherits(value, "POSIXt")) {
    return("POSc")
  }
  if (base::inherits(value, "integer64")) {
    return("i64")
  }
  switch(
    base::typeof(value),
    logical = "lgcl",
    integer = "int",
    double = "num",
    complex = "cplx",
    character = "char",
    raw = "raw",
    list = "list",
    expression = "expr",
    base::typeof(value)
  )
}

r_notebook_compact_data_frame <- function(value, compact = TRUE) {
  row_count <- base::nrow(value)
  column_count <- base::ncol(value)
  edge_count <- 10L
  omitted_count <- if (base::isTRUE(compact)) {
    base::max(0L, row_count - edge_count * 2L)
  } else {
    0L
  }
  displayed_rows <- if (omitted_count > 0L) {
    c(
      base::seq_len(edge_count),
      base::seq.int(row_count - edge_count + 1L, row_count)
    )
  } else {
    base::seq_len(row_count)
  }
  displayed <- base::as.data.frame(
    value[displayed_rows, , drop = FALSE]
  )
  base::row.names(displayed) <- displayed_rows
  summary <- base::sprintf(
    "%s rows × %s columns%s",
    base::format(row_count, big.mark = ",", scientific = FALSE),
    base::format(column_count, big.mark = ",", scientific = FALSE),
    if (omitted_count > 0L) {
      base::sprintf(
        " — first %d and last %d shown; %s rows omitted",
        edge_count,
        edge_count,
        base::format(omitted_count, big.mark = ",", scientific = FALSE)
      )
    } else {
      ""
    }
  )
  table <- knitr::kable(displayed, format = "html", escape = TRUE, row.names = TRUE)
  table_parts <- base::strsplit(table, "</tr>", fixed = TRUE)[[1L]]
  type_row <- base::paste0(
    '\n  <tr class="vsc-r-notebook-data-frame-types"><th></th>',
    base::paste0(
      "<th>&lt;",
      base::vapply(value, r_notebook_data_frame_type, base::character(1L)),
      "&gt;</th>",
      collapse = ""
    )
  )
  table_parts <- base::append(table_parts, type_row, after = 1L)
  if (omitted_count > 0L) {
    separator <- base::paste0(
      '\n  <tr class="vsc-r-notebook-data-frame-break">',
      '<td><span>-</span><span>-</span><span>-</span></td>',
      base::paste0(base::rep("<td></td>", column_count), collapse = "")
    )
    table <- base::paste(base::append(
      table_parts,
      separator,
      after = edge_count + 2L
    ), collapse = "</tr>")
  } else {
    table <- base::paste(table_parts, collapse = "</tr>")
  }
  knitr::asis_output(base::paste0(
    "<style data-vsc-r-notebook-data-frame-theme>",
    ".vsc-r-notebook-data-frame{display:inline-block;max-width:100%;vertical-align:top}",
    ".vsc-r-notebook-data-frame-scroll{max-width:100%;max-height:28rem;overflow:auto}",
    ".vsc-r-notebook-data-frame table{border-collapse:collapse;width:auto!important;",
    "min-width:0!important;font-variant-numeric:tabular-nums}",
    ".vsc-r-notebook-data-frame th,.vsc-r-notebook-data-frame td{padding:.2rem .5rem;",
    "white-space:nowrap;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35))}",
    ".vsc-r-notebook-data-frame thead th{position:sticky;top:0;z-index:1;",
    "background:var(--vscode-editor-background)}",
    ".vsc-r-notebook-data-frame-types th{top:1.65rem!important;color:",
    "var(--vscode-descriptionForeground);font-size:.85em;font-weight:400}",
    ".vsc-r-notebook-data-frame-break td:first-child{text-align:center;color:",
    "var(--vscode-descriptionForeground);font-weight:600}",
    ".vsc-r-notebook-data-frame-summary{margin-top:.25rem;",
    "color:var(--vscode-descriptionForeground);font-size:.9em}</style>",
    "<div class=\"vsc-r-notebook-data-frame\">",
    "<div class=\"vsc-r-notebook-data-frame-scroll\">",
    table,
    "</div>",
    "<div class=\"vsc-r-notebook-data-frame-summary\">",
    summary,
    "</div></div>"
  ))
}

r_notebook_compact_data_frame_source <- function(source) {
  expressions <- tryCatch(
    base::parse(text = base::paste(source, collapse = "\n")),
    error = function(...) NULL
  )
  if (base::length(expressions) != 1L) {
    return(TRUE)
  }
  expression <- expressions[[1L]]
  while (
    base::is.call(expression) &&
      base::is.symbol(expression[[1L]]) &&
      base::as.character(expression[[1L]]) %in% c("(", "%>%")
  ) {
    expression <- expression[[if (
      base::identical(expression[[1L]], base::as.name("("))
    ) 2L else 3L]]
  }
  if (!base::is.call(expression)) {
    return(TRUE)
  }
  target <- expression[[1L]]
  function_name <- if (base::is.symbol(target)) {
    base::as.character(target)
  } else if (
    base::is.call(target) &&
      base::as.character(target[[1L]]) %in% c("::", ":::")
  ) {
    base::as.character(target[[3L]])
  } else {
    ""
  }
  !function_name %in% c("head", "tail")
}

r_notebook_install_knit_capture <- function(runtime, cell_id, generated_labels) {
  previous_labels <- runtime$cell_labels[[cell_id]]
  if (base::is.null(previous_labels)) {
    previous_labels <- base::character()
  }
  execution_code <- runtime$knit_code
  execution_code[previous_labels] <- NULL
  known_labels <- base::names(execution_code)
  if (base::is.null(known_labels)) {
    known_labels <- base::character()
  }

  capture <- base::new.env(parent = base::emptyenv())
  capture$called <- FALSE
  capture$error <- NULL
  hook <- function(input) {
    capture$called <- TRUE
    tryCatch({
      r_notebook_apply_session_state(runtime, execution_code)
      render_context <- utils::getFromNamespace(
        "render_context",
        "rmarkdown"
      )()
      render_state <- base::new.env(parent = base::emptyenv())
      render_state$compact_data_frame <- TRUE
      if (base::is.environment(render_context)) {
        render_context$df_print <- function(value) {
          r_notebook_compact_data_frame(
            value,
            compact = render_state$compact_data_frame
          )
        }
      }
      previous_evaluate <- knitr::knit_hooks$get("evaluate")
      previous_chunk <- knitr::knit_hooks$get("chunk")
      previous_source <- knitr::knit_hooks$get("source")
      previous_plot <- knitr::knit_hooks$get("plot")
      if (!base::is.function(previous_evaluate)) {
        base::stop("knitr did not provide its native evaluation hook.")
      }

      knit_baseline <- NULL
      evaluate_wrapper <- function(...) {
        base::on.exit(r_notebook_capture_session_state(
          runtime,
          knit_baseline,
          cell_id,
          known_labels,
          generated_labels$values
        ), add = TRUE)
        arguments <- list(...)
        render_state$compact_data_frame <- TRUE
        output_handler <- arguments$output_handler
        if (
          base::inherits(output_handler, "output_handler") &&
            base::is.function(output_handler$source)
        ) {
          previous_source_handler <- output_handler$source
          output_handler$source <- function(source) {
            render_state$compact_data_frame <-
              r_notebook_compact_data_frame_source(source)
            previous_source_handler(source)
          }
          arguments$output_handler <- output_handler
        }
        base::do.call(previous_evaluate, arguments)
      }
      chunk_wrapper <- function(output, options) {
        base::on.exit(r_notebook_capture_session_state(
          runtime,
          knit_baseline,
          cell_id,
          known_labels,
          generated_labels$values
        ), add = TRUE)
        rendered <- if (base::is.function(previous_chunk)) {
          previous_chunk(output, options)
        } else {
          output
        }
        width_location <- base::regexpr(
          "--vsc-r-notebook-plot-width:[^;\"[:space:]]+",
          output,
          perl = TRUE
        )
        if (
          !base::is.character(rendered) ||
            width_location[[1L]] < 0L
        ) {
          return(rendered)
        }
        logical_width <- base::regmatches(output, width_location)
        cell_marker <- "::: {.cell"
        base::sub(
          cell_marker,
          base::paste0(cell_marker, " style=\"", logical_width, "\""),
          rendered,
          fixed = TRUE
        )
      }
      source_wrapper <- function(source, options) {
        if (base::is.function(previous_source)) {
          previous_source(source, options)
        }
        ""
      }
      plot_wrapper <- function(path, options) {
        device_width <- tryCatch(
          grDevices::dev.size("in")[[1L]],
          error = function(error) NA_real_
        )
        output <- if (base::is.function(previous_plot)) {
          previous_plot(path, options)
        } else {
          path
        }
        native_output_width <- options[["out.width"]]
        has_explicit_output_size <- (
          !base::is.null(native_output_width) &&
            !base::is.numeric(native_output_width)
        ) || !base::is.null(options[["out.height"]])
        if (
          has_explicit_output_size ||
            !base::is.character(output) ||
            !base::is.finite(device_width) ||
            device_width <= 0
        ) {
          return(output)
        }
        marker <- "::: {.cell-output-display}"
        replacement <- base::paste0(
          "::: {.cell-output-display style=\"",
          "--vsc-r-notebook-plot-width:",
          base::format(device_width, trim = TRUE, scientific = FALSE),
          "in\"}"
        )
        base::sub(marker, replacement, output, fixed = TRUE)
      }
      knitr::knit_hooks$set(
        evaluate = evaluate_wrapper,
        chunk = chunk_wrapper,
        source = source_wrapper,
        plot = plot_wrapper
      )
      knit_baseline <- r_notebook_snapshot_knitr()
    }, error = function(error) {
      capture$error <- error
    })
    base::invisible()
  }

  previous_hooks <- base::getHook("rmarkdown.onKnit")
  base::setHook("rmarkdown.onKnit", hook, action = "append")
  list(previous_hooks = previous_hooks, capture = capture)
}

r_notebook_quarto_executable <- function(configured) {
  quarto <- if (base::nzchar(configured)) configured else base::Sys.which("quarto")
  if (!base::nzchar(quarto)) {
    base::stop(base::paste(
      "Quarto is required for Quarto notebooks.",
      "Set r.notebook.quartoPath or add Quarto to the R session's PATH."
    ))
  }
  base::unname(quarto)
}

r_notebook_quarto_configuration <- function(document_path) {
  directory <- base::normalizePath(
    base::dirname(document_path),
    mustWork = FALSE
  )
  repeat {
    candidates <- base::file.path(
      directory,
      c("_quarto.yml", "_quarto.yaml")
    )
    configuration_files <- candidates[base::file.exists(candidates)]
    if (base::length(configuration_files) > 0L) {
      return(base::lapply(configuration_files, function(configuration_file) {
        list(
          path = base::normalizePath(configuration_file, mustWork = FALSE),
          content = base::readLines(
            configuration_file,
            warn = FALSE,
            encoding = "UTF-8"
          )
        )
      }))
    }

    parent <- base::normalizePath(base::dirname(directory), mustWork = FALSE)
    if (base::identical(parent, directory)) {
      return(list())
    }
    directory <- parent
  }
}

r_notebook_quarto_context <- function(
  runtime,
  document_path,
  output_dir,
  quarto_executable
) {
  quarto <- r_notebook_quarto_executable(quarto_executable)
  if (
    base::is.null(runtime$quarto_environment) ||
      !base::identical(runtime$quarto, quarto)
  ) {
    if (!base::requireNamespace("jsonlite", quietly = TRUE)) {
      base::stop("The R package 'jsonlite' is required for Quarto execution.")
    }

    quarto_paths <- base::suppressWarnings(base::system2(
      quarto,
      "--paths",
      stdout = TRUE,
      stderr = TRUE
    ))
    resource_candidates <- quarto_paths[base::vapply(quarto_paths, function(candidate) {
      base::file.exists(base::file.path(candidate, "rmd", "hooks.R"))
    }, base::logical(1))]
    pandoc_candidates <- quarto_paths[base::vapply(quarto_paths, function(candidate) {
      base::dir.exists(base::file.path(candidate, "tools"))
    }, base::logical(1))]
    if (base::length(resource_candidates) == 0L) {
      base::stop("Quarto's native R support files could not be found.")
    }
    if (base::length(pandoc_candidates) == 0L) {
      base::stop("Quarto's bundled Pandoc could not be found.")
    }

    runtime$quarto <- quarto
    runtime$quarto_resource_dir <- resource_candidates[[1L]]
    runtime$quarto_pandoc_dir <- base::file.path(
      pandoc_candidates[[1L]],
      "tools"
    )
    runtime$quarto_pandoc_configured <- FALSE
    runtime$quarto_front_matter <- NULL
    runtime$quarto_document_directory <- NULL
    runtime$quarto_configuration <- NULL
    runtime$quarto_context <- NULL
    runtime$quarto_environment <- base::new.env(parent = base::globalenv())
    for (support_file in c("patch.R", "execute.R", "hooks.R")) {
      base::sys.source(
        base::file.path(runtime$quarto_resource_dir, "rmd", support_file),
        runtime$quarto_environment
      )
    }
  }

  front_matter <- base::paste(
    r_notebook_front_matter(document_path),
    collapse = "\n"
  )
  document_directory <- base::normalizePath(
    base::dirname(document_path),
    mustWork = FALSE
  )
  configuration <- r_notebook_quarto_configuration(document_path)
  if (
    base::identical(runtime$quarto_front_matter, front_matter) &&
      base::identical(runtime$quarto_document_directory, document_directory) &&
      base::identical(runtime$quarto_configuration, configuration) &&
      !base::is.null(runtime$quarto_context)
  ) {
    return(runtime$quarto_context)
  }

  inspect_path <- base::file.path(output_dir, "quarto-inspect.json")
  inspect_output <- base::suppressWarnings(base::system2(
    runtime$quarto,
    c("inspect", base::shQuote(document_path), base::shQuote(inspect_path)),
    stdout = TRUE,
    stderr = TRUE
  ))
  inspect_status <- base::attr(inspect_output, "status")
  if (base::is.null(inspect_status)) {
    inspect_status <- 0L
  }
  if (!base::identical(base::as.integer(inspect_status), 0L) || !base::file.exists(inspect_path)) {
    base::stop(base::paste(c(
      "Quarto could not inspect the notebook configuration.",
      inspect_output
    ), collapse = "\n"))
  }

  inspection <- jsonlite::fromJSON(inspect_path, simplifyVector = TRUE)
  formats <- inspection$formats
  if (base::is.null(formats) || base::length(formats) == 0L) {
    base::stop("Quarto did not return a document format for this notebook.")
  }
  context <- list(
    format = formats[[1L]],
    environment = runtime$quarto_environment,
    project_dir = inspection$project$dir
  )
  runtime$quarto_front_matter <- front_matter
  runtime$quarto_document_directory <- document_directory
  runtime$quarto_configuration <- configuration
  runtime$quarto_context <- context
  context
}

r_notebook_initialize_runtime <- function(document_path) {
  runtime <- base::getOption("vsc.r.notebook.runtime")
  normalized_document <- base::normalizePath(document_path, mustWork = FALSE)
  if (
    base::is.environment(runtime) &&
      base::identical(runtime$document_path, normalized_document)
  ) {
    return(runtime)
  }

  knitr::render_markdown()
  runtime <- base::new.env(parent = base::emptyenv())
  runtime$document_path <- normalized_document
  runtime$base_knitr_state <- r_notebook_snapshot_knitr()
  manager_names <- base::names(r_notebook_knitr_managers())
  runtime$manager_changes <- stats::setNames(base::rep(
    list(list(values = list(), removed = character())),
    base::length(manager_names)
  ), manager_names)
  runtime$knit_code <- list()
  runtime$cell_labels <- list()
  runtime$execution_dir <- base::tempfile("vsc-r-notebook-session-")
  if (!base::dir.create(runtime$execution_dir, recursive = TRUE)) {
    base::stop("Could not create the notebook session execution directory.")
  }
  base::options("vsc.r.notebook.runtime" = runtime)
  runtime
}

r_notebook_front_matter <- function(document_path) {
  lines <- base::readLines(document_path, warn = FALSE, encoding = "UTF-8")
  rmarkdown:::partition_yaml_front_matter(lines)$front_matter
}

r_notebook_align_leading_chunk_options <- function(lines) {
  if (base::length(lines) < 3L) {
    return(lines)
  }
  body <- lines[2L:(base::length(lines) - 1L)]
  first_content <- base::which(base::nzchar(base::trimws(body)))[1L]
  if (
    base::is.na(first_content) ||
      first_content <= 1L ||
      !base::grepl("^[[:space:]]*#\\|", body[[first_content]])
  ) {
    return(lines)
  }

  option_lines <- base::grepl(
    "^[[:space:]]*#\\|",
    body[first_content:base::length(body)]
  )
  first_non_option <- base::which(!option_lines)[1L]
  option_end <- if (base::is.na(first_non_option)) {
    base::length(body)
  } else {
    first_content + first_non_option - 2L
  }
  remaining <- if (option_end < base::length(body)) {
    body[(option_end + 1L):base::length(body)]
  } else {
    base::character()
  }
  c(
    lines[[1L]],
    body[first_content:option_end],
    body[base::seq_len(first_content - 1L)],
    remaining,
    lines[[base::length(lines)]]
  )
}

r_notebook_without_front_matter <- function(markdown, context_marker) {
  lines <- base::strsplit(markdown, "\n", fixed = TRUE)[[1L]]
  parts <- rmarkdown:::partition_yaml_front_matter(lines)
  if (
    !base::is.null(parts$front_matter) &&
      context_marker %in% parts$front_matter
  ) {
    return(base::paste(parts$body, collapse = "\n"))
  }
  markdown
}

r_notebook_rmarkdown_html_format <- function(document_path) {
  if (
    !base::requireNamespace("rmarkdown", quietly = TRUE) ||
      !rmarkdown::pandoc_available(error = FALSE)
  ) {
    base::stop("The R package 'rmarkdown' and Pandoc are required to render R Markdown.")
  }

  configured_output <- rmarkdown::default_output_format(document_path)$name
  uses_bookdown <- base::grepl("^bookdown::", configured_output)
  if (
    uses_bookdown &&
      !base::requireNamespace("bookdown", quietly = TRUE)
  ) {
    base::stop("The R package 'bookdown' is required by this R Markdown output format.")
  }

  format <- if (uses_bookdown) {
    bookdown::html_document2(
      self_contained = TRUE,
      theme = NULL,
      highlight = NULL
    )
  } else {
    rmarkdown::html_document(
      self_contained = TRUE,
      theme = NULL,
      highlight = NULL
    )
  }

  format$knitr$opts_chunk$comment <- ""
  native_pre_processor <- format$pre_processor
  format$pre_processor <- function(...) {
    c(
      if (base::is.function(native_pre_processor)) {
        native_pre_processor(...)
      } else {
        base::character()
      },
      "--mathml"
    )
  }
  format$knitr$opts_chunk$fig.id <- function(options) {
    label <- options[["label"]]
    figure_index <- options[["fig.cur"]]
    if (
      !base::is.character(label) ||
        base::length(label) != 1L ||
        !base::grepl("^[A-Za-z][A-Za-z0-9_.:-]*$", label) ||
        (
          !base::is.null(figure_index) &&
            !base::identical(base::as.integer(figure_index), 1L)
        )
    ) {
      return("")
    }
    base::paste0('id="', label, '"')
  }
  format
}

r_notebook_prepare_html <- function(
  html,
  quarto_output,
  rmarkdown_cell_output = FALSE
) {
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

  output_style <- if (base::isTRUE(quarto_output)) {
    base::paste0(
      "<style>",
      ".cell-output-stdout pre code,.cell-output-stderr pre code{",
      "background-color:transparent}",
      ".cell-output-display[style*=\"--vsc-r-notebook-plot-width\"] img{",
      "width:var(--vsc-r-notebook-plot-width);max-width:100%;height:auto}",
      ".cell[style*=\"--vsc-r-notebook-plot-width\"] .quarto-layout-row{",
      "width:var(--vsc-r-notebook-plot-width);max-width:100%}",
      ".quarto-layout-cell img{width:100%;height:auto}",
      "</style>"
    )
  } else if (base::isTRUE(rmarkdown_cell_output)) {
    "<style>pre code{background-color:transparent}</style>"
  } else {
    ""
  }
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

r_notebook_system_succeeded <- function(output) {
  status <- base::attr(output, "status")
  base::is.null(status) || base::identical(base::as.integer(status), 0L)
}

r_notebook_render_html <- function(
  result,
  execution_dir,
  quarto,
  quarto_resource_dir,
  resource_dirs
) {
  html_path <- base::file.path(execution_dir, "notebook-output.html")
  if (base::file.exists(html_path)) {
    base::unlink(html_path)
  }

  if (base::nzchar(quarto)) {
    if (!base::requireNamespace("jsonlite", quietly = TRUE)) {
      base::stop("The R package 'jsonlite' is required to present notebook output.")
    }
    html_format <- list(theme = "none")
    html_format[["highlight-style"]] <- "none"
    html_format[["embed-resources"]] <- TRUE
    for (include_name in base::names(result$includes)) {
      html_format[[include_name]] <- base::as.character(result$includes[[include_name]])
    }
    presentation <- list(
      format = list(html = html_format),
      execute = list(enabled = FALSE)
    )
    filters <- base::as.character(result$filters)
    if (base::length(filters) > 0L) {
      filters <- base::vapply(filters, function(filter) {
        source_candidates <- base::file.path(resource_dirs, filter)
        source_candidate <- source_candidates[
          base::file.exists(source_candidates)
        ][1L]
        resource_candidate <- base::file.path(
          quarto_resource_dir,
          "filters",
          filter
        )
        if (base::file.exists(filter)) {
          filter
        } else if (
          base::length(source_candidate) > 0L &&
            !base::is.na(source_candidate)
        ) {
          source_candidate
        } else if (base::file.exists(resource_candidate)) {
          resource_candidate
        } else {
          filter
        }
      }, base::character(1))
      presentation$filters <- base::as.list(base::unname(filters))
    }
    presentation_path <- base::file.path(execution_dir, "notebook-output.qmd")
    presentation_metadata_path <- base::file.path(execution_dir, "_metadata.yml")
    metadata <- jsonlite::toJSON(
      presentation,
      auto_unbox = TRUE,
      pretty = TRUE
    )
    base::writeLines(metadata, presentation_metadata_path, useBytes = TRUE)
    base::on.exit(base::unlink(presentation_metadata_path), add = TRUE)
    base::writeLines(c(
      "<div hidden data-vsc-r-notebook-output-boundary></div>",
      "",
      result$markdown
    ), presentation_path, useBytes = TRUE)
    render_output <- base::suppressWarnings(base::system2(
      quarto,
      c("render", base::shQuote(presentation_path), "--quiet"),
      stdout = TRUE,
      stderr = TRUE
    ))
    if (!r_notebook_system_succeeded(render_output) || !base::file.exists(html_path)) {
      base::stop(base::paste(c(
        "Quarto could not present the native cell output for VS Code.",
        render_output
      ), collapse = "\n"))
    }
    return(base::paste(base::readLines(
      html_path,
      warn = FALSE,
      encoding = "UTF-8"
    ), collapse = "\n"))
  }

  if (
    !base::requireNamespace("rmarkdown", quietly = TRUE) ||
      !rmarkdown::pandoc_available(error = FALSE)
  ) {
    base::stop("Quarto or Pandoc is required to present native notebook output.")
  }
  markdown_path <- base::file.path(execution_dir, "notebook-output.md")
  base::writeLines(result$markdown, markdown_path, useBytes = TRUE)
  include_arguments <- base::character()
  header_files <- result$includes[["include-in-header"]]
  if (base::length(header_files) > 0L) {
    for (header_file in header_files) {
      include_arguments <- c(
        include_arguments,
        "--include-in-header",
        rmarkdown:::pandoc_path_arg(header_file)
      )
    }
  }
  rmarkdown::pandoc_convert(
    input = markdown_path,
    to = "html5",
    output = html_path,
    options = c(
      "--standalone",
      "--embed-resources",
      "--metadata",
      "document-css=false",
      include_arguments
    )
  )
  base::paste(base::readLines(
    html_path,
    warn = FALSE,
    encoding = "UTF-8"
  ), collapse = "\n")
}

r_notebook_render_rmarkdown_html <- function(
  result,
  execution_dir,
  document_path
) {
  markdown_path <- base::file.path(execution_dir, "notebook-output.md")
  base::writeLines(result$markdown, markdown_path, useBytes = TRUE)
  rendered_path <- rmarkdown::render(
    input = markdown_path,
    output_format = r_notebook_rmarkdown_html_format(document_path),
    output_file = "notebook-output.html",
    output_dir = execution_dir,
    knit_meta = result$knit_meta,
    clean = TRUE,
    quiet = TRUE
  )
  base::paste(base::readLines(
    rendered_path,
    warn = FALSE,
    encoding = "UTF-8"
  ), collapse = "\n")
}

r_notebook_inline_markdown <- function(markup, evaluation_env) {
  parsed <- utils::getFromNamespace("parse_inline", "knitr")(
    markup,
    utils::getFromNamespace("all_patterns", "knitr")$md
  )
  utils::getFromNamespace("inline_exec", "knitr")(
    parsed,
    envir = evaluation_env
  )
}

r_notebook_finish_request <- function(output_dir, success, request_name) {
  temporary <- base::file.path(output_dir, ".done")
  base::writeLines(
    if (base::isTRUE(success)) "true" else "false",
    temporary,
    useBytes = TRUE
  )
  if (!base::file.rename(temporary, base::file.path(output_dir, "done"))) {
    base::stop(base::paste("Could not finish the", request_name, "request"))
  }
}

r_notebook_render_text <- function(
  cells_path,
  native_document_path,
  output_dir,
  working_dir,
  evaluation_env,
  quarto_executable = ""
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

    extension <- base::tolower(tools::file_ext(native_document_path))
    cells <- jsonlite::fromJSON(cells_path, simplifyVector = FALSE)
    document <- base::paste(base::readLines(
      native_document_path,
      warn = FALSE,
      encoding = "UTF-8"
    ), collapse = "\n")
    for (cell in cells) {
      rendered <- if (base::identical(extension, "qmd")) {
        r_notebook_inline_markdown(
          base::strsplit(cell$source, "\n", fixed = TRUE)[[1L]],
          evaluation_env
        )
      } else {
        cell$source
      }
      parts <- base::strsplit(document, cell$token, fixed = TRUE)[[1L]]
      if (base::length(parts) != 2L) {
        base::stop("The native text snapshot contains an invalid cell boundary.")
      }
      document <- base::paste0(parts[[1L]], rendered, parts[[2L]])
    }
    base::writeLines(document, native_document_path, useBytes = TRUE)

    if (base::identical(extension, "qmd")) {
      quarto <- r_notebook_quarto_executable(quarto_executable)
      base::setwd(base::dirname(native_document_path))
      quarto_html_path <- base::file.path(output_dir, "quarto-text.html")
      quarto_error_path <- base::file.path(output_dir, "quarto-text-error.txt")
      base::on.exit(base::unlink(c(quarto_html_path, quarto_error_path)), add = TRUE)
      render_status <- base::suppressWarnings(base::system2(
        quarto,
        c(
          "render",
          base::shQuote(base::basename(native_document_path)),
          "--to", "html",
          "--no-execute",
          "--quiet",
          "--output", "-",
          "--metadata", "embed-resources:true",
          "--metadata", "theme:none",
          "--metadata", "highlight-style:none",
          "--metadata", "html-math-method:mathml"
        ),
        stdout = quarto_html_path,
        stderr = quarto_error_path
      ))
      render_errors <- if (base::file.exists(quarto_error_path)) {
        base::readLines(quarto_error_path, warn = FALSE, encoding = "UTF-8")
      } else {
        base::character()
      }
      if (
        !base::identical(base::as.integer(render_status), 0L) ||
          !base::file.exists(quarto_html_path)
      ) {
        base::stop(base::paste(c(
          "Quarto could not render the notebook text.",
          render_errors
        ), collapse = "\n"))
      }
      html <- base::paste(base::readLines(
        quarto_html_path,
        warn = FALSE,
        encoding = "UTF-8"
      ), collapse = "\n")
    } else {
      rendered_path <- rmarkdown::render(
        input = native_document_path,
        output_format = r_notebook_rmarkdown_html_format(native_document_path),
        output_file = "result.html",
        output_dir = output_dir,
        intermediates_dir = output_dir,
        envir = evaluation_env,
        knit_root_dir = working_dir,
        clean = TRUE,
        quiet = TRUE
      )
      html <- base::paste(base::readLines(
        rendered_path,
        warn = FALSE,
        encoding = "UTF-8"
      ), collapse = "\n")
      html <- base::gsub(
        'href="#(?:fig|tab):([^"]+)"',
        'href="#\\1"',
        html,
        perl = TRUE
      )
    }
    html <- r_notebook_prepare_html(
      html,
      quarto_output = base::identical(extension, "qmd")
    )
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

r_notebook_execute <- function(
  chunk_path,
  document_path,
  native_document_path,
  document_id,
  cell_id,
  cell_key,
  output_dir,
  working_dir,
  evaluation_env,
  quarto_executable = ""
) {
  output_index <- 0L
  success <- TRUE

  emit_text <- function(kind, mime, text, name = NULL) {
    output_index <<- output_index + 1L
    output_name <- base::sprintf("%06d", output_index)
    payload_name <- base::paste0(output_name, ".txt")
    payload_path <- base::file.path(output_dir, payload_name)
    base::writeChar(
      base::paste0(text, collapse = ""),
      payload_path,
      eos = NULL,
      useBytes = TRUE
    )
    metadata <- c(
      base::paste0("kind: ", kind),
      base::paste0("mime: ", mime),
      base::paste0("file: ", payload_name)
    )
    if (!base::is.null(name)) {
      metadata <- c(metadata, base::paste0("name: ", name))
    }
    base::writeLines(
      metadata,
      base::file.path(output_dir, base::paste0(output_name, ".meta")),
      useBytes = TRUE
    )
  }

  base::on.exit(
    r_notebook_finish_request(output_dir, success, "notebook execution"),
    add = TRUE
  )

  tryCatch({
    if (!base::requireNamespace("knitr", quietly = TRUE)) {
      base::stop("The R package 'knitr' is required for native notebook execution.")
    }
    if (!base::requireNamespace("rmarkdown", quietly = TRUE)) {
      base::stop("The R package 'rmarkdown' is required for native notebook execution.")
    }
    if (utils::packageVersion("knitr") < "1.44") {
      base::stop("Native R Markdown and Quarto cell options require knitr 1.44 or newer.")
    }

    if (
      base::identical(
        base::Sys.getenv("VSCODE_R_NOTEBOOK_R_EXTENSION_INTEGRATION"),
        "0"
      ) &&
        !base::exists("View", envir = evaluation_env, inherits = FALSE)
    ) {
      inline_view <- function(x, title = base::deparse(base::substitute(x))) x
      base::assign("View", inline_view, envir = evaluation_env)
      base::on.exit({
        current_view <- base::get0(
          "View",
          envir = evaluation_env,
          inherits = FALSE
        )
        if (base::identical(current_view, inline_view)) {
          base::rm("View", envir = evaluation_env)
        }
      }, add = TRUE)
    }

    runtime <- r_notebook_initialize_runtime(document_path)
    r_notebook_restore_knitr(runtime$base_knitr_state)
    base::on.exit(
      r_notebook_restore_knitr(runtime$base_knitr_state),
      add = TRUE
    )
    if (!base::identical(runtime$document_id, document_id)) {
      runtime$document_id <- document_id
      runtime$knit_code <- list()
      runtime$cell_labels <- list()
    }

    execution_dir <- base::file.path(runtime$execution_dir, cell_key)
    if (!base::dir.exists(execution_dir) && !base::dir.create(execution_dir, recursive = TRUE)) {
      base::stop("Could not create the cell execution directory.")
    }
    extension <- base::tolower(tools::file_ext(document_path))
    execution_path <- base::file.path(
      execution_dir,
      if (base::identical(extension, "qmd")) "cell.qmd" else "cell.rmd"
    )

    front_matter <- r_notebook_front_matter(native_document_path)
    context_marker <- base::paste0("# vsc-r-notebook-context: ", cell_key)
    if (base::length(front_matter) > 1L) {
      front_matter <- base::append(
        front_matter,
        context_marker,
        after = base::length(front_matter) - 1L
      )
    }
    chunk_lines <- r_notebook_align_leading_chunk_options(base::readLines(
      chunk_path,
      warn = FALSE,
      encoding = "UTF-8"
    ))
    execution_lines <- c(
      front_matter,
      if (base::length(front_matter)) "" else NULL,
      chunk_lines
    )
    base::writeLines(execution_lines, execution_path, useBytes = TRUE)

    generated_labels <- base::new.env(parent = base::emptyenv())
    generated_labels$values <- base::character()
    native_unnamed_chunk <- utils::getFromNamespace("unnamed_chunk", "knitr")
    native_parse_block <- utils::getFromNamespace("parse_block", "knitr")
    tracked_unnamed_chunk <- function(...) {
      label <- native_unnamed_chunk(...)
      if (base::identical(base::sys.function(-1L), native_parse_block)) {
        generated_labels$values <- base::union(generated_labels$values, label)
      }
      label
    }
    utils::assignInNamespace("unnamed_chunk", tracked_unnamed_chunk, ns = "knitr")
    base::on.exit(utils::assignInNamespace(
      "unnamed_chunk",
      native_unnamed_chunk,
      ns = "knitr"
    ), add = TRUE)

    capture <- r_notebook_install_knit_capture(
      runtime,
      cell_id,
      generated_labels
    )
    base::on.exit(base::setHook(
      "rmarkdown.onKnit",
      capture$previous_hooks,
      action = "replace"
    ), add = TRUE)
    if (base::identical(extension, "qmd")) {
      quarto <- r_notebook_quarto_context(
        runtime,
        native_document_path,
        output_dir,
        quarto_executable
      )
      presentation_resource_dirs <- base::unique(c(
        base::dirname(native_document_path),
        working_dir,
        quarto$project_dir
      ))
      if (base::requireNamespace("htmlwidgets", quietly = TRUE)) {
        original_widget_sizing <- utils::getFromNamespace(
          "resolveSizing",
          "htmlwidgets"
        )
        base::on.exit(utils::assignInNamespace(
          "resolveSizing",
          original_widget_sizing,
          ns = "htmlwidgets"
        ), add = TRUE)
      }
      native_presentation_filters <- base::as.character(
        quarto$format$pandoc$filters
      )
      had_inline_renderer <- base::exists(
        ".QuartoInlineRender",
        envir = base::.GlobalEnv,
        inherits = FALSE
      )
      if (had_inline_renderer) {
        previous_inline_renderer <- base::get(
          ".QuartoInlineRender",
          envir = base::.GlobalEnv,
          inherits = FALSE
        )
      }
      result <- tryCatch(
        quarto$environment$execute(
          input = execution_path,
          format = quarto$format,
          tempDir = execution_dir,
          libDir = base::file.path(execution_dir, "dependencies"),
          dependencies = TRUE,
          cwd = working_dir,
          params = NULL,
          resourceDir = runtime$quarto_resource_dir,
          handledLanguages = base::character(),
          markdown = base::paste(execution_lines, collapse = "\n")
        ),
        finally = {
          if (had_inline_renderer) {
            base::assign(
              ".QuartoInlineRender",
              previous_inline_renderer,
              envir = base::.GlobalEnv
            )
          } else if (base::exists(
            ".QuartoInlineRender",
            envir = base::.GlobalEnv,
            inherits = FALSE
          )) {
            base::rm(".QuartoInlineRender", envir = base::.GlobalEnv)
          }
        }
      )
      result$markdown <- r_notebook_without_front_matter(
        result$markdown,
        context_marker
      )
      result$filters <- c(quarto$format$pandoc$filters, result$filters)
    } else {
      render_output <- rmarkdown::render(
        input = execution_path,
        output_format = r_notebook_rmarkdown_html_format(
          native_document_path
        ),
        knit_root_dir = working_dir,
        run_pandoc = FALSE,
        envir = evaluation_env,
        clean = FALSE,
        quiet = TRUE
      )
      markdown_path <- render_output
      if (!base::file.exists(markdown_path)) {
        markdown_path <- base::file.path(execution_dir, render_output)
      }
      markdown <- base::paste(base::readLines(
        markdown_path,
        warn = FALSE,
        encoding = "UTF-8"
      ), collapse = "\n")
      result <- list(
        markdown = r_notebook_without_front_matter(
          markdown,
          context_marker
        ),
        knit_meta = base::attr(render_output, "knit_meta")
      )
    }

    if (!base::is.null(capture$capture$error)) {
      base::stop(capture$capture$error)
    }
    if (!base::isTRUE(capture$capture$called)) {
      base::stop("The native R Markdown knit hook was not reached.")
    }

    if (
      !base::is.null(result$markdown) &&
        base::grepl(
          "^[[:space:]]*::: \\{\\.cell(?:[[:space:]][^}]*)?\\}[[:space:]]*:::[[:space:]]*$",
          result$markdown,
          perl = TRUE
        )
    ) {
      result$markdown <- ""
    }

    html <- result$html
    if (
      base::is.null(html) &&
        !base::is.null(result$markdown) &&
        base::length(result$markdown) == 1L &&
        !base::is.na(result$markdown) &&
        base::nzchar(base::trimws(result$markdown))
    ) {
      if (base::identical(extension, "qmd")) {
        plain_output <- base::grepl(
          base::paste0(
            "(?s)^[[:space:]]*::: \\{\\.cell\\}[[:space:]]*",
            "(?:::: \\{\\.cell-output \\.cell-output-(?:stdout|stderr)\\}",
            "[[:space:]]*```[^\\n]*\\n.*?\\n```[[:space:]]*:::[[:space:]]*)+",
            ":::[[:space:]]*$"
          ),
          result$markdown,
          perl = TRUE
        )
        presentation_command <- runtime$quarto
        if (
          plain_output &&
            base::nzchar(runtime$quarto) &&
            base::length(native_presentation_filters) == 0L &&
            base::length(result$includes) == 0L &&
            base::is.null(result$engineDependencies) &&
            base::dir.exists(runtime$quarto_pandoc_dir)
        ) {
          if (!base::isTRUE(runtime$quarto_pandoc_configured)) {
            rmarkdown::find_pandoc(
              cache = FALSE,
              dir = runtime$quarto_pandoc_dir
            )
            runtime$quarto_pandoc_configured <- TRUE
          }
          presentation_command <- ""
        }
        html <- r_notebook_render_html(
          result,
          execution_dir,
          presentation_command,
          runtime$quarto_resource_dir,
          presentation_resource_dirs
        )
      } else {
        html <- r_notebook_render_rmarkdown_html(
          result,
          execution_dir,
          native_document_path
        )
      }
    }
    if (!base::is.null(html) && base::nzchar(base::trimws(html))) {
      html <- r_notebook_prepare_html(
        html,
        quarto_output = base::identical(extension, "qmd"),
        rmarkdown_cell_output = base::identical(extension, "rmd")
      )
      emit_text(
        "display",
        "text/html",
        html
      )
    }
  }, error = function(error) {
    success <<- FALSE
    emit_text(
      "error",
      "application/vnd.code.notebook.error",
      base::conditionMessage(error),
      "R Notebook Error"
    )
  })
  base::invisible(success)
}
