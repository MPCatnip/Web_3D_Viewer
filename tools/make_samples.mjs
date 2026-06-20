/* Generate sample CAD-like models for testing the viewer.
   Writes samples/two_blocks.obj (multi-body) and samples/wedge.stl (single body). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, "..", "samples");
fs.mkdirSync(out, { recursive: true });

/* ---- OBJ with two bodies (origin kept at corner, not centered) ---- */
function boxVerts(x0, y0, z0, dx, dy, dz) {
  return [
    [x0, y0, z0], [x0 + dx, y0, z0], [x0 + dx, y0 + dy, z0], [x0, y0 + dy, z0],
    [x0, y0, z0 + dz], [x0 + dx, y0, z0 + dz], [x0 + dx, y0 + dy, z0 + dz], [x0, y0 + dy, z0 + dz],
  ];
}
// faces as triangles, local 1-based indices into the 8 box verts
const boxFaces = [
  [1,2,3],[1,3,4], [5,7,6],[5,8,7], [1,5,6],[1,6,2],
  [2,6,7],[2,7,3], [3,7,8],[3,8,4], [4,8,5],[4,5,1],
];

let obj = "# sample — two bodies\n";
let base = 0;
function emitBox(name, verts) {
  obj += `o ${name}\n`;
  verts.forEach((v) => { obj += `v ${v[0]} ${v[1]} ${v[2]}\n`; });
  boxFaces.forEach((f) => { obj += `f ${f[0]+base} ${f[1]+base} ${f[2]+base}\n`; });
  base += verts.length;
}
emitBox("Base_Plate", boxVerts(0, 0, 0, 80, 80, 15));
emitBox("Pillar",     boxVerts(25, 25, 15, 30, 30, 55));
fs.writeFileSync(path.join(out, "two_blocks.obj"), obj);

/* ---- STL single body: a triangular wedge, offset in space ---- */
function tri(a, b, c) {
  const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
  const v = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  let n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const L = Math.hypot(...n) || 1; n = n.map((x) => x / L);
  return ` facet normal ${n[0]} ${n[1]} ${n[2]}\n  outer loop\n   vertex ${a.join(" ")}\n   vertex ${b.join(" ")}\n   vertex ${c.join(" ")}\n  endloop\n endfacet\n`;
}
// wedge prism placed at x≈ -60
const ox = -60, oy = 10, oz = 0, w = 40, d = 40, h = 40;
const P = {
  a: [ox, oy, oz], b: [ox + w, oy, oz], c: [ox + w, oy + d, oz], dd: [ox, oy + d, oz],
  e: [ox, oy, oz + h], f: [ox, oy + d, oz + h],
};
let stl = "solid Wedge\n";
stl += tri(P.a, P.b, P.c) + tri(P.a, P.c, P.dd);     // bottom
stl += tri(P.a, P.e, P.f) + tri(P.a, P.f, P.dd);     // back slope-left wall
stl += tri(P.b, P.c, P.f) + tri(P.b, P.f, P.e);      // slanted face
stl += tri(P.a, P.b, P.e);                            // front triangle
stl += tri(P.dd, P.f, P.c);                           // rear triangle
stl += "endsolid Wedge\n";
fs.writeFileSync(path.join(out, "wedge.stl"), stl);

console.log("samples written: two_blocks.obj, wedge.stl");
