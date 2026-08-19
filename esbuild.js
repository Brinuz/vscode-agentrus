const { copyFile, mkdir } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** The codicon font and its class rules, served to the webview from dist/. */
async function copyCodicons() {
  const from = dirname(require.resolve("@vscode/codicons/package.json"));
  await mkdir("dist", { recursive: true });
  for (const file of ["codicon.css", "codicon.ttf"]) {
    await copyFile(join(from, "dist", file), join("dist", file));
  }
}

async function main() {
  await copyCodicons();

  const contexts = await Promise.all([
    esbuild.context({
      entryPoints: ["src/extension.ts"],
      bundle: true,
      format: "cjs",
      minify: production,
      sourcemap: !production,
      sourcesContent: false,
      platform: "node",
      outfile: "dist/extension.js",
      external: ["vscode"],
      logLevel: "warning",
    }),
    esbuild.context({
      entryPoints: [
        { in: "src/webview/main.ts", out: "webview" },
        { in: "src/webview/style.css", out: "webview" },
      ],
      bundle: true,
      format: "iife",
      minify: production,
      sourcemap: !production,
      sourcesContent: false,
      platform: "browser",
      outdir: "dist",
      logLevel: "warning",
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
