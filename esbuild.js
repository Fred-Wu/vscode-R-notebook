const fs = require("fs");
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  fs.rmSync("dist", { recursive: true, force: true });

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
