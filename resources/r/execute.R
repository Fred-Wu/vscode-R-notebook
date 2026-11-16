# Shared knitr execution for R Markdown and Quarto notebook cells.
# Call once after sourcing this file into the request's private bridge environment.
r_notebook_load <- function(directory) {
  for (file in c("render.R", "rmd.R", "quarto.R")) {
    base::sys.source(base::file.path(directory, file), envir = base::environment(r_notebook_load))
  }
}

r_notebook_format <- function(document_path) {
  if (base::identical(base::tolower(tools::file_ext(document_path)), "qmd")) r_notebook_quarto else r_notebook_rmd
}

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
      render_state <- base::new.env(parent = base::emptyenv())
      render_state$compact_data_frame <- TRUE
      knitr::opts_chunk$set(render = function(x, options, ...) {
        data_frame <- base::inherits(x, "data.frame")
        custom <- data_frame && base::any(base::vapply(base::setdiff(base::class(x), "data.frame"), function(class) {
          base::is.function(base::get0(base::paste0("knit_print.", class), envir = knitr::knit_global(), mode = "function")) ||
            !base::is.null(utils::getS3method("knit_print", class, optional = TRUE, envir = base::asNamespace("knitr")))
        }, base::logical(1)))
        if (data_frame && !custom) {
          r_notebook_compact_data_frame(x, compact = render_state$compact_data_frame)
        } else {
          base::do.call(knitr::knit_print, c(list(x = x, options = options), list(...)), envir = knitr::knit_global())
        }
      })
      # Explicit user render options take precedence over the default printer.
      r_notebook_apply_session_state(runtime, execution_code)
      previous_evaluate <- knitr::knit_hooks$get("evaluate")
      previous_chunk <- knitr::knit_hooks$get("chunk")
      previous_source <- knitr::knit_hooks$get("source")
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
        if (base::is.function(previous_chunk)) {
          previous_chunk(output, options)
        } else {
          output
        }
      }
      source_wrapper <- function(source, options) {
        if (base::is.function(previous_source)) {
          previous_source(source, options)
        }
        ""
      }
      knitr::knit_hooks$set(
        evaluate = evaluate_wrapper,
        chunk = chunk_wrapper,
        source = source_wrapper
      )
      knit_baseline <- r_notebook_snapshot_knitr()
    }, error = function(error) {
      capture$error <- error
    })
    base::invisible()
  }

  hook(NULL)
  capture
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

r_notebook_knit <- function(chunk_path, execution_dir, evaluation_env, metadata) {
  old_meta <- knitr::knit_meta(clean = TRUE)
  base::on.exit({
    knitr::knit_meta(clean = TRUE)
    knitr::knit_meta_add(old_meta)
  }, add = TRUE)
  r_notebook_with_params(metadata, evaluation_env, function() {
    markdown <- knitr::knit(input = chunk_path, quiet = TRUE, envir = evaluation_env,
      output = base::file.path(execution_dir, "cell.md"))
    list(markdown = base::paste(base::readLines(markdown, warn = FALSE, encoding = "UTF-8"), collapse = "\n"),
      knit_meta = knitr::knit_meta(clean = TRUE), working_dir = knitr::opts_knit$get("root.dir"))
  })
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

r_notebook_execute <- function(
  chunk_path,
  document_path,
  native_document_path,
  document_id,
  cell_id,
  cell_key,
  output_dir,
  working_dir,
  evaluation_env
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
    format <- r_notebook_format(document_path)
    r_notebook_require_litedown()
    metadata <- format$metadata(native_document_path, evaluation_env, base::dirname(document_path))
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
    execution_path <- base::file.path(
      execution_dir,
      "cell.Rmd"
    )

    chunk_lines <- r_notebook_align_leading_chunk_options(base::readLines(
      chunk_path, warn = FALSE, encoding = "UTF-8"
    ))
    base::writeLines(chunk_lines, execution_path, useBytes = TRUE)

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

    knitr::render_markdown()
    knitr::opts_knit$set(rmarkdown.pandoc.to = "html", root.dir = working_dir, output.dir = execution_dir)
    knitr::opts_chunk$set(comment = "", dev = "png", dpi = 96, fig.width = 7,
      fig.height = 5, fig.retina = 2, fig.path = base::paste0(execution_dir, "/figure/"))
    knitr::opts_chunk$set(fig.id = function(options) {
      label <- options$label
      if (!base::is.character(label) || base::length(label) != 1L ||
          !base::grepl("^[A-Za-z][A-Za-z0-9_.:-]*$", label) ||
          (!base::is.null(options$fig.cur) && options$fig.cur != 1L)) return("")
      base::paste0('id="', label, '"')
    })
    format$configure(metadata)
    capture <- r_notebook_install_knit_capture(
      runtime,
      cell_id,
      generated_labels
    )
    result <- r_notebook_knit(execution_path, execution_dir, evaluation_env, metadata)

    if (!base::is.null(capture$error)) {
      base::stop(capture$error)
    }
    if (!base::isTRUE(capture$called)) {
      base::stop("The notebook knit hook was not reached.")
    }

    html <- result$html
    if (
      base::is.null(html) &&
        !base::is.null(result$markdown) &&
        base::length(result$markdown) == 1L &&
        !base::is.na(result$markdown) &&
        base::nzchar(base::trimws(result$markdown))
    ) {
      resource_dir <- if (base::is.null(result$working_dir)) working_dir else result$working_dir
      previous_directory <- base::setwd(resource_dir)
      base::on.exit(base::setwd(previous_directory), add = TRUE)
      html <- r_notebook_litedown_html(result$markdown, metadata, result$knit_meta, format = format)
    }
    if (!base::is.null(html) && base::nzchar(base::trimws(html))) {
      html <- r_notebook_prepare_html(html, cell_output = TRUE)
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
