merge_r_notebook_options <- function(header_options, pipe_options, target) {
  if (!target %in% c("header", "pipe")) {
    stop("The merge target must be 'header' or 'pipe'.")
  }

  knitr_namespace <- asNamespace("knitr")
  dash_names <- get("dash_names", knitr_namespace)
  yaml_load <- get("yaml_load", asNamespace("xfun"))
  header_option_names <- unique(c(
    names(get("opts_chunk_attr", knitr_namespace)),
    names(knitr::opts_chunk$get())
  ))
  option_indexes <- as.list(seq_along(header_option_names))
  names(option_indexes) <- header_option_names
  pipe_option_indexes <- dash_names(option_indexes)
  header_name_by_pipe <- setNames(
    header_option_names[unlist(pipe_option_indexes, use.names = FALSE)],
    names(pipe_option_indexes)
  )

  to_header_names <- function(options) {
    option_names <- names(options)
    mapped_names <- unname(header_name_by_pipe[option_names])
    use_mapping <- !option_names %in% header_option_names &
      !is.na(mapped_names)
    names(options)[use_mapping] <- mapped_names[use_mapping]
    options
  }

  unwrap_expression <- function(value) {
    if (!is.expression(value)) {
      return(value)
    }
    if (length(value) == 1L) {
      return(value[[1L]])
    }
    as.call(c(quote(`{`), as.list(value)))
  }

  header <- dash_names(xfun::csv_options(header_options))
  pipe <- yaml_load(strsplit(pipe_options, "\n", fixed = TRUE)[[1L]], envir = FALSE)
  if (is.null(pipe)) {
    pipe <- list()
  }
  if (!is.list(pipe) || is.null(names(pipe)) && length(pipe) > 0L) {
    stop("Pipe options must be a YAML option map.")
  }
  if (any(names(pipe) %in% c("label", "id"))) {
    stop("Enter the pipe label in the Pipe label field before merging.")
  }
  pipe <- dash_names(to_header_names(pipe))

  merged <- list()
  merged[names(header)] <- header
  merged[names(pipe)] <- pipe
  if (length(merged) == 0L) {
    return(list(headerOptions = "", pipeOptions = ""))
  }

  if (identical(target, "header")) {
    merged <- to_header_names(merged)
    values <- vapply(merged, function(value) {
      value <- unwrap_expression(value)
      paste(deparse(value, width.cutoff = 500L), collapse = " ")
    }, character(1))
    option_names <- vapply(names(merged), function(name) {
      paste(deparse(as.name(name)), collapse = " ")
    }, character(1))
    return(list(
      headerOptions = paste0(option_names, "=", values, collapse = ", "),
      pipeOptions = ""
    ))
  }

  merged <- lapply(merged, function(value) {
    value <- unwrap_expression(value)
    if (is.symbol(value) || is.language(value)) {
      value <- paste(deparse(value, width.cutoff = 500L), collapse = " ")
      attr(value, "tag") <- "!expr"
    }
    value
  })
  pipe_options <- yaml::as.yaml(
    merged,
    handlers = list(
      logical = function(value) {
        structure(tolower(value), class = "verbatim")
      },
      numeric = function(value) {
        if (
          length(value) == 1L &&
          is.finite(value) &&
          isTRUE(as.integer(value) == value)
        ) {
          value <- as.integer(value)
        }
        value
      }
    ),
    line.sep = "\n"
  )
  list(headerOptions = "", pipeOptions = sub("\n$", "", pipe_options))
}

if (sys.nframe() == 0L) {
  response <- tryCatch({
    input <- jsonlite::fromJSON(
      paste(readLines(file("stdin"), warn = FALSE), collapse = "\n")
    )
    merge_r_notebook_options(
      input$headerOptions,
      input$pipeOptions,
      input$target
    )
  }, error = function(error) {
    list(error = conditionMessage(error))
  })
  cat(jsonlite::toJSON(response, auto_unbox = TRUE))
}
