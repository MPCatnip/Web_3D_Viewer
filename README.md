# 3D Viewer

A **standalone, offline, single-file** 3D viewer for exported CAD geometry
(OBJ / STL, optional GLB/glTF). The whole application — 3D engine, UI, and any
embedded models — lives inside one `.html` file that can be e-mailed, dropped on
a shared folder, or opened by double-clicking. **No internet, no install, no CAD
software required.**

---

## Files

| File | Purpose |
|------|---------|
| **`Standalone_3D_Viewer.html`** | The deliverable — an empty standalone viewer. Open it, drag models in, save a copy with them embedded. Produced by `node build.mjs`. |
| `test_embedded.html` | The same viewer with a sample assembly embedded, to see it working. Regenerable (gitignored) — see *Rebuilding* below. |
| `index.html`, `src/`, `vendor/` | Source. Edit these, then rebuild. |
| `build.mjs` | Build script — inlines CSS + JS into the standalone file. |
| `samples/`, `tools/` | Sample model generators and test-state builder. |

## Using the viewer

1. **Open** `Standalone_3D_Viewer.html` in any modern browser (Chrome, Edge, Firefox).
2. **Add geometry** — click **Open**, or **drag** `.obj` / `.stl` / `.glb` files
   onto the window. Each opened model is *added* to the scene (it does not
   replace what is already there). The file's original origin is preserved.
3. **Inspect**
   - **Navigator** (left): standard views, isometric, fit-to-view, and an
     orthographic / perspective toggle.
   - **Tools** (right): measure point-to-point distances (with X/Y/Z deltas, in
     mm), a section view with muted-red caps and a position slider, and text
     annotations anchored in 3D.
   - **Objects** (right): per-part colour, visibility, isolate / hide / show-all,
     and rename (double-click a name).
   - **Info** (bottom-left): title, description, export date, bounding-box size
     in mm, and the copyright / confidential notice.
   - **Menu** (top-right): save, edit, remove parts, change the up-axis
     (Z+/Z−/X+/X−/Y+/Y−), and toggle the floor grid.
4. **Save & share** — *Menu → Save file* writes a **new** standalone `.html`
   containing the current models plus all their colours, names, visibility,
   measurements, annotations and view settings. Send that file to anyone.

## Rebuilding from source

```bash
node build.mjs                 # -> Standalone_3D_Viewer.html  (empty viewer)
node tools/make_samples.mjs    # regenerate sample .obj / .stl
node tools/make_test_state.mjs # build a demo state from the samples
node build.mjs tools/test_state.json   # -> test_embedded.html (demo)
```

The build simply reads `index.html` and inlines `src/styles.css` and every
`vendor/*.js` + `src/app.js` into a single document.

> **Note on inlining:** because the app re-saves itself by reproducing its own
> source, the source must never contain a literal script-close tag or HTML
> comment-open sequence inside a script (`…/script…`, `<!-- …`). Those flip the
> HTML tokenizer into a state where the real close tag is ignored and the page
> silently fails to boot. `build.mjs` escapes them defensively, and `app.js`
> avoids them in source. See `EXPORT_FORMAT.md`.

## Vendored libraries

Three.js r137 (UMD) + `OBJLoader`, `STLLoader`, `GLTFLoader`, `OrbitControls`,
`CSS2DRenderer` (the global-script builds), all under `vendor/` and inlined at
build time. MIT licensed.
