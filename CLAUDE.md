# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **standalone, offline, single-file** 3D viewer for exported CAD geometry (OBJ / STL / GLB). The entire app — three.js engine, UI, and any embedded models — is inlined into one `.html` that opens by double-click with no server, install, or internet. The viewer can **re-save itself**: *Menu → Save file* writes a new standalone `.html` with the current models + all view state embedded.

## Build & run

```bash
node build.mjs                        # -> Standalone_3D_Viewer.html (empty deliverable)
node build.mjs tools/test_state.json  # -> test_embedded.html (demo with sample parts; gitignored)
node tools/make_samples.mjs           # regenerate samples/*.obj / *.stl
node tools/make_test_state.mjs        # rebuild tools/test_state.json from the samples
```

`build.mjs` inlines `src/styles.css`, every `vendor/*.js`, and `src/app.js` into `index.html`. There is **no lint/test suite** — verification is manual in a browser (see below). After editing `src/`, rebuild before the change is visible anywhere.

### Verifying in the preview (important gotchas)
- The static server (`launch.json` → `python -m http.server 5050`) sends no no-cache headers. After rebuilding, **navigate with a cache-buster** (`test_embedded.html?v=<Date.now()>`) or you'll silently test the stale build.
- `src/app.js` is **one IIFE — its functions/state are not global.** Drive the UI from `preview_eval` by dispatching DOM events (clicks on `.obj-row`, buttons, etc.), not by calling internal functions.
- The per-part move/rotate **gizmo drag is not scriptable** (synthetic PointerEvents throw `InvalidPointerId` on `setPointerCapture`). To exercise move logic without a mouse: either embed a part with a `pos`/`quat` offset in a state JSON, or select a part + enter transform mode and set `#posX/#posY/#posZ/#rotX…/#scaleU` `.value` + dispatch `change` (runs `commitPartCoord` → `afterCoordEdit`, same downstream as a drag).
- WebGL canvas `preview_screenshot` reliably times out (~30s). Verify via DOM readouts (CSS2D label text, `getBoundingClientRect`) instead.

## Architecture

### The self-replication constraint (read before editing source)
On boot, `app.js` captures `PRISTINE_HTML = document.documentElement.outerHTML` **before mutating anything**. "Save file" reproduces that HTML with fresh JSON swapped into the `<script id="embedded-data">` block. Consequence: **source must never contain a literal `</script>` or `<!--` inside a script** — those flip the HTML tokenizer and the saved page silently fails to boot. Write such sequences split/escaped (see the regexes in `saveFile` and `build.mjs`, written with `[<]` and backslash-escapes on purpose).

### State is the single source of truth
The `state` object (meta, files, parts, measurements, annotations, section) is canonical. `serializeState()` ↔ `loadFromState()` is the round-trip used by both Save and the external CAD integration. `state.files[].data` is base64 of the model bytes — DEFLATE-compressed (via bundled `pako`) when `state.files[].enc === "deflate"`, raw when `enc` is absent (back-compat). Compression happens once at import (`addFile`); `loadFromState` inflates before parsing geometry. See EXPORT_FORMAT.md for the `enc` field.

**Runtime part ids (`uid("p")`) are regenerated on each load**, so anything persisted that references a part uses a stable `{fileId, index}` ref instead (see `partRef`/`partIdFromRef`) — e.g. marker→part bindings.

### Scene graph & coordinate spaces
```
scene
 └ modelRoot          (quaternion = up-axis rotation: file "up" -> world +Y)
    ├ <part meshes>   (added flat; each mesh.userData.partId links to state.parts)
    └ markerRoot      (measurements + annotations live here, in file space)
```
`markerRoot`-local space == file space. Picked surface points are stored markerRoot-local; "mm" readouts and the bounding box are in file units.

### Per-part transform: three layers
Each part keeps three poses so Reset and "Set transforms as default" work, and so saves are minimal deltas:
- **loader\*** — pristine geometry pose, the immutable anchor.
- **base\*** — reset target ("Set transforms as default" copies current → base).
- **mesh.\*** — current pose.
`serializeState` stores `dpos/dquat/dscale` (base − loader) and `pos/quat/scale` (mesh − base) only when they differ. `partMoved()` drives the per-row reset buttons and `#btnResetXform`.

### Markers follow moved parts
Measurement endpoints and annotation anchors are **bound** to the part they were placed on, stored in that part's mesh-local space (`aLocal/bLocal`, `pLocal` + `aPart/bPart/part`). `markerLocalFromPart()` re-derives marker-space position from the part's live pose; `refreshMarkers()` runs after every move (`onPartMoving`, `afterCoordEdit`, resets). Bindings persist via `{fileId,index}` refs; older unbound saves auto-bind to a nearby surface (`nearestPartBinding`, tolerance-gated).

### Rendering specifics
- **X-ray pass:** measurements/annotations draw twice — a depth-tested solid pass plus a faded `depthTest:false` pass (`renderOrder:4`) so the line/dots show through the model. CSS2D labels have no depth, so occlusion is faked per-frame by raycasting camera→label (`updateLabelOcclusion`).
- **CSS2D label caveats:** a `CSS2DObject` label **ignores its parent group's `.visible`** — toggle `label.visible` explicitly (see `applyMeasDisplay`/`applyAnnotDisplay`). Removing a group does **not** clean up the label's DOM node — remove `m.el`/`a.el` explicitly.
- **Markers stay constant pixel size** via `updateMarkerScales()` each frame (`worldPerPixel`).
- **Section view** clips part materials with a `THREE.Plane` and fills the cut with stencil-based caps (`makeStencilGroup`/`buildSection`); offset is remembered per axis. Shadows are VSM (soft self-shadow), with the key light split into a faint caster + a non-casting main.

### UI wiring
All event binding is centralized in `wireUI()`. Tool modes (`orbit | measure | removeMeas | annotate | removeAnnot`) are mutually exclusive and routed through `setMode()`; the canvas click/drag split is in `onPointerUp` (`CLICK_SLOP`). Re-branding: edit `BRAND` in `app.js` and the logo block in `index.html` (search "BRAND LOGO").

## External CAD integration
A post-export step takes empty `Standalone_3D_Viewer.html`, replaces the `null` in `<script id="embedded-data">` with a JSON state object, and writes a new `.html`. Full schema + a Python example are in `EXPORT_FORMAT.md`. Only `meta` + `files` are required.
