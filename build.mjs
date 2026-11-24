/* Build the standalone single-file viewer by inlining CSS + JS into index.html.
   Usage: node build.mjs            -> writes Standalone_3D_Viewer.html (empty viewer)
          node build.mjs <file.json>-> also embeds a prebuilt state (for testing) */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let html = read("index.html");

// 0a) developer Light panel: when DEV.lightPanel is false in src/app.js, strip the
// panel's markup + styles from the build (the inert JS stays, guarded at runtime).
// One flag in app.js drives both the runtime toggle and this build-time removal.
const appSrc = read("src/app.js");
const devMatch = appSrc.match(/lightPanel:\s*(true|false)/);
const lightPanel = devMatch ? devMatch[1] === "true" : true;
if (!lightPanel) {
  const before = html.length;
  html = html.replace(/[ \t]*<!-- ===== LIGHT LAB[\s\S]*?\/LIGHT LAB ===== -->\n?/, "");
  if (html.length === before) throw new Error("LIGHT LAB markers not found in index.html");
}

// 0) inline favicon as a self-contained data URI
const favSvg = read("src/favicon.svg");
const favData = "data:image/svg+xml;base64," + Buffer.from(favSvg, "utf8").toString("base64");
html = html.replace(
  /<!--\[\[FAVICON\]\]--><link rel="icon" type="image\/svg\+xml" href="src\/favicon\.svg">/,
  () => `<link rel="icon" type="image/svg+xml" href="${favData}">`   // function replacement: no $ pattern substitution
);

// 0b) inline the brand palette (see src/brand-colors.css) and logo mark (see
// src/brand-logo.svg) — both are edited directly by a rebrander, no build-time
// recoloring, same treatment as the favicon above.
const brandColorsCss = read("src/brand-colors.css");
html = html.replace(
  /<!--\[\[BRAND_COLORS\]\]--><link rel="stylesheet" href="src\/brand-colors\.css">/,
  () => "<style>\n" + brandColorsCss + "\n</style>"
);
const brandLogoSvg = read("src/brand-logo.svg").trim();
html = html.replace(
  /<!--\[\[BRAND_LOGO\]\]--><img class="logo" src="src\/brand-logo\.svg" alt="3D Viewer">/,
  () => brandLogoSvg
);

// 1) inline stylesheet (drop the Light panel's CSS too when the panel is disabled)
let css = read("src/styles.css");
if (!lightPanel) {
  const before = css.length;
  css = css.replace(/\/\* ===== LIGHT LAB[\s\S]*?\/\* ===== \/LIGHT LAB ===== \*\/\n?/, "");
  if (css.length === before) throw new Error("LIGHT LAB markers not found in src/styles.css");
}
html = html.replace(
  /<!--\[\[STYLE\]\]--><link rel="stylesheet" href="src\/styles\.css">/,
  () => "<style>\n" + css + "\n</style>"   // function replacement: no $ pattern substitution
);

// 1b) guard: the generated vendor bundle (tree-shaken three core — see
// tools/build_vendor.mjs) must still cover every THREE.* member app.js uses.
// Dependency-free check so a plain `node build.mjs` fails loudly instead of
// silently shipping a viewer that throws "THREE.Foo is not a constructor".
const membersPath = path.join(root, "tools/three-members.json");
if (!fs.existsSync(membersPath)) throw new Error("Vendor bundle metadata missing — run: npm install && npm run vendor");
const gen = JSON.parse(fs.readFileSync(membersPath, "utf8"));
const known = new Set([...gen.members, ...gen.attached]);
const usedNow = new Set();
for (const m of appSrc.matchAll(/\bTHREE\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) usedNow.add(m[1]);
for (const m of appSrc.matchAll(/["']([A-Za-z_$][A-Za-z0-9_$]*)["']\s+in\s+THREE\b/g)) usedNow.add(m[1]);
const missing = [...usedNow].filter((n) => !known.has(n)).sort();
if (missing.length) {
  throw new Error("src/app.js uses THREE members not in vendor/three-bundle.min.js: " +
    missing.join(", ") + " — run: npm run vendor");
}

// 1c) minify src/app.js when esbuild is available. Optional: a plain
// `node build.mjs` without node_modules still works, it just ships the readable
// source. The escape step in the loop below keeps any `</script>`/`<!--` byte
// sequences a minifier might fold together from corrupting the HTML tokenizer.
let appCode = appSrc;
try {
  const esbuild = await import("esbuild");
  appCode = (await esbuild.transform(appSrc, { minify: true, target: "es2018", charset: "utf8" })).code;
} catch {
  console.warn("esbuild unavailable — inlining src/app.js unminified (npm install to enable minification)");
}

// 2) inline scripts in order
const scripts = [
  "src/brand.config.js",   // must precede src/app.js: app.js's IIFE reads BRAND via shared script-scope
  "vendor/three-bundle.min.js",   // GENERATED tree-shaken three + example files — npm run vendor
  "vendor/pako.min.js",
  "src/app.js",
];
for (const s of scripts) {
  // Escape close-tag and comment-open byte sequences so inlined JS can't corrupt the
  // HTML tokenizer (the "<!-- ... <script" double-escape trap). Safe: these only ever
  // occur inside string/regex literals in our vendored + app code.
  const raw = s === "src/app.js" ? appCode : read(s);
  const code = raw.replace(/<\/script>/gi, "<\\/script>").replace(/<!--/g, "<\\!--");
  const tag = `<script src="${s}"></script>`;
  if (!html.includes(tag)) throw new Error("Missing script tag for " + s);
  // Use a function replacement: a string replacement would interpret $&, $`, $', $$
  // in `code` as special patterns (e.g. pako's minified "$&&" injects the matched tag,
  // smuggling a literal close-tag into the script and truncating it). A function returns
  // the value verbatim with no $ substitution.
  html = html.replace(tag, () => "<script>\n" + code + "\n</script>");
}

// 3) optionally embed a prebuilt state for testing
const stateArg = process.argv[2];
let outName = "Standalone_3D_Viewer.html";
if (stateArg) {
  const json = fs.readFileSync(stateArg, "utf8").trim();
  const safe = json.replace(/<\/script>/gi, "<\\/script>").replace(/<!--/g, "<\\!--");
  html = html.replace(
    /(<script id="embedded-data" type="application\/json">)([\s\S]*?)(<\/script>)/,
    (_, a, _b, c) => a + safe + c
  );
  outName = "test_embedded.html";
}

fs.writeFileSync(path.join(root, outName), html);
const kb = (html.length / 1024).toFixed(0);
console.log(`Wrote ${outName} (${kb} KB)`);
