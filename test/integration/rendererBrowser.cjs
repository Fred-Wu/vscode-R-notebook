const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { build } = require("esbuild");

const browser = process.env.CHROME_PATH || [
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);

test("renderer applies responses and isolates styles in a browser shadow root", {
  skip: !browser && "Set CHROME_PATH to run the browser renderer regressions",
}, async (t) => {
  const fixtures = require("./nativeFixtures.cjs").nativeFixtures();
  t.diagnostic(fixtures.length ? "Checking real R Markdown and Quarto example HTML" :
    "Rscript is unavailable; checking synthetic browser fixtures only");
  const bundle = await build({
    entryPoints: [path.join(__dirname, "../Renderer/browser.ts")],
    bundle: true, write: false, platform: "browser", format: "iife",
  });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "r-notebook-browser-"));
  let child;
  let stopped;
  let timer;
  let stderr = "";
  let complete;
  const result = new Promise((resolve, reject) => {
    complete = resolve;
    timer = setTimeout(() => reject(new Error(`Browser test timed out: ${stderr}`)), 30000);
  });
  const server = http.createServer(async (request, response) => {
    if (request.url === "/result" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      complete(JSON.parse(Buffer.concat(chunks).toString()));
      response.end("ok");
    } else if (request.url === "/native-fixtures") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(fixtures));
    } else if (request.url === "/test.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html><body><script src="/test.js"></script></body></html>');
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    child = spawn(browser, ["--headless", "--disable-gpu", "--no-sandbox",
      "--no-first-run", `--user-data-dir=${profile}`,
      `http://127.0.0.1:${server.address().port}/`], { windowsHide: true });
    stopped = new Promise((resolve) => child.once("close", resolve));
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const exited = new Promise((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Browser exited (${code}): ${stderr}`)));
    });
    const report = await Promise.race([result, exited]);
    assert.equal(report.success, true, report.error);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) {
      child.kill();
      await stopped;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // profile is created above in the OS temp directory for this test only.
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith("r-notebook-browser-"));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
