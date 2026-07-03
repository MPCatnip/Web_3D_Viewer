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
- The per-part move/rotate **gizmo drag is not scriptable** (synthetic PointerEvents throw `InvalidPointerId` on `setPointerCapture`). To exercise move logic without a mouse: either embed a part with a `pos`/`quat` offset in a state JSON, or select a part + enter transform mode and set `#posX/#posY/#posZ/#rotX…/#scaleX/#scaleY/#scaleZ` `.value` + dispatch `change` (runs `commitPartCoord` → `afterCoordEdit`, same downstream as a drag). **Group** (multi-select) move logic is exercised via the nudge fields (`#ndX…` + `#ndMove`, `#ndRX…` + `#ndRot`), which share `applyGroupDelta` with the gizmo's pivot drag.
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

### Per-part transform: three layers (+ origin below them)
Each part keeps three poses so Reset and "Set transforms as default" work, and so saves are minimal deltas:
- **loader\*** — pristine geometry pose, the immutable anchor.
- **base\*** — reset target ("Set transforms as default" copies current → base).
- **mesh.\*** — current pose.
`serializeState` stores `dpos/dquat/dscale` (base − loader) and `pos/quat/scale` (mesh − base) only when they differ. `partMoved()` drives the per-row reset buttons and `#btnResetXform`.

**Origin → CoM** (`centerPartOrigin`) sits *below* the loader layer: it translates the geometry by −centroid and compensates **each pose layer with its own quat/scale** (do not reuse one compensation for all three, or `partMoved`/reset silently drift for rotated bases). The cumulative shift persists as `parts[].origin` and is re-applied in `registerObject` *before* `loaderPos` is captured, so all saved deltas stay valid. Bound marker locals (`aLocal/bLocal/pLocal`) are mutated into the shifted space at apply time — saved files therefore store shifted locals, and files without `origin` need no migration. `getLocalBox` un-shifts per-part bboxes by `p.origin` so file-space dims stay truthful. File bytes are never touched: deleting `origin` from a saved state restores the pristine CAD origin.

### Multi-select & the transform panel
Selection is `selectedIds` (ordered) + `selectedId` (**primary** = last added; single-part consumers still read it). Ctrl-click toggles (list + canvas; canvas Ctrl-click on empty space keeps the selection), Shift-click range-selects in the list, plain click replaces; all repainting funnels through `applySelectionVisuals()`. With >1 selected the gizmo attaches to `xformPivot`, a proxy `Object3D` at the selection centroid whose drag delta is mirrored to every selected mesh via `applyGroupDelta(starts, dPos, dQuat, pivotPoint)` — the **same helper** used by the nudge fields and Place-on-floor. The pivot's rotation is re-zeroed on every `updateGizmoAttachment()` (drag end, edits), or successive world-space rotations compound oddly. The bottom `#xformPanel` (under `#xformBar`, shown with it) holds the absolute pos/rot/scale fields (`#partCoords` — moved out of the Objects panel; display-only via the `.multi` class when several parts are selected), the Δmm/Δ° nudge rows (`#ndX…#ndRZ`, apply repeatedly on Enter/Apply), **Place on floor** (`placeSelectionOnFloor` — one shared world-ΔY through the inverse modelRoot quaternion, so assemblies drop as a group) and **Origin → CoM**. Programmatic transform edits end in `afterGroupEdit()`.

### Multi-material parts (usemtl groups)
A mesh with multiple materials (OBJ `usemtl` groups / GLB primitives) stays **one part** but carries a **material array** (one `makePartMaterial` per group) and `part.colors` (persisted as `parts[].colors`; `color` stays as the legacy single-color fallback — a state entry with `color` but no `colors` collapses to one material, preserving old saves). **Always touch materials via `matArray(mesh)` / `eachPartMaterial`** — never `mesh.material.x` directly. Group colors come from a `.mtl` dropped alongside the `.obj` (`parseMTL` — Kd for color, Pr/Ns for finish — matched via `mtllib`/basename; the .mtl itself is *not* stored in state), else `GROUP_PALETTE`. A multi-material row's icon is a hard-stop **gradient** of the group colors (`partGradientCSS`); every row swatch (a `<button>`) opens the shared **appearance popover** (`ensureMatPopover`/`openMatPopover` — one fixed-position element reused for all parts). The popover holds an inline **HSV color picker** — SV square drag, a div-based hue strip (a styled native range's track pseudo-elements proved unreliable; don't reintroduce one), and value fields with an **RGB / HSL / Hex** format switcher (typed values apply bit-exact; `hexToHsv`/`hsvToHex` convert through THREE's HSL) — plus Gloss and Metal slider+number pairs. Multi-material parts get per-group **tabs** at the top (`buildMatTabs`/`selectMatTab`/`loadMatPopover`). Gotchas: the popover is `display:flex`, so `.mat-pop[hidden]{display:none}` in styles.css is what makes closing work — keep it; it's positioned fully **left of the objects panel** (`anchor.closest(".panel")`), not beside the swatch. `setPartMaterialColor` delegates to `setPartColor` for single-material parts; `refreshPartSwatches` repaints the row icon, `updateMatTab` the active tab. **Finish:** `part.rough` / `part.metal` (persisted as `parts[].rough` / `parts[].metal`, 0..1, `null` = global default) hold per-group overrides, edited via the popover's Gloss/Metal sliders (`setPartGloss`/`setPartMetal`; gloss = 1 − roughness). The Light Lab roughness/metalness knobs (`setRoughness`/`setMetalness`) skip groups with an explicit entry. The Gloss/Metal sliders are gated behind `DEV.materialFinish` (top-of-file dev options) — off ships a colour-only picker, but saved/.mtl finish still loads and persists underneath; `matPop._refs.gloss`/`metal` are `null` when off, so guard every access.

