/* Build the standalone single-file viewer by inlining CSS + JS into index.html.
   Usage: node build.mjs            -> writes Standalone_3D_Viewer.html (empty viewer)
          node build.mjs <file.json>-> also embeds a prebuilt state (for testing) */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let html = read("index.html");

// 0) inline favicon as a self-contained data URI
const favSvg = read("src/favicon.svg");
const favData = "data:image/svg+xml;base64," + Buffer.from(favSvg, "utf8").toString("base64");
html = html.replace(
  /<!--\[\[FAVICON\]\]--><link rel="icon" type="image\/svg\+xml" href="src\/favicon\.svg">/,
  `<link rel="icon" type="image/svg+xml" href="${favData}">`
);

// 1) inline stylesheet
const css = read("src/styles.css");
html = html.replace(
  /<!--\[\[STYLE\]\]--><link rel="stylesheet" href="src\/styles\.css">/,
  "<style>\n" + css + "\n</style>"
);

// 2) inline scripts in order
const scripts = [
  "vendor/three.min.js",
  "vendor/OrbitControls.js",
  "vendor/OBJLoader.js",
  "vendor/STLLoader.js",
  "vendor/GLTFLoader.js",
  "vendor/CSS2DRenderer.js",
  "src/app.js",
];
for (const s of scripts) {
  // Escape close-tag and comment-open byte sequences so inlined JS can't corrupt the
  // HTML tokenizer (the "<!-- ... <script" double-escape trap). Safe: these only ever
  // occur inside string/regex literals in our vendored + app code.
  const code = read(s).replace(/<\/script>/gi, "<\\/script>").replace(/<!--/g, "<\\!--");
  const tag = `<script src="${s}"></script>`;
  if (!html.includes(tag)) throw new Error("Missing script tag for " + s);
  html = html.replace(tag, "<script>\n" + code + "\n</script>");
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
