# Bootstrap package checks must work before any notebook packages are installed.
r_notebook_required_packages <- function() {
  packages <- c(knitr = "1.44", litedown = "1.0", jsonlite = "0")
  if (.Platform$OS.type == "windows") packages <- c(packages, ps = "0")
  packages
}

r_notebook_missing_packages <- function() {
  required <- r_notebook_required_packages()
  names(required)[!vapply(names(required), function(package) {
    tryCatch(utils::packageVersion(package) >= required[[package]], error = function(error) FALSE)
  }, logical(1))]
}

r_notebook_packages <- function(output_path, packages = character(), library = .libPaths()[1L]) {
  if (length(packages)) {
    if (!all(packages %in% names(r_notebook_required_packages()))) {
      stop("Unknown notebook package requested.")
    }
    if (!identical(library, .libPaths()[1L])) {
      stop("The R library changed. Restart the notebook session and try again.")
    }
    if (file.access(library, 2L) != 0L) {
      stop(paste("The R library is not writable:", library,
        "\nConfigure a writable R library and restart the notebook session."))
    }
    # A loaded outdated namespace cannot safely be replaced in the live session.
    loaded <- intersect(packages, loadedNamespaces())
    if (length(loaded)) {
      stop(paste("Close the notebook session and update these loaded packages in R:",
        paste(loaded, collapse = ", ")))
    }
    repos <- getOption("repos")
    if (!length(repos)) repos <- c(CRAN = "https://cloud.r-project.org")
    repos[repos == "@CRAN@"] <- "https://cloud.r-project.org"
    utils::install.packages(packages, lib = library, repos = repos)
    missing <- intersect(packages, r_notebook_missing_packages())
    if (length(missing)) {
      stop(paste("Installation did not provide the required versions of:", paste(missing, collapse = ", ")))
    }
  }
  libraries <- vapply(.libPaths(), utils::URLencode, character(1), reserved = TRUE)
  writeLines(c(paste(libraries, collapse = "\t"), r_notebook_missing_packages()),
    output_path, useBytes = TRUE)
}
