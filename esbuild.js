const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const dist = path.resolve("dist");
  if (path.dirname(dist) !== process.cwd()) throw new Error("Unexpected build directory");
  fs.rmSync(dist, { recursive: true, force: true });
  // Math must also work offline, without downloading scripts while R is busy.
  const katex = path.dirname(require.resolve("katex/package.json"));
  fs.mkdirSync("dist/katex", { recursive: true });
  for (const file of ["katex.min.js", "katex.min.css", "contrib/auto-render.min.js"]) {
    fs.copyFileSync(path.join(katex, "dist", file), path.join("dist/katex", path.basename(file)));
  }
  fs.cpSync(path.join(katex, "dist/fonts"), "dist/katex/fonts", { recursive: true });
  fs.copyFileSync(path.join(katex, "LICENSE"), "dist/katex/LICENSE");

  const contexts = await Promise.all([
    esbuild.context({
      entryPoints: ["src/extension.ts"],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node18",
      outfile: "dist/extension.js",
      external: ["vscode"],
      sourcemap: !production,
      sourcesContent: !production,
      minify: production,
      logLevel: "info",
      tsconfig: "tsconfig.json",
    }),
    esbuild.context({
      entryPoints: {
        renderer: "src/Renderer/index.ts",
        optionsRenderer: "src/Renderer/options.ts",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outdir: "dist",
      sourcemap: !production,
      sourcesContent: !production,
      minify: production,
      logLevel: "info",
      tsconfig: "tsconfig.json",
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((context) => context.watch()));
    return;
  }

  try {
    await Promise.all(contexts.map((context) => context.rebuild()));
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
