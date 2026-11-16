import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { RExecutionBridge } from "../../src/Runtime/bridge";
import { HiddenRProcess } from "../../src/Runtime/process";

test("package bootstrap installs into the live project library without JSON or network dependencies", { timeout: 60000 }, async (t) => {
  const executable = process.env.R_EXECUTABLE || (process.platform === "win32" ? "R.exe" : "R");
  if (spawnSync(executable, ["--version"], { windowsHide: true }).status !== 0) {
    if (process.env.CI) assert.fail("CI requires R for package bootstrap coverage");
    t.skip("Set R_EXECUTABLE or put R on PATH to test package installation");
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r-notebook-package-test-"));
  const library = path.join(directory, "project library ü");
  const repository = path.join(directory, "repository");
  const contrib = path.join(repository, "src", "contrib");
  const packageName = "notebookbootstrapfixture";
  const packageDirectory = path.join(directory, packageName);
  const helper = path.join(directory, "packages.R");
  const profile = path.join(directory, ".Rprofile");
  const rString = (value: string) => JSON.stringify(value.replaceAll("\\", "/"));
  const messages: string[] = [];
  const r = new HiddenRProcess(async () => ({
    executable, cwd: directory,
    args: ["--quiet", "--no-save", "--no-restore", process.platform === "win32" ? "--ess" : "--interactive"],
    env: { ...process.env, R_PROFILE_USER: profile },
  }), (message) => messages.push(message));
  t.signal.addEventListener("abort", () => { void r.dispose(); }, { once: true });
  try {
    await fs.mkdir(library);
    await fs.mkdir(contrib, { recursive: true });
    await fs.mkdir(path.join(packageDirectory, "R"), { recursive: true });
    await fs.writeFile(path.join(packageDirectory, "DESCRIPTION"),
      `Package: ${packageName}\nVersion: 1.0\nTitle: Notebook Bootstrap Fixture\nDescription: Tests local installation.\nAuthor: Test\nMaintainer: Test <test@example.com>\nLicense: MIT\n`);
    await fs.writeFile(path.join(packageDirectory, "NAMESPACE"), "export(answer)\n");
    await fs.writeFile(path.join(packageDirectory, "R", "answer.R"), "answer <- function() 42L\n");
    const build = path.join(directory, "repository.R");
    await fs.writeFile(build, [
      `setwd(${rString(directory)})`,
      `utils::tar(${rString(path.join(contrib, `${packageName}_1.0.tar.gz`))}, ${rString(packageName)}, compression = "gzip", tar = "internal")`,
      `tools::write_PACKAGES(${rString(contrib)}, type = "source")`,
    ].join("\n"));
    const built = spawnSync(executable, ["--vanilla", "--slave", "-f", build], { windowsHide: true, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    await fs.writeFile(profile, [
      `.libPaths(c(${rString(library)}, .libPaths()))`,
      `options(repos = c(CRAN = ${rString(pathToFileURL(repository).href)}), pkgType = "source")`,
      'trace(base::loadNamespace, tracer = quote(if (is.character(package) && package[[1L]] == "jsonlite") stop("Bootstrap must not need jsonlite")), print = FALSE)',
      "",
    ].join("\n"));
    const implementation = await fs.readFile(path.resolve("resources/r/packages.R"), "utf8");
    const useVersion = (version: string) => fs.writeFile(helper,
      `${implementation}\nr_notebook_required_packages <- function() c(${packageName} = "${version}")\n`);
    await useVersion("1.0");
    const bridge = new RExecutionBridge(path.join(directory, "execute.R"), r);
    const before = await bridge.notebookPackages();
    assert.equal(path.resolve(before.library), path.resolve(library));
    assert.deepEqual(before.missing, [packageName]);
    const installed = await bridge.notebookPackages({ packages: before.missing, library: before.library });
    assert.deepEqual(installed.missing, [], messages.join("\n"));
    assert.match(await fs.readFile(path.join(library, packageName, "DESCRIPTION"), "utf8"), /Version: 1.0/);
    assert.deepEqual((await bridge.notebookPackages()).missing, []);
    if (process.platform === "win32") {
      // The interrupt helper disables .Rprofile, so it must receive the live
      // library paths explicitly to see a newly installed project-local ps.
      const psDirectory = path.join(directory, "ps");
      const marker = path.join(directory, "interrupt-library-used");
      await fs.mkdir(path.join(psDirectory, "R"), { recursive: true });
      await fs.writeFile(path.join(psDirectory, "DESCRIPTION"),
        "Package: ps\nVersion: 9999.0\nTitle: Interrupt Library Fixture\nDescription: Tests helper libraries.\nAuthor: Test\nMaintainer: Test <test@example.com>\nLicense: MIT\n");
      await fs.writeFile(path.join(psDirectory, "NAMESPACE"), "export(ps_handle, ps_interrupt)\n");
      await fs.writeFile(path.join(psDirectory, "R", "interrupt.R"),
        `ps_handle <- function(pid) pid\nps_interrupt <- function(handle, ctrl_c) writeLines(as.character(handle), ${rString(marker)})\n`);
      await fs.writeFile(build, [
        `setwd(${rString(directory)})`,
        `utils::tar(${rString(path.join(contrib, "ps_9999.0.tar.gz"))}, "ps", compression = "gzip", tar = "internal")`,
        `tools::write_PACKAGES(${rString(contrib)}, type = "source")`,
      ].join("\n"));
      const psBuilt = spawnSync(executable, ["--vanilla", "--slave", "-f", build], { windowsHide: true, encoding: "utf8" });
      assert.equal(psBuilt.status, 0, psBuilt.stderr || psBuilt.stdout);
      await fs.writeFile(helper, `${implementation}\nr_notebook_required_packages <- function() c(ps = "9999.0")\n`);
      const psStatus = await bridge.notebookPackages();
      assert.deepEqual(psStatus.missing, ["ps"]);
      await bridge.notebookPackages({ packages: ["ps"], library: psStatus.library });
      await r.interrupt();
      assert.equal(Number((await fs.readFile(marker, "utf8")).trim()), r.processId);
    }
    // A failed install can return only a warning; checking the version afterward
    // must still reject it instead of allowing startup to claim success.
    await useVersion("2.0");
    assert.deepEqual((await bridge.notebookPackages()).missing, [packageName]);
    await assert.rejects(bridge.notebookPackages({ packages: [packageName], library: before.library }),
      /Installation did not provide the required versions/);
    await assert.rejects(bridge.notebookPackages({ packages: [packageName], library: directory }), /library changed/);
    await assert.rejects(bridge.notebookPackages({ packages: ["unexpected"], library: before.library }), /Unknown notebook package/);
    assert.equal(r.running, true, "Installation failure must leave the R session usable");
  } finally {
    await r.dispose();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("r-notebook-package-test-"));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
