/* Build a test state JSON embedding the sample models, mirroring what the app's
   "Save file" produces. Output: tools/test_state.json (feed to build.mjs). */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const samples = path.join(root, "..", "samples");
// DEFLATE the bytes (matches the app's enc:"deflate") so the test state stays small
const b64 = (p) => zlib.deflateSync(fs.readFileSync(p)).toString("base64");

const state = {
  v: 1,
  meta: {
    title: "Demo Assembly",
    description: "Sample multi-body assembly for viewer verification.",
    exportDate: "2026-06-15",
    copyright: "",
    confidential: "",
    upAxis: "z+",
    projection: "persp",
    gridOn: true,
  },
  files: [
    { id: "f1", name: "two_blocks.obj", format: "obj", enc: "deflate", data: b64(path.join(samples, "two_blocks.obj")) },
    { id: "f2", name: "wedge.stl", format: "stl", enc: "deflate", data: b64(path.join(samples, "wedge.stl")) },
  ],
  parts: [
    { fileId: "f1", index: 0, name: "Base Plate", color: 0xbfc4cb, visible: true },
    { fileId: "f1", index: 1, name: "Pillar", color: 0xe8a23f, visible: true },
    { fileId: "f2", index: 0, name: "Wedge", color: 0x8a5fc9, visible: true },
  ],
  measurements: [],
  annotations: [{ p: [40, 40, 70], text: "Pillar top" }],
  section: { on: false, axis: "x", t: 0.5, flip: false },
};

fs.writeFileSync(path.join(root, "test_state.json"), JSON.stringify(state));
console.log("wrote tools/test_state.json");