### Markers follow moved parts
Measurement endpoints and annotation anchors are **bound** to the part they were placed on, stored in that part's mesh-local space (`aLocal/bLocal`, `pLocal` + `aPart/bPart/part`). `markerLocalFromPart()` re-derives marker-space position from the part's live pose; `refreshMarkers()` runs after every move (`onPartMoving`, `afterCoordEdit`, resets). Bindings persist via `{fileId,index}` refs; older unbound saves auto-bind to a nearby surface (`nearestPartBinding`, tolerance-gated).

### Rendering specifics
- **X-ray pass:** measurements/annotations draw twice — a depth-tested solid pass plus a faded `depthTest:false` pass (`renderOrder:4`) so the line/dots show through the model. CSS2D labels have no depth, so occlusion is faked per-frame by raycasting camera→label (`updateLabelOcclusion`).
- **CSS2D label caveats:** a `CSS2DObject` label **ignores its parent group's `.visible`** — toggle `label.visible` explicitly (see `applyMeasDisplay`/`applyAnnotDisplay`). Removing a group does **not** clean up the label's DOM node — remove `m.el`/`a.el` explicitly.
- **Markers stay constant pixel size** via `updateMarkerScales()` each frame (`worldPerPixel`).
- **Section view** clips part materials with a `THREE.Plane` and fills the cut with stencil-based caps (`makeStencilGroup`/`buildSection`). The per-axis offset (`state.section.offsets`) is an **absolute signed mm distance from the world origin** (datum = the floor grid, which is fixed at the origin), not a bounding-box fraction — so the cut stays put as parts move/hide/appear. The slider is just a cosmetic knob over the live model extent (`dToT`/`tToD`); the stored value owns the cut. `null` = auto-centre on first build. Saved files tag `unit:"mm"`; legacy fractional offsets are migrated on load (`migrateLegacySectionOffsets`). The **floor grid** is centred on the world origin at Y=0 (`positionGrid`), so its centre cross marks the X=0/Z=0 section datum. Shadows are VSM (soft self-shadow), with the key light split into a faint caster + a non-casting main.

### UI wiring
All event binding is centralized in `wireUI()`. Tool modes (`orbit | measure | removeMeas | annotate | removeAnnot`) are mutually exclusive and routed through `setMode()`; the canvas click/drag split is in `onPointerUp` (`CLICK_SLOP`). Re-branding: edit `src/brand.config.js` (name/copyright/confidential), `src/brand-colors.css` (5-value palette), and `src/brand-logo.svg` (logo mark) — all three are inlined by `build.mjs`; no other file needs to change.

### Branding
All brand-only content lives in three files inlined by `build.mjs`: `src/brand.config.js` (a bare top-level `const BRAND`, visible to `app.js`'s IIFE via shared script-scope — must stay first in `build.mjs`'s `scripts` array), `src/brand-colors.css` (`--accent/--slate/--gray/--accent-light/--bg`; everything else in `styles.css`'s `:root` is a structural token, not brand identity), and `src/brand-logo.svg` (header logo, inlined as-is with no build-time recoloring — same treatment as `src/favicon.svg`, so a custom favicon/logo's own colors are never overwritten).

## External CAD integration
A post-export step takes empty `Standalone_3D_Viewer.html`, replaces the `null` in `<script id="embedded-data">` with a JSON state object, and writes a new `.html`. Full schema + a Python example are in `EXPORT_FORMAT.md`. Only `meta` + `files` are required.
