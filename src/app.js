/* ============================================================================
   3D Viewer  —  standalone, offline CAD geometry viewer
   All logic in one IIFE. Depends on globals: THREE, THREE.OrbitControls,
   THREE.OBJLoader, THREE.STLLoader, THREE.GLTFLoader, THREE.CSS2DRenderer.
   ========================================================================== */
(function () {
"use strict";

/* Capture a pristine copy of the document BEFORE we mutate anything, so "Save
   file" can reproduce a fully-working viewer with new data embedded. */
const PRISTINE_HTML = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;

/* ----------------------------------------------------------------------------
   Constants
---------------------------------------------------------------------------- */
/* Branding — re-brand here, and swap the logo in index.html (search "BRAND LOGO"). */
const BRAND = {
  name:         "3D Viewer",   // applied to document.title + header wordmark
  copyright:    "",            // default for Model information, e.g. "© 3D Corp"
  confidential: "",            // default confidential notice ("" = hidden)
};

/* Auto-enable the floor grid the first time a model is imported (drag-drop / file picker)
   into a viewer that has the grid off. Set false to leave the grid state untouched. */
const GRID_ON_IMPORT = true;

/* ----------------------------------------------------------------------------
   DEVELOPER OPTIONS  (flip in source; not part of saved view state)
   ----------------------------------------------------------------------------
   lightPanel    Show the in-app "Light" panel — a lighting / material explorer
                 for dialling in a look. Set false to hide it from the UI.
   lightPreset   Lighting applied on load. Use null to keep the built-in
                 hand-tuned default, or one of LIGHT_PRESETS:
                 "studio" | "threePoint" | "soft" | "dramatic" | "top" |
                 "coolShop" | "sunset" | "moonlight" | "blueprint" | "ember".
                 (Tune values live with the panel, then bake the winner here.)
   env           Boot with the procedural studio environment on (image-based
                 reflections). Needed for the Metal slider to read as metal.
---------------------------------------------------------------------------- */
const DEV = {
  lightPanel:  true,
  lightPreset: "dramatic",
  env:         false,
};

const NEUTRAL_COLOR = 0x9099A2;      // default shaded part color (mid neutral grey)
const CAP_COLOR     = 0xb0534e;      // muted red section caps
const SELECT_EMIS   = 0x12385f;      // selection highlight (emissive)
const BG_COLOR      = 0xF9FAFA;
const CLAY_COLOR    = 0xc3c7cc;      // LIGHT LAB: uniform "clay" override colour
/* LIGHT LAB (temporary): current material knobs, read by makePartMaterial so parts
   loaded while the panel is active inherit the explored look. */
const MAT = { roughness: 0.6, metalness: 0.0, flat: false, envIntensity: 1.0 };
const $  = (id) => document.getElementById(id);
const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/* ----------------------------------------------------------------------------
   Application state (everything needed to reproduce the document)
---------------------------------------------------------------------------- */
const state = {
  meta: {
    title: "",
    description: "",
    exportDate: "",
    copyright: BRAND.copyright,
    confidential: BRAND.confidential,
    upAxis: "z+",
    projection: "persp",
    gridOn: false,
  },
  files: [],         // {id, name, format, data(base64)}
  parts: [],         // runtime: {id, fileId, index, name, color, mesh, visible}
  measurements: [],  // runtime: {id, a:Vec3(local), b:Vec3(local), group, label}
  annotations: [],   // runtime: {id, p:Vec3(local), text, obj(CSS2DObject), marker}
  section: { on: false, axis: "x", flip: false, offsets: { x: null, y: null, z: null } },  // absolute mm from origin/grid; null = auto-centre
};

let fileSeq = 0, partSeq = 0, markSeq = 0;
const uid = (p) => p + "_" + (Date.now().toString(36)) + "_" + (Math.random().toString(36).slice(2, 7));

/* ----------------------------------------------------------------------------
   Three.js scene
---------------------------------------------------------------------------- */
let renderer, labelRenderer, scene, perspCam, orthoCam, activeCam, controls;
let transformControls;          // per-part move/rotate gizmo (Objects → Transform parts)
let xformMode = false;          // is the transform-edit mode on?
let gizmoMode = "translate";    // current gizmo: "translate" | "rotate"
let modelRoot;      // holds loaded geometry; rotated so file "up" -> world +Y
let markerRoot;     // child of modelRoot: measurements + annotations (file space)
let gridHelper;
let shadowLight;    // the key light; also casts the soft self-shadow
let ambLight, hemiLight, keyLight, keyMainLight, fillLight, rimLight;   // LIGHT LAB: hoisted so the panel can tweak them live
const viewportEl = $("viewport");

function initThree() {
  installNeutralToneMapping();   // LIGHT LAB: register Khronos PBR Neutral before the renderer compiles anything
  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG_COLOR);

  renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;       // variance shadows: support a real blur radius
  viewportEl.appendChild(renderer.domElement);

  labelRenderer = new THREE.CSS2DRenderer();
  labelRenderer.domElement.style.position = "absolute";
  labelRenderer.domElement.style.top = "0";
  labelRenderer.domElement.style.left = "0";
  labelRenderer.domElement.style.pointerEvents = "none";
  $("css2d").appendChild(labelRenderer.domElement);

  perspCam = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
  perspCam.up.set(0, 1, 0);
  orthoCam.up.set(0, 1, 0);
  activeCam = perspCam;

  controls = new THREE.OrbitControls(activeCam, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.9;
  controls.zoomToCursor = true;

  // Per-part transform gizmo. Lives in the scene but stays detached/hidden until the
  // Objects panel "Transform parts" toggle attaches it to a selected part's mesh.
  transformControls = new THREE.TransformControls(activeCam, renderer.domElement);
  transformControls.setMode("translate");   // switched at runtime by the floating Move/Rotate bar
  transformControls.setSpace("world");
  transformControls.setRotationSnap(null);   // free rotation; hold Shift to snap to 5° (see keydown/keyup)
  transformControls.addEventListener("dragging-changed", (e) => { controls.enabled = !e.value; });
  transformControls.addEventListener("mouseDown", onPartMoveStart);
  transformControls.addEventListener("objectChange", onPartMoving);
  transformControls.addEventListener("mouseUp", onPartMoveEnd);
  transformControls.enabled = false;
  transformControls.visible = false;
  scene.add(transformControls);

  // Lighting: a hemisphere gradient (top brighter than bottom) gives every face a
  // readable tone — kept below clipping so even a white part shows falloff — plus a
  // gentle key for a directional cue. (LIGHT LAB hoists these to module scope so the
  // temporary Light panel can drive their intensities/colours live.)
  ambLight = new THREE.AmbientLight(0xffffff, 0.2);
  scene.add(ambLight);
  hemiLight = new THREE.HemisphereLight(0xffffff, 0x333333, 0.55);
  scene.add(hemiLight);

  // The key light is split in two so the self-shadow can be really faint without
  // flattening the shading: a low-intensity shadow CASTER plus a same-direction
  // non-casting light carrying the rest of the key brightness. Lit faces get the full
  // KEY_TOTAL; shadowed faces lose only the caster's small SHADOW_SHARE.
  const KEY_TOTAL = 0.6, SHADOW_SHARE = 0.1;
  keyLight = new THREE.DirectionalLight(0xffffff, SHADOW_SHARE); keyLight.position.set(0.7, 1.3, 1.0);
  keyMainLight = new THREE.DirectionalLight(0xffffff, KEY_TOTAL - SHADOW_SHARE); keyMainLight.position.set(0.7, 1.3, 1.0);
  fillLight = new THREE.DirectionalLight(0xffffff, 0.34); fillLight.position.set(-1.1, 0.4, -0.6);
  rimLight = new THREE.DirectionalLight(0xffffff, 0.28); rimLight.position.set(0.2, -0.9, -0.8);

  // Only `keyLight` casts the soft self-shadow. Its frustum + distance are sized to the
  // model in updateShadowCamera(); only the *direction* (its position here) matters now.
  shadowLight = keyLight;
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.bias = -0.0002;       // small depth offset to kill self-shadow acne
  keyLight.shadow.radius = 8;           // penumbra blur (VSM) — higher = softer edges
  keyLight.shadow.blurSamples = 35;     // smoothness of that blur
  scene.add(keyLight.target);           // target must be in the scene graph to take effect

  scene.add(keyLight, keyMainLight, fillLight, rimLight);

  modelRoot = new THREE.Group();
  markerRoot = new THREE.Group();
  modelRoot.add(markerRoot);
  scene.add(modelRoot);
  applyUpAxis(state.meta.upAxis);

  onResize();
  window.addEventListener("resize", onResize);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointermove", onPointerMoveHover);

  animate();
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  perspCam.aspect = w / h;
  perspCam.updateProjectionMatrix();
  updateOrthoFrustum();
}

/* Keep ortho frustum matching aspect; vertical half-size driven by orthoHalf. */
let orthoHalf = 1;
function updateOrthoFrustum() {
  const aspect = window.innerWidth / window.innerHeight;
  orthoCam.top = orthoHalf;
  orthoCam.bottom = -orthoHalf;
  orthoCam.left = -orthoHalf * aspect;
  orthoCam.right = orthoHalf * aspect;
  orthoCam.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateMarkerScales();
  updateLightLab();          // LIGHT LAB: headlight follows the camera
  renderer.render(scene, activeCam);
  labelRenderer.render(scene, activeCam);
}

/* ----------------------------------------------------------------------------
   Up-axis orientation: rotate modelRoot so the chosen file axis points to +Y.
---------------------------------------------------------------------------- */
function applyUpAxis(code) {
  state.meta.upAxis = code;
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3();
  switch (code) {
    case "z+": up.set(0, 0, 1); break;
    case "z-": up.set(0, 0, -1); break;
    case "x+": up.set(1, 0, 0); break;
    case "x-": up.set(-1, 0, 0); break;
    case "y+": up.set(0, 1, 0); break;
    case "y-": up.set(0, -1, 0); break;
  }
  // rotation mapping `up` -> world +Y
  q.setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
  modelRoot.quaternion.copy(q);
  modelRoot.updateMatrixWorld(true);
  if (gridHelper) ensureGrid();   // re-fit the origin-anchored floor to the new orientation
  if (state.section.on) buildSection();
  syncChips("#oriChips .chip", "axis", code);
}

/* ----------------------------------------------------------------------------
   Geometry helpers (world bounding box, framing, views)
---------------------------------------------------------------------------- */
function getWorldBox() {
  const box = new THREE.Box3();
  let any = false;
  state.parts.forEach((p) => {
    if (!p.mesh.visible) return;
    p.mesh.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(p.mesh);
    if (b.isEmpty()) return;
    box.union(b); any = true;
  });
  return any ? box : null;
}

/* local (file-space) bounding box across all parts, for true mm dimensions */
function getLocalBox() {
  const box = new THREE.Box3();
  let any = false;
  state.parts.forEach((p) => {
    const g = p.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return;
    box.union(g.boundingBox); any = true;
  });
  return any ? box : null;
}

const VIEW_DIRS = {
  iso:    new THREE.Vector3( 1,  0.8,  1),
  front:  new THREE.Vector3( 0,  0,  1),
  back:   new THREE.Vector3( 0,  0, -1),
  right:  new THREE.Vector3( 1,  0,  0),
  left:   new THREE.Vector3(-1,  0,  0),
  top:    new THREE.Vector3( 0,  1,  0),
  bottom: new THREE.Vector3( 0, -1,  0),
};

function setView(name) {
  const box = getWorldBox();
  if (!box) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const center = sphere.center.clone();
  const radius = sphere.radius || 1;                 // worst-case projected extent at any angle
  const margin = 1.18;                               // leave a little breathing room
  const dir = (VIEW_DIRS[name] || VIEW_DIRS.iso).clone().normalize();

  // perspective: distance so the bounding sphere fits in both vertical and horizontal fov
  const vFov = perspCam.fov * Math.PI / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * perspCam.aspect);
  const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * margin;

  controls.target.copy(center);
  perspCam.position.copy(center).add(dir.clone().multiplyScalar(dist));
  // Keep the orbit up-axis as world-Y for every view (incl. top/bottom). OrbitControls
  // orbits around up (azimuth) and tips away from it (polar), so a horizontal drag is a
  // turntable spin and a vertical drag is a tilt — consistent across all views. For a
  // straight-down top/bottom view the camera sits a hair off the pole (handled by the
  // controls), which keeps orientation stable instead of pitching the scene sideways.
  perspCam.up.set(0, 1, 0);

  // ortho: same direction; frustum half-height fits the sphere in the smaller dimension
  orthoCam.position.copy(perspCam.position);
  orthoCam.up.copy(perspCam.up);
  orthoHalf = radius * margin * Math.max(1, 1 / perspCam.aspect);
  updateOrthoFrustum();
  orthoCam.zoom = 1;
  applyCameraClip(dist, radius);
  updateShadowCamera(center, radius);
  controls.update();
}

/* Near/far chosen so geometry never clips when dollying in close. Near is kept
   small (independent of distance) so zooming in does not cut the model. */
function applyCameraClip(dist, radius) {
  perspCam.near = Math.max(0.05, radius * 0.002);
  perspCam.far = (dist + radius) * 6;
  perspCam.updateProjectionMatrix();
  orthoCam.near = -(dist + radius * 4);
  orthoCam.far = dist + radius * 4;
  orthoCam.updateProjectionMatrix();
}

/* Fit the directional shadow's orthographic frustum + distance to the model so the
   self-shadow stays crisp at any model scale (CAD parts range from mm to metres). */
let SHADOW_DIR = new THREE.Vector3(0.7, 1.3, 1.0).normalize();   // matches key-light direction (LIGHT LAB retargets this)
let _shadowCenter = null, _shadowRadius = 0;                     // LIGHT LAB: last fit, so the key direction can be re-aimed
function updateShadowCamera(center, radius) {
  if (!shadowLight || !center) return;
  _shadowCenter = center.clone(); _shadowRadius = radius;
  const r = Math.max(radius, 1e-3);
  const dist = r * 4;
  shadowLight.position.copy(center).addScaledVector(SHADOW_DIR, dist);
  shadowLight.target.position.copy(center);
  shadowLight.target.updateMatrixWorld();

  const cam = shadowLight.shadow.camera;   // orthographic for a directional light
  const half = r * 1.25;                   // margin so the model never spills past the frustum
  cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
  cam.near = dist - r * 1.5;
  cam.far  = dist + r * 1.5;
  cam.updateProjectionMatrix();
  // Keep normalBias small: too large detaches the contact shadow ("peter-panning"),
  // leaving a hard edge floating off the surface. The VSM blur hides most acne, so a
  // light touch is enough.
  shadowLight.shadow.normalBias = r * 0.0015;
  if (groundCatcher && groundCatcher.visible) positionGroundCatcher();   // LIGHT LAB: keep the floor under the model
}

/* Fit-to-view: reframe to the model WITHOUT changing the viewing angle (scale only). */
function fitToView() {
  const box = getWorldBox();
  if (!box) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const center = sphere.center.clone();
  const radius = sphere.radius || 1;
  const margin = 1.18;
  // preserve current viewing direction (camera -> target)
  const dir = activeCam.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-9) dir.copy(VIEW_DIRS.iso);
  dir.normalize();

  const vFov = perspCam.fov * Math.PI / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * perspCam.aspect);
  const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * margin;

  controls.target.copy(center);
  perspCam.position.copy(center).add(dir.clone().multiplyScalar(dist));
  orthoCam.position.copy(center).add(dir.clone().multiplyScalar(dist));
  orthoCam.up.copy(activeCam.up);
  orthoHalf = radius * margin * Math.max(1, 1 / perspCam.aspect);
  updateOrthoFrustum();
  orthoCam.zoom = 1;
  applyCameraClip(dist, radius);
  updateShadowCamera(center, radius);
  controls.update();
}

let currentViewName = "iso";

/* ----------------------------------------------------------------------------
   Projection toggle (perspective / orthographic)
---------------------------------------------------------------------------- */
function setProjection(mode) {
  state.meta.projection = mode;
  const from = activeCam;
  const to = mode === "ortho" ? orthoCam : perspCam;
  to.position.copy(from.position);
  to.up.copy(from.up);
  activeCam = to;
  controls.object = to;
  if (transformControls) transformControls.camera = to;
  controls.update();
  $("btnProj").classList.toggle("active", mode === "ortho");
  $("btnProj").title = mode === "ortho" ? "Orthographic (click for perspective)" : "Perspective (click for orthographic)";
}

/* ----------------------------------------------------------------------------
   Materials
---------------------------------------------------------------------------- */
function makePartMaterial(colorHex) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorHex),
    roughness: MAT.roughness, metalness: MAT.metalness,   // LIGHT LAB-driven; defaults give a little specular so dark parts catch light
    envMapIntensity: MAT.envIntensity,                    // LIGHT LAB-driven; only visible when scene.environment is set (Environment toggle)
    side: THREE.DoubleSide,
    flatShading: MAT.flat,
  });
}

/* ----------------------------------------------------------------------------
   Loading models
---------------------------------------------------------------------------- */
const objLoader = new THREE.OBJLoader();
const stlLoader = new THREE.STLLoader();
const gltfLoader = new THREE.GLTFLoader();

function formatFromName(name) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "obj") return "obj";
  if (ext === "stl") return "stl";
  if (ext === "glb" || ext === "gltf") return "glb";
  return null;
}

/* parse raw bytes -> THREE.Object3D (group of meshes), async via callback */
function parseModel(format, buffer, done) {
  try {
    if (format === "obj") {
      const text = new TextDecoder().decode(buffer);
      done(objLoader.parse(text));
    } else if (format === "stl") {
      const geo = stlLoader.parse(buffer);
      const g = new THREE.Group(); g.add(new THREE.Mesh(geo, makePartMaterial(NEUTRAL_COLOR)));
      done(g);
    } else if (format === "glb") {
      gltfLoader.parse(buffer, "", (gltf) => done(gltf.scene), (e) => { console.error(e); done(null); });
    } else { done(null); }
  } catch (e) { console.error("parse error", e); done(null); }
}

/* register a parsed object's meshes as parts under modelRoot */
function registerObject(object3d, fileId, metaParts) {
  const meshes = [];
  object3d.updateMatrixWorld(true);
  object3d.traverse((c) => { if (c.isMesh && c.geometry) meshes.push(c); });

  meshes.forEach((mesh, i) => {
    // bake any loader transform into geometry so part lives in true file space
    if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingBox();
    mesh.matrixAutoUpdate = true;

    const pm = metaParts && metaParts[i];
    const color = pm && pm.color != null ? pm.color : NEUTRAL_COLOR;
    mesh.material = makePartMaterial(color);
    mesh.userData.baseColor = color;

    const part = {
      id: uid("p"),
      fileId,
      index: i,
      name: (pm && pm.name) || mesh.name || ("Part " + (state.parts.length + 1)),
      color,
      mesh,
      visible: pm ? pm.visible !== false : true,
    };
    mesh.userData.partId = part.id;
    mesh.visible = part.visible;
    mesh.castShadow = true;       // each part shadows itself and the others
    mesh.receiveShadow = true;
    modelRoot.add(mesh);

    // LIGHT LAB: inherit the active exploration look on parts loaded while it's on
    if (LIGHT_LAB.clay) mesh.material.color.set(CLAY_COLOR);
    if (LIGHT_LAB.edges) addPartEdges(mesh);

    // Two transform layers (see serializeState):
    //  - loader*: the pristine geometry-space pose; the immutable anchor for saved deltas
    //  - base*  : the baseline / reset-target ("Save transforms as default" shifts it here)
    //  - mesh.* : the current pose (a move saved on top of the baseline)
    part.loaderPos = mesh.position.clone();
    part.loaderQuat = mesh.quaternion.clone();
    part.loaderScale = mesh.scale.clone();

    part.basePos = part.loaderPos.clone();
    part.baseQuat = part.loaderQuat.clone();
    part.baseScale = part.loaderScale.clone();
    if (pm && pm.dpos) part.basePos.add(new THREE.Vector3().fromArray(pm.dpos));
    if (pm && pm.dquat) part.baseQuat.fromArray(pm.dquat);
    if (pm && pm.dscale) part.baseScale.fromArray(pm.dscale);

    mesh.position.copy(part.basePos);
    mesh.quaternion.copy(part.baseQuat);
    mesh.scale.copy(part.baseScale);
    if (pm && pm.pos) mesh.position.copy(part.basePos).add(new THREE.Vector3().fromArray(pm.pos));
    if (pm && pm.quat) mesh.quaternion.fromArray(pm.quat);
    if (pm && pm.scale) mesh.scale.fromArray(pm.scale);
    mesh.updateMatrixWorld(true);

    state.parts.push(part);
  });
  return meshes.length;
}

/* high-level: add a file (raw bytes) to the scene */
function addFile(name, buffer, opts) {
  opts = opts || {};
  const format = opts.format || formatFromName(name);
  if (!format) { toast("Unsupported file: " + name); return Promise.resolve(false); }

  return new Promise((resolve) => {
    parseModel(format, buffer, (object) => {
      if (!object) { toast("Could not read " + name); resolve(false); return; }
      const fileId = opts.fileId || uid("f");
      if (!opts.skipStore) {
        const fileRec = { id: fileId, name, format };
        // DEFLATE the raw bytes so the embedded/saved copy is a fraction of the size
        // (OBJ/STL text compresses ~85-90%). Falls back to raw if pako is unavailable.
        try { fileRec.data = abToB64(pako.deflate(new Uint8Array(buffer))); fileRec.enc = "deflate"; }
        catch (e) { console.error("deflate failed, storing raw", name, e); fileRec.data = abToB64(buffer); }
        state.files.push(fileRec);
      }
      const n = registerObject(object, fileId, opts.metaParts);
      if (n === 0) toast("No geometry found in " + name);

      if (!state.meta.title) {
        state.meta.title = name.replace(/\.[^.]+$/, "");
      }
      if (!state.meta.exportDate && !opts.fromState) {
        state.meta.exportDate = todayStr();
      }
      resolve(true);
    });
  });
}

/* ----------------------------------------------------------------------------
   Selection
---------------------------------------------------------------------------- */
let selectedId = null;

function selectPart(id, fromList) {
  if (id && id === selectedId) { deselect(); return; }  // clicking again toggles off
  if (selectedId) {
    const prev = partById(selectedId);
    if (prev) prev.mesh.material.emissive.setHex(0x000000);
  }
  selectedId = id;
  const p = partById(id);
  if (p) {
    p.mesh.material.emissive.setHex(SELECT_EMIS);
    p.mesh.material.emissiveIntensity = 0.35;
  }
  if (xformMode) { if (p) attachGizmo(id); else detachGizmo(); }
  refreshObjInfo();
  highlightRow(id);
}

function deselect() {
  if (selectedId) {
    const p = partById(selectedId);
    if (p) p.mesh.material.emissive.setHex(0x000000);
  }
  selectedId = null;
  detachGizmo();
  refreshObjInfo();
  highlightRow(null);
}

function partById(id) { return state.parts.find((p) => p.id === id); }

/* ----------------------------------------------------------------------------
   Marker ↔ part binding — lets measurements / annotations ride along when the
   part they were placed on is moved, rotated or scaled. A bound point is stored
   in the part mesh's local space; its marker-space position is re-derived on
   demand from the part's live pose.
---------------------------------------------------------------------------- */
// runtime part ids are regenerated on reload, so persist a stable file+index ref
function partRef(partId) { const p = partById(partId); return p ? { fileId: p.fileId, index: p.index } : null; }
function partIdFromRef(ref) {
  if (!ref) return null;
  const p = state.parts.find((x) => x.fileId === ref.fileId && x.index === ref.index);
  return p ? p.id : null;
}
// part-local point -> current markerRoot-local point (follows the live mesh pose)
function markerLocalFromPart(partId, partLocal) {
  const p = partById(partId);
  if (!p) return null;
  p.mesh.updateMatrixWorld();
  return markerRoot.worldToLocal(p.mesh.localToWorld(partLocal.clone()));
}
// Anchor a free marker-space point to the nearest part surface. Used for points
// from older saved files that predate binding; returns null when no part is close
// enough for the point to plausibly belong to it (so free-floating points stay put).
const _nbWorld = new THREE.Vector3(), _nbClamp = new THREE.Vector3();
function nearestPartBinding(localVec) {
  markerRoot.localToWorld(_nbWorld.copy(localVec));
  let best = null, bestD = Infinity;
  state.parts.forEach((p) => {
    const g = p.mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
    p.mesh.updateMatrixWorld();
    const b = g.boundingBox.clone().applyMatrix4(p.mesh.matrixWorld);
    const d = b.clampPoint(_nbWorld, _nbClamp).distanceTo(_nbWorld);
    if (d < bestD) { bestD = d; best = p; }
  });
  if (!best) return null;
  const box = getWorldBox();
  const diag = box ? box.getSize(new THREE.Vector3()).length() : 1;
  if (bestD > diag * 0.02) return null;
  return { partId: best.id, partLocal: best.mesh.worldToLocal(_nbWorld.clone()) };
}
// re-derive every bound marker's geometry from its part's current pose
function refreshMarkers() {
  state.measurements.forEach(updateMeasurementGeometry);
  state.annotations.forEach(refreshAnnotation);
}

/* ----------------------------------------------------------------------------
   Per-part transform (move / rotate gizmo)  —  Objects panel → "Transform parts"
---------------------------------------------------------------------------- */
// A part is "moved" when its mesh transform differs from the baseline captured at load.
const XFORM_EPS = 1e-4;
function partMoved(p) {
  if (!p || !p.basePos) return false;
  if (p.mesh.position.distanceToSquared(p.basePos) > XFORM_EPS * XFORM_EPS) return true;
  if (p.mesh.scale.distanceToSquared(p.baseScale) > XFORM_EPS * XFORM_EPS) return true;
  return p.mesh.quaternion.angleTo(p.baseQuat) > XFORM_EPS;
}

function attachGizmo(id) {
  const p = partById(id);
  if (!p) { detachGizmo(); return; }
  transformControls.attach(p.mesh);
  transformControls.setMode(gizmoMode);
  transformControls.enabled = true;
  transformControls.visible = true;
  updatePartCoords();
}
function detachGizmo() {
  if (!transformControls) return;
  transformControls.detach();
  transformControls.enabled = false;
  transformControls.visible = false;
  updatePartCoords();
}

function setXformMode(on) {
  xformMode = on;
  $("btnXform").classList.toggle("active", on);
  document.body.classList.toggle("xediting", on);
  $("xformBar").classList.toggle("show", on);
  if (on) { const p = partById(selectedId); if (p) attachGizmo(selectedId); }
  else { detachGizmo(); hideXformReadout(); }
  updatePartCoords();
}

function setGizmoMode(m) {
  gizmoMode = m;
  if (transformControls) transformControls.setMode(m);
  $("xfMove").classList.toggle("active", m === "translate");
  $("xfRotate").classList.toggle("active", m === "rotate");
}

/* live read-out (distance while moving, angle while rotating) ---------------- */
let dragStartPos = null, dragStartQuat = null;
function showXformReadout(html) { const r = $("xformReadout"); r.innerHTML = html; r.classList.add("show"); }
function hideXformReadout() { $("xformReadout").classList.remove("show"); }

function onPartMoveStart() {
  const o = transformControls.object;
  if (!o) return;
  dragStartPos = o.position.clone();
  dragStartQuat = o.quaternion.clone();
}
// fires continuously while a handle is dragged
function onPartMoving() {
  const o = transformControls.object;
  if (!o || !dragStartPos) return;
  if (gizmoMode === "rotate") {
    const deg = THREE.MathUtils.radToDeg(dragStartQuat.angleTo(o.quaternion));
    showXformReadout('↻ <b>' + deg.toFixed(0) + '°</b>');
  } else {
    const d = o.position.clone().sub(dragStartPos);
    showXformReadout('Δ ' + fmt(d.x) + ' · ' + fmt(d.y) + ' · ' + fmt(d.z) + ' mm · <b>' + fmt(d.length()) + ' mm</b>');
  }
  updatePartCoords();
  refreshMarkers();   // measurements/annotations on this part track the drag
}

// dragging a handle finished: keep dependent visuals in sync and surface the reset UI
function onPartMoveEnd() {
  hideXformReadout();
  if (state.section.on) buildSection();
  updateXformResetUI();
  updatePartCoords();
  refreshObjInfo();
}

function resetPartTransform(id) {
  const p = partById(id);
  if (!p) return;
  p.mesh.position.copy(p.basePos);
  p.mesh.quaternion.copy(p.baseQuat);
  p.mesh.scale.copy(p.baseScale);
  p.mesh.updateMatrixWorld(true);
  if (state.section.on) buildSection();
  updateXformResetUI();
  updatePartCoords();
  refreshObjInfo();
  refreshMarkers();
}

function resetAllTransforms() {
  state.parts.forEach((p) => { p.mesh.position.copy(p.basePos); p.mesh.quaternion.copy(p.baseQuat); p.mesh.scale.copy(p.baseScale); p.mesh.updateMatrixWorld(true); });
  if (state.section.on) buildSection();
  updateXformResetUI();
  updatePartCoords();
  refreshObjInfo();
  refreshMarkers();
}

// bake the current poses into the baseline: Reset now returns here, and "Save file"
// persists these as the default (no part is "moved" afterwards, so the reset UI hides)
function saveTransformsAsDefault() {
  closeMenu();
  if (state.parts.length === 0) { toast("No parts loaded"); return; }
  state.parts.forEach((p) => { p.basePos.copy(p.mesh.position); p.baseQuat.copy(p.mesh.quaternion); p.baseScale.copy(p.mesh.scale); });
  updateXformResetUI();
  updatePartCoords();
  toast("Current transforms set as default");
}

// show the per-row + "Reset all" controls only when at least one part has been altered
function updateXformResetUI() {
  const any = state.parts.some(partMoved);
  const btn = $("btnResetXform");
  if (btn) btn.style.display = any ? "" : "none";
  rebuildObjectsPanel();
}

// numeric fields for trimming, etc.; degrees with up to 1 dp, scale with up to 3 dp
const fmtDeg = (d) => String(+(d).toFixed(1));
const fmtScale = (s) => String(+(s).toFixed(3));
const _euler = new THREE.Euler();

// Position / rotation / scale fields for the selected part (visible only while transforming)
function updatePartCoords() {
  const box = $("partCoords");
  if (!box) return;
  const p = (xformMode && selectedId) ? partById(selectedId) : null;
  if (!p) { box.style.display = "none"; return; }
  box.style.display = "";
  const m = p.mesh;
  const af = document.activeElement;                       // don't clobber a field being typed into
  const set = (id, val) => { const el = $(id); if (af !== el) el.value = val; };
  set("posX", fmt(m.position.x)); set("posY", fmt(m.position.y)); set("posZ", fmt(m.position.z));
  _euler.setFromQuaternion(m.quaternion, "XYZ");
  set("rotX", fmtDeg(THREE.MathUtils.radToDeg(_euler.x)));
  set("rotY", fmtDeg(THREE.MathUtils.radToDeg(_euler.y)));
  set("rotZ", fmtDeg(THREE.MathUtils.radToDeg(_euler.z)));
  set("scaleU", fmtScale(m.scale.x));
}

// commit a typed position coordinate
function commitPartCoord(axis) {
  if (!selectedId) return;
  const p = partById(selectedId); if (!p) return;
  const v = parseFloat($("pos" + axis.toUpperCase()).value);
  if (isFinite(v)) { p.mesh.position[axis] = v; afterCoordEdit(p); }
  updatePartCoords();
}

// commit typed rotation (Euler XYZ degrees, rebuilt from all three fields)
function commitPartRot() {
  if (!selectedId) return;
  const p = partById(selectedId); if (!p) return;
  const rx = parseFloat($("rotX").value), ry = parseFloat($("rotY").value), rz = parseFloat($("rotZ").value);
  if (isFinite(rx) && isFinite(ry) && isFinite(rz)) {
    _euler.set(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz), "XYZ");
    p.mesh.quaternion.setFromEuler(_euler);
    afterCoordEdit(p);
  }
  updatePartCoords();
}

// commit typed uniform scale (overall, applied to all axes)
function commitPartScale() {
  if (!selectedId) return;
  const p = partById(selectedId); if (!p) return;
  const s = parseFloat($("scaleU").value);
  if (isFinite(s) && s > 0) { p.mesh.scale.set(s, s, s); afterCoordEdit(p); }
  updatePartCoords();
}

// shared follow-up after any typed transform edit
function afterCoordEdit(p) {
  p.mesh.updateMatrixWorld(true);
  if (state.section.on) buildSection();
  updateXformResetUI();
  refreshMarkers();
}

/* ----------------------------------------------------------------------------
   Pointer interaction (select / measure / annotate / remove-annot)
---------------------------------------------------------------------------- */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let mode = "orbit";  // orbit | measure | annotate | removeAnnot
let measurePending = null;  // first picked local point

function setMode(m) {
  mode = m;
  $("btnMeasure").classList.toggle("active", m === "measure");
  $("btnRemoveMeas").classList.toggle("active", m === "removeMeas");
  $("btnAnnot").classList.toggle("active", m === "annotate");
  $("btnRemoveAnnot").classList.toggle("active", m === "removeAnnot");
  // Rotation stays enabled in every mode. A drag orbits the model; a click (no drag,
  // see onPointerUp) places a measurement/annotation point or changes selection. This
  // lets you place point A, rotate to the far side, then place point B.
  measurePending = null; clearTempDot();
  document.querySelectorAll(".label.annot").forEach((el) => el.classList.toggle("removable", m === "removeAnnot"));
  document.querySelectorAll(".label.measure").forEach((el) => el.classList.toggle("removable", m === "removeMeas"));
  if (m === "measure") showHint('Click two points on the model to measure. <kbd>Esc</kbd> to stop.');
  else if (m === "removeMeas") showHint('Click a measurement to remove it. <kbd>Esc</kbd> to stop.');
  else if (m === "annotate") showHint('Click a point to add a note, then type. Drag a label to reposition. <kbd>Esc</kbd> to stop.');
  else if (m === "removeAnnot") showHint('Click an annotation to remove it. <kbd>Esc</kbd> to stop.');
  else hideHint();
}

function pickPoint(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(ndc, activeCam);
  const targets = state.parts.filter((p) => p.mesh.visible).map((p) => p.mesh);
  const hits = raycaster.intersectObjects(targets, false);
  return hits.length ? hits[0] : null;
}

// Click-vs-drag: a left press that releases within CLICK_SLOP px (and isn't a multi-
// pointer gesture) counts as a click; anything further is a drag the orbit controls own.
const CLICK_SLOP = 5;
let downX = 0, downY = 0, downValid = false;

function onPointerDown(ev) {
  downValid = (ev.button === 0 && ev.isPrimary !== false);
  downX = ev.clientX; downY = ev.clientY;
}

function onPointerUp(ev) {
  if (ev.button !== 0 || !downValid) return;
  downValid = false;
  // a press on / drag of a gizmo handle is owned by TransformControls — never select/deselect
  if (transformControls && (transformControls.dragging || transformControls.axis)) return;
  if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > CLICK_SLOP) return; // was a drag → orbit
  handleClick(ev);
}

function handleClick(ev) {
  if (mode === "orbit") {
    const hit = pickPoint(ev);
    if (hit) selectPart(hit.object.userData.partId);
    else deselect();
    return;
  }
  if (mode === "measure") {
    const hit = pickPoint(ev);
    if (!hit) return;
    const local = markerRoot.worldToLocal(hit.point.clone());
    const partId = hit.object.userData.partId;
    const partLocal = hit.object.worldToLocal(hit.point.clone());   // bind this end to the part it sits on
    if (!measurePending) { measurePending = { local, partId, partLocal }; spawnTempDot(local); }
    else {
      addMeasurement(measurePending.local, local, {
        aPart: measurePending.partId, aLocal: measurePending.partLocal,
        bPart: partId, bLocal: partLocal,
      });
      measurePending = null; clearTempDot();
    }
  } else if (mode === "annotate") {
    const hit = pickPoint(ev);
    if (!hit) return;
    const local = markerRoot.worldToLocal(hit.point.clone());
    const a = addAnnotation(local, "", { isNew: true, part: hit.object.userData.partId, pLocal: hit.object.worldToLocal(hit.point.clone()) });
    // the CSS2D label only attaches to the DOM on the next render frame; wait for it
    // before focusing, or focus()/selection would run on a detached node.
    requestAnimationFrame(() => beginEditAnnotation(a));  // type straight into the floating label
  }
  // removeAnnot handled by clicking the label element directly
}

/* hover read-out while measuring: live distance from pending point */
function onPointerMoveHover(ev) {
  if (mode !== "measure" || !measurePending) return;
  const hit = pickPoint(ev);
  if (!hit) { hideHint(); return; }
  const local = markerRoot.worldToLocal(hit.point.clone());
  const d = local.clone().sub(measurePending.local);
  showHint(`Δ ${fmt(d.x)} · ${fmt(d.y)} · ${fmt(d.z)} mm  →  <b>${fmt(d.length())} mm</b>`);
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Shift" && transformControls) transformControls.setRotationSnap(THREE.MathUtils.degToRad(5));  // hold Shift → snap rotation to 5°
  if (e.key === "Escape") { setMode("orbit"); if (xformMode) setXformMode(false); return; }
  // W/E switch the gizmo while transforming (mirrors the three.js example), unless typing
  if (xformMode && !/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName) && !(document.activeElement && document.activeElement.isContentEditable)) {
    if (e.key === "w" || e.key === "W") setGizmoMode("translate");
    else if (e.key === "e" || e.key === "E") setGizmoMode("rotate");
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Shift" && transformControls) transformControls.setRotationSnap(null);  // release → free rotation
});

/* ----------------------------------------------------------------------------
   Marker scaling: keep spheres a constant pixel size as the view changes
---------------------------------------------------------------------------- */
const SPHERE_PX = 5;
function worldPerPixel(point) {
  const h = window.innerHeight;
  if (activeCam.isPerspectiveCamera) {
    const d = activeCam.position.distanceTo(point);
    return (2 * Math.tan((activeCam.fov * Math.PI / 180) / 2) * d) / h;
  }
  return ((orthoCam.top - orthoCam.bottom) / orthoCam.zoom) / h;
}
const _wp = new THREE.Vector3();
function updateMarkerScales() {
  const scaleObj = (o) => {
    o.getWorldPosition(_wp);
    const s = worldPerPixel(_wp) * SPHERE_PX;
    o.scale.setScalar(s <= 0 ? 1 : s);
  };
  state.measurements.forEach((m) => m.group.children.forEach((c) => { if (c.isMesh) scaleObj(c); }));
  state.annotations.forEach((a) => { if (a.marker) scaleObj(a.marker); });
  if (tempDot) scaleObj(tempDot);
  updateLabelOcclusion();
}

// The line/dots fade through the model on the GPU (depth-tested + x-ray pass), but the
// CSS2D label has no depth, so fade it in CSS when its anchor sits behind the model:
// cast a ray from the camera toward the label and see if a visible part is in front.
const _camToPt = new THREE.Vector3();
function updateLabelOcclusion() {
  if (!state.measurements.length && !state.annotations.length) return;
  const targets = state.parts.filter((p) => p.mesh.visible).map((p) => p.mesh);
  const camPos = activeCam.position;
  const test = (labelObj, visible, el) => {
    if (!visible) return;
    labelObj.getWorldPosition(_wp);
    const dist = _camToPt.copy(_wp).sub(camPos).length();
    let occluded = false;
    if (targets.length && dist > 1e-4) {
      raycaster.set(camPos, _camToPt.multiplyScalar(1 / dist));
      raycaster.far = dist - Math.max(0.5, dist * 0.002); // ignore the surface at the far end
      occluded = raycaster.intersectObjects(targets, false).length > 0;
      raycaster.far = Infinity; // restore for pickPoint
    }
    el.classList.toggle("occluded", occluded);
  };
  state.measurements.forEach((m) => test(m.label, m.group.visible, m.el));
  state.annotations.forEach((a) => test(a.obj, a.group.visible, a.el));
}

/* ----------------------------------------------------------------------------
   Measurement
---------------------------------------------------------------------------- */
const sphereGeo = new THREE.SphereGeometry(1, 16, 12);
let tempDot = null;
function spawnTempDot(local) {
  clearTempDot();
  tempDot = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: MEAS_COLOR }));
  tempDot.position.copy(local);
  markerRoot.add(tempDot);
}
function clearTempDot() { if (tempDot) { markerRoot.remove(tempDot); tempDot = null; } }

const MEAS_COLOR = 0x389d86;   // matches the UI accent (--accent)
const XRAY_OPACITY = 0.3;
function addMeasurement(a, b, bind) {
  bind = bind || {};
  const id = uid("m");
  const group = new THREE.Group();
  const lineGeo = new THREE.BufferGeometry().setFromPoints([a, b]);

  // Solid pass (depth-tested): the dots + line, hidden where the model is in front.
  const matDot = new THREE.MeshBasicMaterial({ color: MEAS_COLOR });
  const da = new THREE.Mesh(sphereGeo, matDot);
  const db = new THREE.Mesh(sphereGeo, matDot);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: MEAS_COLOR }));

  // X-ray pass (no depth test): the same dots + line drawn through the model, faded.
  // Same colour, so where the solid pass is visible the overlay blends in invisibly;
  // only the part behind the model shows up — and only at the reduced opacity.
  const matDotX = new THREE.MeshBasicMaterial({ color: MEAS_COLOR, transparent: true, opacity: XRAY_OPACITY, depthTest: false, depthWrite: false });
  const daX = new THREE.Mesh(sphereGeo, matDotX); daX.renderOrder = 4;
  const dbX = new THREE.Mesh(sphereGeo, matDotX); dbX.renderOrder = 4;
  const lineX = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: MEAS_COLOR, transparent: true, opacity: XRAY_OPACITY, depthTest: false, depthWrite: false }));
  lineX.renderOrder = 4;

  group.add(da, db, line, daX, dbX, lineX);
  markerRoot.add(group);

  const el = document.createElement("div");
  el.className = "label measure";
  const label = new THREE.CSS2DObject(el);
  group.add(label);

  const m = {
    id, a: a.clone(), b: b.clone(), group, label, el, da, db, daX, dbX, lineGeo,
    aPart: bind.aPart || null, aLocal: bind.aLocal ? bind.aLocal.clone() : null,
    bPart: bind.bPart || null, bLocal: bind.bLocal ? bind.bLocal.clone() : null,
  };
  // older saved files carry no binding — anchor each end to a nearby part if there is one
  if (!m.aPart) { const nb = nearestPartBinding(m.a); if (nb) { m.aPart = nb.partId; m.aLocal = nb.partLocal; } }
  if (!m.bPart) { const nb = nearestPartBinding(m.b); if (nb) { m.bPart = nb.partId; m.bLocal = nb.partLocal; } }

  el.addEventListener("click", () => { if (mode === "removeMeas") removeMeasurement(id); });
  el.classList.toggle("removable", mode === "removeMeas");

  state.measurements.push(m);
  updateMeasurementGeometry(m);
  applyMeasDisplay();
  return m;
}

// (re)build a measurement's dots, line and label from its endpoints — re-deriving
// any bound endpoint from its part first, so the measurement follows a moved part.
function updateMeasurementGeometry(m) {
  if (m.aPart && m.aLocal) { const v = markerLocalFromPart(m.aPart, m.aLocal); if (v) m.a.copy(v); }
  if (m.bPart && m.bLocal) { const v = markerLocalFromPart(m.bPart, m.bLocal); if (v) m.b.copy(v); }
  m.da.position.copy(m.a); m.daX.position.copy(m.a);
  m.db.position.copy(m.b); m.dbX.position.copy(m.b);
  m.lineGeo.setFromPoints([m.a, m.b]);
  m.lineGeo.computeBoundingSphere();   // keep the line from being frustum-culled after a move
  const d = m.b.clone().sub(m.a);
  m.el.innerHTML = `${fmt(d.length())} mm<span class="comp">Δ ${fmt(d.x)} · ${fmt(d.y)} · ${fmt(d.z)}</span>`;
  m.label.position.copy(m.a.clone().add(m.b).multiplyScalar(0.5));
}

function removeMeasurement(id) {
  const i = state.measurements.findIndex((m) => m.id === id);
  if (i < 0) return;
  const m = state.measurements[i];
  markerRoot.remove(m.group);
  if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);   // CSS2D node isn't auto-cleaned
  if (m.lineGeo) m.lineGeo.dispose();
  state.measurements.splice(i, 1);
}

function clearMeasurements() {
  // Removing the group detaches the meshes, but the CSS2D label is a DOM node the
  // renderer only cleans up when the label itself is removed — its parent group going
  // away doesn't fire that, so drop the element explicitly or the box lingers.
  state.measurements.forEach((m) => {
    markerRoot.remove(m.group);
    if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
  });
  state.measurements.length = 0;
}

let measDisplay = true;
function applyMeasDisplay() {
  // same caveat as annotations: the CSS2D label ignores its parent group's visibility,
  // so hide the label object explicitly or the dimension pill lingers when toggled off.
  state.measurements.forEach((m) => { m.group.visible = measDisplay; m.label.visible = measDisplay; });
}

/* ----------------------------------------------------------------------------
   Annotations — a marker on the model, a leader line, and a label that floats
   off to the side. The label can be dragged to reposition the callout, and its
   text is edited inline (no modal prompt).
---------------------------------------------------------------------------- */
let annotDisplay = true;
const ANNOT_COLOR = 0x495965;   // logo slate

// Default label spot: offset up-and-right from the anchor in *screen* terms, then
// frozen into local (file) space so the callout stays put as you orbit.
const _cr = new THREE.Vector3(), _cu = new THREE.Vector3(), _aw = new THREE.Vector3();
function defaultLabelLocal(localAnchor) {
  markerRoot.localToWorld(_aw.copy(localAnchor));
  _cr.setFromMatrixColumn(activeCam.matrixWorld, 0);   // camera right (world)
  _cu.setFromMatrixColumn(activeCam.matrixWorld, 1);   // camera up    (world)
  const wpp = worldPerPixel(_aw) || 1;
  const lpWorld = _aw.clone()
    .add(_cr.multiplyScalar(wpp * 72))
    .add(_cu.multiplyScalar(wpp * 54));
  return markerRoot.worldToLocal(lpWorld);
}

function addAnnotation(local, text, opts) {
  opts = opts || {};
  const id = uid("a");
  const group = new THREE.Group();
  const lp = opts.lp ? opts.lp.clone() : defaultLabelLocal(local);

  // anchor marker on the surface (depth-tested, scaled to constant pixel size)
  const marker = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: ANNOT_COLOR }));
  marker.position.copy(local);

  // leader line: solid (depth-tested) + an x-ray pass that shows faded through the model
  const geo = new THREE.BufferGeometry().setFromPoints([local, lp]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: ANNOT_COLOR }));
  const lineX = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: ANNOT_COLOR, transparent: true, opacity: XRAY_OPACITY, depthTest: false, depthWrite: false }));
  lineX.renderOrder = 4;
  group.add(marker, line, lineX);

  // floating label
  const el = document.createElement("div");
  el.className = "label annot";
  const txt = document.createElement("span"); txt.className = "txt"; txt.textContent = text;
  el.appendChild(txt);
  const obj = new THREE.CSS2DObject(el);
  obj.position.copy(lp);
  group.add(obj);

  markerRoot.add(group);

  const a = {
    id, p: local.clone(), lp: lp.clone(), text, group, marker, line, lineX, geo, obj, el, txt,
    _editing: false, _isNew: !!opts.isNew,
    part: opts.part || null, pLocal: opts.pLocal ? opts.pLocal.clone() : null,
  };
  // older saved files carry no binding — anchor to a nearby part if there is one
  if (!a.part) { const nb = nearestPartBinding(a.p); if (nb) { a.part = nb.partId; a.pLocal = nb.partLocal; } }

  el.addEventListener("click", () => { if (mode === "removeAnnot") removeAnnotation(id); });
  el.addEventListener("dblclick", (e) => { if (mode === "removeAnnot") return; e.preventDefault(); beginEditAnnotation(a); });
  el.addEventListener("pointerdown", (e) => onAnnotPointerDown(e, a));  // drag to reposition
  txt.addEventListener("keydown", (e) => onAnnotEditKey(e, a));
  txt.addEventListener("blur", () => { if (a._editing) endEditAnnotation(a, true); });

  el.classList.toggle("removable", mode === "removeAnnot");
  state.annotations.push(a);
  applyAnnotDisplay();
  return a;
}

function updateAnnotGeometry(a) {
  a.marker.position.copy(a.p);
  a.obj.position.copy(a.lp);
  a.geo.setFromPoints([a.p, a.lp]);
  a.geo.computeBoundingSphere();   // keep the line from being frustum-culled after a move
}

// re-derive a bound annotation's anchor from its part, dragging the floating label
// along by the same delta so the callout keeps its shape as the part moves.
function refreshAnnotation(a) {
  if (!a.part || !a.pLocal) return;
  const v = markerLocalFromPart(a.part, a.pLocal);
  if (!v) return;
  const delta = v.clone().sub(a.p);
  if (delta.lengthSq() === 0) return;
  a.p.copy(v);
  a.lp.add(delta);
  updateAnnotGeometry(a);
}

function removeAnnotation(id) {
  const i = state.annotations.findIndex((a) => a.id === id);
  if (i < 0) return;
  const a = state.annotations[i];
  if (a.el && a.el.parentNode) a.el.parentNode.removeChild(a.el);
  if (a.geo) a.geo.dispose();
  markerRoot.remove(a.group);
  state.annotations.splice(i, 1);
}

function applyAnnotDisplay() {
  // group.visible hides the marker + leader (WebGL respects ancestor visibility), but the
  // CSS2D label only checks its own .visible — so toggle the label object explicitly too.
  state.annotations.forEach((a) => { a.group.visible = annotDisplay; a.obj.visible = annotDisplay; });
}

function clearAnnotations() {
  state.annotations.slice().forEach((a) => removeAnnotation(a.id));
}

/* ---- drag the label to reposition the callout ---- */
const _dragPlane = new THREE.Plane();
const _dragN = new THREE.Vector3();
const _dragHit = new THREE.Vector3();
const _dragAnchor = new THREE.Vector3();
function dragLabelTo(clientX, clientY, a) {
  // slide the label across the plane through its anchor that faces the camera, so it
  // keeps roughly the anchor's depth and tracks the cursor naturally.
  markerRoot.localToWorld(_dragAnchor.copy(a.p));
  activeCam.getWorldDirection(_dragN);
  _dragPlane.setFromNormalAndCoplanarPoint(_dragN, _dragAnchor);
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(ndc, activeCam);
  if (raycaster.ray.intersectPlane(_dragPlane, _dragHit)) {
    a.lp.copy(markerRoot.worldToLocal(_dragHit));
    updateAnnotGeometry(a);
  }
}

function onAnnotPointerDown(e, a) {
  if (a._editing) return;                                          // let the caret/selection work
  if (mode === "removeAnnot") return;                              // click removes instead
  e.preventDefault(); e.stopPropagation();
  const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
  let moved = false;
  try { a.el.setPointerCapture(pid); } catch (_) {}
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < CLICK_SLOP) return;
    moved = true; a.el.classList.add("dragging");
    dragLabelTo(ev.clientX, ev.clientY, a);
  };
  const up = () => {
    a.el.removeEventListener("pointermove", move);
    a.el.removeEventListener("pointerup", up);
    a.el.classList.remove("dragging");
    try { a.el.releasePointerCapture(pid); } catch (_) {}
  };
  a.el.addEventListener("pointermove", move);
  a.el.addEventListener("pointerup", up);
}

/* ---- inline text editing ---- */
function beginEditAnnotation(a) {
  // defensive: if the renderer hasn't attached the label yet, attach it so focus works
  if (!a.el.isConnected) labelRenderer.domElement.appendChild(a.el);
  a._editing = true;
  a.el.classList.add("editing");
  a.txt.setAttribute("contenteditable", "true");
  a.txt.focus();
  const range = document.createRange(); range.selectNodeContents(a.txt);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
}

function endEditAnnotation(a, commit) {
  if (!a._editing) return;
  a._editing = false;
  a.txt.setAttribute("contenteditable", "false");
  a.el.classList.remove("editing");
  const t = (a.txt.textContent || "").trim();
  if (commit && t !== "") {
    a.text = t; a.txt.textContent = t; a._isNew = false;
  } else if (a._isNew) {
    removeAnnotation(a.id); return;   // never committed any text → discard the empty callout
  } else {
    a.txt.textContent = a.text;       // restore previous text (empty commit or cancel)
  }
  if (window.getSelection) window.getSelection().removeAllRanges();
}

function onAnnotEditKey(e, a) {
  if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); a.txt.blur(); }       // blur commits
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endEditAnnotation(a, false); }
}

/* ----------------------------------------------------------------------------
   Section view with coloured (muted-red) stencil caps
---------------------------------------------------------------------------- */
const sectionPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
let stencilGroup = null;
let capMesh = null;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Section offset is an ABSOLUTE signed distance (world mm) from the origin / floor grid,
// measured along the cut normal and remembered per file axis. `null` = unset -> the cut
// auto-centres on the model the first time the axis is built. Storing an absolute value
// (rather than a 0..1 box fraction) keeps the cut put as parts move / hide / appear.
function secD() { return state.section.offsets[state.section.axis]; }
function setSecD(v) { state.section.offsets[state.section.axis] = v; }
// world-space cut normal for the active axis, ignoring flip (the offset axis)
function sectionBaseNormal() {
  return AXES[state.section.axis].clone().applyQuaternion(modelRoot.quaternion).normalize();
}
// model extent projected onto the active cut normal: signed distances from the origin
function sectionSpan() {
  const box = getWorldBox();
  return box ? projectRange(box, sectionBaseNormal()) : null;
}
// resolved offset: the stored absolute mm, or the model centre when unset (null)
function resolvedSecD() {
  const d = secD();
  if (typeof d === "number" && isFinite(d)) return d;
  const box = getWorldBox();
  return box ? box.getCenter(new THREE.Vector3()).dot(sectionBaseNormal()) : 0;
}
// Map between the 0..1 slider and an absolute offset using the live model extent, so the
// knob still sweeps the model while the stored value stays grid-anchored (box-independent).
function dToT(d) {
  const r = sectionSpan(); if (!r || r.max <= r.min) return 0.5;
  return clamp01((d - r.min) / (r.max - r.min));
}
function tToD(t) {
  const r = sectionSpan(); if (!r) return 0;
  return r.min + (r.max - r.min) * clamp01(t);
}
// position the slider knob from the active-axis offset (cosmetic; the cut owns the value)
function syncSecSlider() { $("secSlider").value = Math.round(dToT(resolvedSecD()) * 1000); }

function projectRange(box, normal) {
  const corners = [
    new THREE.Vector3(box.min.x, box.min.y, box.min.z),
    new THREE.Vector3(box.max.x, box.min.y, box.min.z),
    new THREE.Vector3(box.min.x, box.max.y, box.min.z),
    new THREE.Vector3(box.max.x, box.max.y, box.min.z),
    new THREE.Vector3(box.min.x, box.min.y, box.max.z),
    new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    new THREE.Vector3(box.min.x, box.max.y, box.max.z),
    new THREE.Vector3(box.max.x, box.max.y, box.max.z),
  ];
  let min = Infinity, max = -Infinity;
  corners.forEach((c) => { const d = c.dot(normal); if (d < min) min = d; if (d > max) max = d; });
  return { min, max };
}

function makeStencilGroup(geometry, plane, order) {
  const g = new THREE.Group();
  const base = new THREE.MeshBasicMaterial();
  base.depthWrite = false; base.depthTest = false; base.colorWrite = false;
  base.stencilWrite = true; base.stencilFunc = THREE.AlwaysStencilFunc;

  const back = base.clone();
  back.side = THREE.BackSide; back.clippingPlanes = [plane];
  back.stencilFail = THREE.IncrementWrapStencilOp;
  back.stencilZFail = THREE.IncrementWrapStencilOp;
  back.stencilZPass = THREE.IncrementWrapStencilOp;
  const m0 = new THREE.Mesh(geometry, back); m0.renderOrder = order; g.add(m0);

  const front = base.clone();
  front.side = THREE.FrontSide; front.clippingPlanes = [plane];
  front.stencilFail = THREE.DecrementWrapStencilOp;
  front.stencilZFail = THREE.DecrementWrapStencilOp;
  front.stencilZPass = THREE.DecrementWrapStencilOp;
  const m1 = new THREE.Mesh(geometry, front); m1.renderOrder = order; g.add(m1);
  return g;
}

function teardownSection() {
  if (stencilGroup) { scene.remove(stencilGroup); stencilGroup = null; }
  if (capMesh) { scene.remove(capMesh); capMesh = null; }
  state.parts.forEach((p) => {
    if (p.mesh.material.clippingPlanes && p.mesh.material.clippingPlanes.length) {
      p.mesh.material.clippingPlanes = [];
      p.mesh.material.needsUpdate = true;
    }
  });
}

function buildSection() {
  teardownSection();
  if (!state.section.on || state.parts.length === 0) return;

  // normal/constant are set by updateSectionGeometry below (it owns the flip);
  // everything here references the shared sectionPlane object, so it follows.

  // assign clipping to all part materials (and their edge lines)
  state.parts.forEach((p) => {
    p.mesh.material.clippingPlanes = [sectionPlane];
    p.mesh.material.clipShadows = true;
    p.mesh.material.needsUpdate = true;
  });

  // stencil groups for caps
  stencilGroup = new THREE.Group();
  let order = 1;
  state.parts.forEach((p) => { if (p.mesh.visible) { stencilGroup.add(makeStencilGroup(p.mesh.geometry.clone().applyMatrix4(p.mesh.matrixWorld), sectionPlane, order++)); } });
  scene.add(stencilGroup);

  // cap plane
  const box = getWorldBox();
  const diag = box ? box.getSize(new THREE.Vector3()).length() : 10;
  const planeGeo = new THREE.PlaneGeometry(diag * 1.4, diag * 1.4);
  const capMat = new THREE.MeshStandardMaterial({
    color: CAP_COLOR, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide,
    stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
  });
  capMesh = new THREE.Mesh(planeGeo, capMat);
  capMesh.renderOrder = 10;
  capMesh.onAfterRender = function (r) { r.clearStencil(); };
  scene.add(capMesh);

  updateSectionGeometry();
  syncSecSlider();   // keep the knob tracking the (fixed) cut as the model extent changes
}

function updateSectionGeometry() {
  if (!state.section.on || !capMesh) return;
  const box = getWorldBox();
  if (!box) return;
  const bn = sectionBaseNormal();                          // un-flipped offset axis
  const center = box.getCenter(new THREE.Vector3());
  // absolute signed distance from the origin / floor grid along bn. Unset -> model centre,
  // persisted so the cut is grid-anchored and never re-derived from the bounding box.
  const d = resolvedSecD();
  setSecD(d);

  // Flip only swaps which side is removed; the cut stays put. A plane (n, c) and
  // (-n, -c) are the same plane geometrically but clip opposite half-spaces.
  if (state.section.flip) { sectionPlane.normal.copy(bn).negate(); sectionPlane.constant = d; }
  else                    { sectionPlane.normal.copy(bn);          sectionPlane.constant = -d; }

  // place cap on the plane near model centre (position is flip-independent)
  const onPlane = center.clone().add(bn.clone().multiplyScalar(d - bn.dot(center)));
  capMesh.position.copy(onPlane);
  capMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), sectionPlane.normal);

  // read-out: signed distance from the origin / floor grid along the axis, in mm. The grid
  // sits at the origin, so this reads directly against it. Leave the field alone while typing.
  const inp = $("secVal");
  if (document.activeElement !== inp) inp.value = fmt(d);
}

// mirror the active-axis offset onto the slider, then refresh the cut + read-out
function syncSecUI() {
  syncSecSlider();
  if (state.section.on) updateSectionGeometry();
}

// Convert legacy box-fraction offsets (older saves) into absolute world mm from the origin,
// using the same mapping the old build used, so a saved cut reproduces in the same place.
// Runs once after a load, when the model box is available.
function migrateLegacySectionOffsets() {
  if (!state.section._legacyFrac) return;
  const box = getWorldBox();
  ["x", "y", "z"].forEach((ax) => {
    const f = state.section.offsets[ax];
    if (typeof f !== "number") return;
    if (!box) { state.section.offsets[ax] = null; return; }   // no geometry -> defer to auto-centre
    const bn = AXES[ax].clone().applyQuaternion(modelRoot.quaternion).normalize();
    const { min, max } = projectRange(box, bn);
    const eps = (max - min) * 0.001 + 1e-4;
    state.section.offsets[ax] = (min + eps) + (max - min - 2 * eps) * clamp01(f);
  });
  delete state.section._legacyFrac;
}

/* ----------------------------------------------------------------------------
   Floor grid
---------------------------------------------------------------------------- */
// Span an origin-centred floor so it always reaches the model (and the origin), with a
// sensible floor for parts sitting right on the origin.
function gridFloorSize() {
  const box = getWorldBox();
  if (!box) return 100;
  const reachXZ = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
  const diag = box.getSize(new THREE.Vector3()).length();
  return Math.max(reachXZ * 2, diag * 1.5) * 1.1;
}
function ensureGrid() {
  if (gridHelper) scene.remove(gridHelper);
  const div = 20;
  gridHelper = new THREE.GridHelper(gridFloorSize(), div, 0xC2C7CD, 0xE1E3E7);
  scene.add(gridHelper);
  positionGrid();
}
function positionGrid() {
  if (!gridHelper) return;
  // Fixed datum: the floor grid IS the world-origin ground plane (Y=0), centred on the
  // origin so its centre cross marks the X=0 / Z=0 section datum. It does not track the
  // bounding box, so it stays put as parts are moved, hidden, or added — and the section
  // read-out (distance from origin) reads directly against it.
  gridHelper.position.set(0, 0, 0);
  gridHelper.visible = state.meta.gridOn;
}
function setGrid(on) {
  state.meta.gridOn = on;
  if (on && !gridHelper) ensureGrid();
  if (gridHelper) gridHelper.visible = on;
  $("swGrid").classList.toggle("on", on);
}

/* ----------------------------------------------------------------------------
   Objects panel
---------------------------------------------------------------------------- */
function rebuildObjectsPanel() {
  const list = $("objList");
  list.innerHTML = "";
  $("objCount").textContent = state.parts.length + (state.parts.length === 1 ? " part" : " parts");
  if (state.parts.length === 0) {
    list.innerHTML = '<div class="obj-empty">No parts loaded.<br>Open or drag a model to begin.</div>';
    return;
  }
  state.parts.forEach((p) => {
    const row = document.createElement("div");
    row.className = "obj-row" + (p.id === selectedId ? " selected" : "") + (p.visible ? "" : " hidden-part");
    row.dataset.id = p.id;

    const sw = document.createElement("label"); sw.className = "swatch";
    sw.style.background = "#" + new THREE.Color(p.color).getHexString();
    const ci = document.createElement("input"); ci.type = "color"; ci.value = "#" + new THREE.Color(p.color).getHexString();
    ci.addEventListener("input", (e) => setPartColor(p.id, e.target.value));
    ci.addEventListener("click", (e) => e.stopPropagation());
    sw.appendChild(ci);

    const nm = document.createElement("div"); nm.className = "oname"; nm.textContent = p.name;
    nm.title = editMode ? "Click to rename" : p.name;
    // In edit mode a part name looks like a field (see CSS) and renames on a single
    // click; stop the click bubbling so it edits the name instead of selecting the row.
    const startRename = (e) => {
      if (!editMode) return;
      e.stopPropagation();
      if (nm.getAttribute("contenteditable") !== "true") beginRenamePart(nm, p.id);
    };
    nm.addEventListener("click", startRename);
    nm.addEventListener("dblclick", startRename);

    const eye = document.createElement("button"); eye.className = "mini"; eye.title = "Toggle visibility";
    eye.innerHTML = p.visible ? EYE : EYE_OFF;
    eye.addEventListener("click", (e) => { e.stopPropagation(); togglePartVisible(p.id); });

    row.appendChild(sw); row.appendChild(nm);
    // reset-transform button: only when this part has been moved/rotated from its baseline
    if (partMoved(p)) {
      const rst = document.createElement("button"); rst.className = "mini reset"; rst.title = "Reset position & rotation";
      rst.innerHTML = ICON_RESET;
      rst.addEventListener("click", (e) => { e.stopPropagation(); resetPartTransform(p.id); });
      row.appendChild(rst);
    }
    row.appendChild(eye);
    row.addEventListener("click", () => selectPart(p.id, true));
    list.appendChild(row);
  });
}

function highlightRow(id) {
  document.querySelectorAll(".obj-row").forEach((r) => r.classList.toggle("selected", r.dataset.id === id));
}

function beginRenamePart(el, id) {
  el.contentEditable = "true"; el.focus();
  const range = document.createRange(); range.selectNodeContents(el);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const finish = () => {
    el.contentEditable = "false";
    const p = partById(id); if (p) p.name = el.textContent.trim() || p.name;
    el.textContent = p ? p.name : el.textContent;
    el.removeEventListener("blur", finish);
  };
  el.addEventListener("blur", finish);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
}

function setPartColor(id, hex) {
  const p = partById(id); if (!p) return;
  p.color = parseInt(hex.replace("#", "0x"));
  p.mesh.material.color.set(hex);
  p.mesh.userData.baseColor = p.color;
  const row = document.querySelector('.obj-row[data-id="' + id + '"] .swatch');
  if (row) row.style.background = hex;
  refreshObjInfo();
}

function togglePartVisible(id) {
  const p = partById(id); if (!p) return;
  p.visible = !p.visible; p.mesh.visible = p.visible;
  rebuildObjectsPanel();
  if (state.section.on) buildSection();
}

function isolatePart() {
  if (!selectedId) { toast("Select a part to isolate"); return; }
  state.parts.forEach((p) => { p.visible = (p.id === selectedId); p.mesh.visible = p.visible; });
  rebuildObjectsPanel();
  if (state.section.on) buildSection();
}
function hideSelected() {
  if (!selectedId) return;
  const p = partById(selectedId); if (p) { p.visible = false; p.mesh.visible = false; }
  rebuildObjectsPanel();
  if (state.section.on) buildSection();
}
function showAll() {
  state.parts.forEach((p) => { p.visible = true; p.mesh.visible = true; });
  rebuildObjectsPanel();
  if (state.section.on) buildSection();
}

function refreshObjInfo() {
  const el = $("objInfo");
  if (!selectedId) { el.textContent = "No part selected."; return; }
  const p = partById(selectedId); if (!p) { el.textContent = "No part selected."; return; }
  const g = p.mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
  const s = g.boundingBox.getSize(new THREE.Vector3());
  const tris = g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
  el.innerHTML = `<b>${escapeHtml(p.name)}</b><br><span class="dims">${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm · ${Math.round(tris)} tris</span>`;
}

/* ----------------------------------------------------------------------------
   Collapsible panels (Tools, Objects)
   - click the header to toggle collapsed/expanded
---------------------------------------------------------------------------- */
function setupCollapsiblePanels() {
  document.querySelectorAll(".panel.collapsible").forEach((panel) => {
    const head = panel.querySelector(".panel-head");
    head.addEventListener("click", () => panel.classList.toggle("collapsed"));
  });
}

/* Persisted panel state: a saved file reopens with whatever expand/collapse state
   the panels were in when it was saved (WYSIWYG). Keyed by data-panel; absent in
   older saves -> panels keep their markup default (collapsed). */
function capturePanelStates() {
  const out = {};
  document.querySelectorAll(".panel.collapsible[data-panel]").forEach((p) => {
    out[p.dataset.panel] = p.classList.contains("collapsed");
  });
  return out;
}
function applyPanelStates(map) {
  if (!map) return;
  document.querySelectorAll(".panel.collapsible[data-panel]").forEach((p) => {
    if (p.dataset.panel in map) p.classList.toggle("collapsed", !!map[p.dataset.panel]);
  });
}

/* ----------------------------------------------------------------------------
   Info panel
---------------------------------------------------------------------------- */
function refreshInfoPanel() {
  $("ifTitle").value = state.meta.title || "";
  $("ifDesc").value = state.meta.description || "";
  $("ifDate").textContent = state.meta.exportDate || "—";
  $("ifCopyright").textContent = state.meta.copyright || "—";   // display only, never user-editable
  const conf = state.meta.confidential || "";
  $("confNotice").textContent = conf;
  const confEl = document.querySelector(".confidential");
  if (confEl) confEl.style.display = conf ? "" : "none";   // hide the badge when unbranded
  updateConfidentialMenu();
  const box = getLocalBox();
  if (box) {
    const s = box.getSize(new THREE.Vector3());
    $("ifBBox").textContent = `${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)}`;
  } else $("ifBBox").textContent = "—";
  $("modelName").textContent = state.meta.title || "Untitled model";
}

/* ----------------------------------------------------------------------------
   Save: rebuild a standalone file from PRISTINE_HTML with current state
---------------------------------------------------------------------------- */
function serializeState() {
  return {
    v: 1,
    meta: Object.assign({}, state.meta, { panels: capturePanelStates() }),
    files: state.files.map((f) => ({ id: f.id, name: f.name, format: f.format, enc: f.enc, data: f.data })),
    parts: state.parts.map((p) => {
      const o = { fileId: p.fileId, index: p.index, name: p.name, color: p.color, visible: p.visible };
      const E2 = XFORM_EPS * XFORM_EPS;
      // baseline ("default") transform — stored as the offset from the pristine loader pose
      if (p.loaderPos && p.basePos.distanceToSquared(p.loaderPos) > E2) o.dpos = p.basePos.clone().sub(p.loaderPos).toArray();
      if (p.loaderQuat && p.baseQuat.angleTo(p.loaderQuat) > XFORM_EPS) o.dquat = p.baseQuat.toArray();
      if (p.loaderScale && p.baseScale.distanceToSquared(p.loaderScale) > E2) o.dscale = p.baseScale.toArray();
      // current transform — stored only when moved from the baseline (pos = delta from base)
      if (p.basePos && p.mesh.position.distanceToSquared(p.basePos) > E2) o.pos = p.mesh.position.clone().sub(p.basePos).toArray();
      if (p.baseQuat && p.mesh.quaternion.angleTo(p.baseQuat) > XFORM_EPS) o.quat = p.mesh.quaternion.toArray();
      if (p.baseScale && p.mesh.scale.distanceToSquared(p.baseScale) > E2) o.scale = p.mesh.scale.toArray();
      return o;
    }),
    measurements: state.measurements.map((m) => {
      const o = { a: m.a.toArray(), b: m.b.toArray() };
      const ra = partRef(m.aPart); if (ra && m.aLocal) { o.aRef = ra; o.aLocal = m.aLocal.toArray(); }
      const rb = partRef(m.bPart); if (rb && m.bLocal) { o.bRef = rb; o.bLocal = m.bLocal.toArray(); }
      return o;
    }),
    annotations: state.annotations.map((a) => {
      const o = { p: a.p.toArray(), o: a.lp.clone().sub(a.p).toArray(), text: a.text };
      const r = partRef(a.part); if (r && a.pLocal) { o.ref = r; o.pLocal = a.pLocal.toArray(); }
      return o;
    }),
    section: { on: state.section.on, axis: state.section.axis, flip: state.section.flip, unit: "mm", offsets: Object.assign({}, state.section.offsets) },
  };
}

function saveFile() {
  closeMenu();
  if (state.files.length === 0 && !confirm("No models are loaded. Save an empty viewer anyway?")) return;
  const json = JSON.stringify(serializeState());
  // escape so it is safe inside a script text node (avoid literal close-tag / comment-open)
  const safe = json.replace(/<\/script>/gi, "<\\/script>").replace(/<!\-\-/g, "<\\!--");
  // NB: the regex below is written with [<] and backslash-escapes on purpose, so that this
  // source contains no literal script open-tag or comment-open byte sequence. Those would
  // corrupt the HTML tokenizer (script double-escape) when this file is inlined or re-saved.
  const html = PRISTINE_HTML.replace(
    /([<]script id="embedded-data" type="application\/json">)([\s\S]*?)(<\/script>)/,
    (_, a, _b, c) => a + safe + c
  );
  const name = (state.meta.title || "model").replace(/[^\w\-]+/g, "_");
  downloadText(name + "_viewer.html", html);
  toast("Saved standalone viewer");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ----------------------------------------------------------------------------
   Load from embedded state (on startup)
---------------------------------------------------------------------------- */
function loadFromState(data) {
  showOverlay("loading");
  Object.assign(state.meta, data.meta || {});
  const sec = data.section || {};
  // Offsets are ABSOLUTE mm from the origin / floor grid when `unit==="mm"` (current files).
  // Older files stored 0..1 fractions of the bounding box (per-axis `offsets`, or a single
  // legacy `t`); flag them so we can convert to absolute once the model box is known below.
  const legacyFrac = sec.unit !== "mm";
  const fallback = (typeof sec.t === "number") ? sec.t : (legacyFrac ? 0.5 : null);
  const off = sec.offsets || {};
  const pickOff = (v) => (typeof v === "number" ? v : fallback);
  state.section = {
    on: !!sec.on, axis: sec.axis || "x", flip: !!sec.flip,
    offsets: { x: pickOff(off.x), y: pickOff(off.y), z: pickOff(off.z) },
    _legacyFrac: legacyFrac,
  };

  applyUpAxis(state.meta.upAxis || "z+");

  // group part-meta by file for re-applying after parse
  const partsByFile = {};
  (data.parts || []).forEach((p) => { (partsByFile[p.fileId] = partsByFile[p.fileId] || []).push(p); });

  const files = data.files || [];
  const tasks = files.map((f) => {
    let buf = b64ToAb(f.data);
    // any truthy enc means the bytes are compressed (wrapper auto-detected); no enc = raw, back-compat
    if (f.enc) { try { buf = inflateAuto(new Uint8Array(buf)).buffer; } catch (e) { console.error("inflate failed", f.name, e); } }
    const metaParts = (partsByFile[f.id] || []).sort((a, b) => a.index - b.index);
    return addFile(f.name, buf, { format: f.format, fileId: f.id, metaParts, fromState: true });
  });

  Promise.all(tasks).then(() => {
    (data.measurements || []).forEach((m) => {
      const bind = {};
      if (m.aRef && m.aLocal) { bind.aPart = partIdFromRef(m.aRef); bind.aLocal = new THREE.Vector3().fromArray(m.aLocal); }
      if (m.bRef && m.bLocal) { bind.bPart = partIdFromRef(m.bRef); bind.bLocal = new THREE.Vector3().fromArray(m.bLocal); }
      addMeasurement(new THREE.Vector3().fromArray(m.a), new THREE.Vector3().fromArray(m.b), bind);
    });
    (data.annotations || []).forEach((a) => {
      const p = new THREE.Vector3().fromArray(a.p);
      const lp = a.o ? p.clone().add(new THREE.Vector3().fromArray(a.o)) : null;
      const opts = lp ? { lp } : {};
      if (a.ref && a.pLocal) { opts.part = partIdFromRef(a.ref); opts.pLocal = new THREE.Vector3().fromArray(a.pLocal); }
      addAnnotation(p, a.text || "", opts);
    });
    migrateLegacySectionOffsets();
    finishLoad();
    $("secFlip").classList.toggle("active", state.section.flip);
    if (state.section.on) { $("swSection").classList.add("on"); syncChips(".secAxis", "axis", state.section.axis); buildSection(); }
    syncSecSlider();
  });
}

/* shared post-load wiring */
function finishLoad() {
  rebuildObjectsPanel();
  updateXformResetUI();   // surfaces reset controls if any saved part has a transform
  refreshInfoPanel();
  applyPanelStates(state.meta.panels);   // restore each panel's saved expand/collapse state
  setProjection(state.meta.projection || "persp");
  setGrid(!!state.meta.gridOn);
  setView("iso");
  if (state.parts.length) hideOverlay(); else showOverlay("empty");
}

/* ----------------------------------------------------------------------------
   Drag & drop + import
---------------------------------------------------------------------------- */
function readFilesAndAdd(fileList) {
  const arr = Array.from(fileList).filter((f) => formatFromName(f.name));
  if (arr.length === 0) { toast("No supported files (.obj .stl .glb)"); return; }
  showOverlay("loading");
  let chain = Promise.resolve();
  arr.forEach((file) => {
    chain = chain.then(() => file.arrayBuffer()).then((buf) => addFile(file.name, buf));
  });
  chain.then(() => {
    rebuildObjectsPanel(); refreshInfoPanel();
    if (GRID_ON_IMPORT && !state.meta.gridOn) setGrid(true);   // auto-enable on first import
    else if (state.meta.gridOn) ensureGrid();                  // already on -> refit to new extents
    setView("iso"); hideOverlay();
  });
}

function setupDnD() {
  const hint = $("dropHint");
  let depth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; hint.classList.add("show"); });
  window.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  window.addEventListener("dragleave", (e) => { e.preventDefault(); if (--depth <= 0) { depth = 0; hint.classList.remove("show"); } });
  window.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; hint.classList.remove("show");
    if (e.dataTransfer.files && e.dataTransfer.files.length) readFilesAndAdd(e.dataTransfer.files);
  });
}

/* ----------------------------------------------------------------------------
   UI overlays / toasts / helpers
---------------------------------------------------------------------------- */
function showOverlay(which) {
  $("ovLoading").classList.toggle("show", which === "loading");
  $("ovEmpty").classList.toggle("show", which === "empty");
}
function hideOverlay() { $("ovLoading").classList.remove("show"); $("ovEmpty").classList.remove("show"); }

let toastTimer = null;
function toast(msg) { showHint(msg); clearTimeout(toastTimer); toastTimer = setTimeout(hideHint, 2600); }
function showHint(html) { const h = $("hint"); h.innerHTML = html; h.classList.add("show"); }
function hideHint() { $("hint").classList.remove("show"); }

function fmt(v) { const a = Math.abs(v); const d = a >= 100 ? 1 : a >= 10 ? 2 : 3; return v.toFixed(d); }
function todayStr() { const d = new Date(); return d.toISOString().slice(0, 10); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function abToB64(buf) {
  const bytes = new Uint8Array(buf); let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function b64ToAb(b64) {
  const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
/* Inflate DEFLATE data regardless of how the producer wrapped it, so any language's built-in
   works headless: zlib (Python zlib.compress / Node deflateSync / .NET ZLibStream), raw deflate
   (.NET DeflateStream), or gzip (Python gzip.compress / .NET GZipStream). The in-app Save writes
   zlib, so that common path succeeds on the first try. */
function inflateAuto(u8) {
  try { return pako.inflate(u8); } catch (_) {}      // zlib  (RFC 1950)
  try { return pako.inflateRaw(u8); } catch (_) {}   // raw   (RFC 1951)
  return pako.ungzip(u8);                             // gzip  (RFC 1952)
}

const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const ICON_RESET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/></svg>';

/* sync a set of "chip" elements to an active value */
function syncChips(selector, dataAttr, value) {
  document.querySelectorAll(selector).forEach((c) => c.classList.toggle("active", c.dataset[dataAttr] === value));
}

/* ----------------------------------------------------------------------------
   Menu open/close
---------------------------------------------------------------------------- */
function toggleMenu() { $("menu").classList.toggle("open"); }
function closeMenu() { $("menu").classList.remove("open"); }

/* bind a click on a whole toggle-row (label + switch) to a handler */
function toggleRow(name, handler) {
  const row = document.querySelector('.toggle-row[data-toggle="' + name + '"]');
  if (row) row.addEventListener("click", handler);
}

/* ----------------------------------------------------------------------------
   Wire up the UI
---------------------------------------------------------------------------- */
/* ============================================================================
   LIGHT LAB  (DEVELOPER — lighting / material exploration sandbox)
   ----------------------------------------------------------------------------
   A self-contained playground for finding a lighting + material setup that
   makes shapes easy to read. Nothing here is serialized into saved files; it
   only drives the live scene.

   Toggle the panel with DEV.lightPanel (top of file). Pick the lighting that
   ships with the viewer via DEV.lightPreset. To remove the feature entirely:
   delete the DEV block usage, this block, the wireLightLab() call in wireUI(),
   the updateLightLab() call in animate(), the installNeutralToneMapping() call
   in initThree(), the boot() preset line, the two guarded lines in
   registerObject(), the `.lightlab` panel in index.html and its CSS.
   ========================================================================== */
const LIGHT_LAB = {
  key: 0.6, casterShare: 0.18, fill: 0.55, rim: 0.28, exposure: 1.0,
  az: 35, el: 47, tonemap: "none", bg: "#F9FAFA",
  keyColor: 0xffffff, rimColor: 0xffffff, hemiSky: 0xffffff, hemiGround: 0x333333,
  headlight: false, shadows: true, ground: false, spin: false,
  env: false, envIntensity: 1.0,
  rough: 0.6, metal: 0.0, flat: false, clay: false, edges: false,
};
const studioEnv = { tex: null };   // LIGHT LAB: cached PMREM env texture (built lazily by ensureStudioEnv)
let groundCatcher = null;   // LIGHT LAB: ShadowMaterial floor plane that catches the cast shadow
const FILL_BASE = new THREE.Vector3(-1.1, 0.4, -0.6);   // LIGHT LAB: rest directions of the fill / rim lights
const RIM_BASE  = new THREE.Vector3(0.2, -0.9, -0.8);   //   (orbited around origin by "Rotate lights")
const LIGHT_SPIN_DPS = 36;   // light-orbit speed, degrees/second
let _lightOrbit = 0, _llPrevT = 0;

const TONEMAPS = {
  none:     THREE.NoToneMapping,
  aces:     THREE.ACESFilmicToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  neutral:  THREE.CustomToneMapping,   // Khronos PBR Neutral, grafted in by installNeutralToneMapping()
};

/* Khronos PBR Neutral tone mapping isn't in three r137 (it landed in r166 as
   NeutralToneMapping). Graft the operator into the CustomToneMapping slot by
   patching its shader chunk — runs once, before any material compiles. It tone-
   maps highlights toward white while preserving hue/saturation, which keeps the
   coloured presets vivid without the ACES hue shift. */
let _neutralInstalled = false;
function installNeutralToneMapping() {
  if (_neutralInstalled) return;
  _neutralInstalled = true;
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  const stub = "vec3 CustomToneMapping( vec3 color ) { return color; }";
  if (!chunk || chunk.indexOf(stub) === -1) return;   // three version changed: leave CustomToneMapping as-is
  THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(stub,
    "vec3 CustomToneMapping( vec3 color ) {" +
    "  color *= toneMappingExposure;" +
    "  const float StartCompression = 0.8 - 0.04;" +
    "  const float Desaturation = 0.15;" +
    "  float x = min( color.r, min( color.g, color.b ) );" +
    "  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;" +
    "  color -= offset;" +
    "  float peak = max( color.r, max( color.g, color.b ) );" +
    "  if ( peak < StartCompression ) return color;" +
    "  float d = 1.0 - StartCompression;" +
    "  float newPeak = 1.0 - d * d / ( peak + d - StartCompression );" +
    "  color *= newPeak / peak;" +
    "  float g = 1.0 - 1.0 / ( Desaturation * ( peak - newPeak ) + 1.0 );" +
    "  return mix( color, vec3( newPeak ), g );" +
    "}");
}

/* Each preset is a full lighting + tone setup. Applying one pushes its values
   into LIGHT_LAB, the lights, and the panel controls. All presets use ACES so
   the Exposure slider is always meaningful (boot stays on "none" = current look
   until the user picks a preset). */
const LIGHT_PRESETS = {
  studio:     { key:0.65, casterShare:0.18, fill:0.55, rim:0.28, az:35, el:47, exposure:1.0,  tonemap:"neutral", bg:"#F9FAFA", keyColor:0xffffff, rimColor:0xffffff, hemiSky:0xffffff, hemiGround:0x333333 },
  threePoint: { key:0.95, casterShare:0.20, fill:0.30, rim:0.55, az:40, el:35, exposure:1.0,  tonemap:"neutral", bg:"#F9FAFA", keyColor:0xffffff, rimColor:0xffffff, hemiSky:0xffffff, hemiGround:0x222222 },
  soft:       { key:0.35, casterShare:0.08, fill:0.90, rim:0.12, az:25, el:55, exposure:1.05, tonemap:"neutral", bg:"#F9FAFA", keyColor:0xffffff, rimColor:0xffffff, hemiSky:0xffffff, hemiGround:0x555555 },
  dramatic:   { key:1.25, casterShare:0.45, fill:0.33, rim:0.35, az:55, el:28, exposure:1.06,  tonemap:"neutral", bg:"#F9FAFA", keyColor:0xffffff, rimColor:0xD9DFE5, hemiSky:0x515459, hemiGround:0x111111 },
  top:        { key:0.85, casterShare:0.25, fill:0.40, rim:0.15, az:20, el:82, exposure:1.0,  tonemap:"neutral",    bg:"#F9FAFA", keyColor:0xffffff, rimColor:0xffffff, hemiSky:0xffffff, hemiGround:0x333333 },
  coolShop:   { key:0.85, casterShare:0.22, fill:0.50, rim:0.40, az:50, el:40, exposure:1.0,  tonemap:"neutral",    bg:"#F9FAFA", keyColor:0xfff1dc, rimColor:0xcfe3ff, hemiSky:0xcfe3ff, hemiGround:0x1d2530 },
  // warm/cool stylised rigs (in the Cool shop / Dramatic family) — Neutral tone mapping keeps the tints vivid
  sunset:     { key:1.05, casterShare:0.35, fill:0.35, rim:0.45, az:65, el:22, exposure:1.0,  tonemap:"neutral", bg:"#F9FAFA", keyColor:0xffd29a, rimColor:0x9fc4ff, hemiSky:0xffe3c0, hemiGround:0x241a14 },
  moonlight:  { key:1.15, casterShare:0.42, fill:0.14, rim:0.40, az:50, el:30, exposure:1.0,  tonemap:"neutral", bg:"#F9FAFA", keyColor:0xbcd2ff, rimColor:0xdfeaff, hemiSky:0x4a5e80, hemiGround:0x0d1018 },
  blueprint:  { key:0.55, casterShare:0.18, fill:0.40, rim:0.70, az:35, el:45, exposure:1.0,  tonemap:"neutral", bg:"#F9FAFA", keyColor:0xeaf6ff, rimColor:0x49d6ff, hemiSky:0x86c8e6, hemiGround:0x0a1620 },
  ember:      { key:1.20, casterShare:0.40, fill:0.20, rim:0.50, az:40, el:18, exposure:1.0,  tonemap:"neutral", bg:"#F9FAFA", keyColor:0xff9a5a, rimColor:0x7fb6ff, hemiSky:0x5a3a2a, hemiGround:0x140c08 },
};

/* unit direction from azimuth (around up) + elevation (above horizon) */
function lightDir(azDeg, elDeg) {
  const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}

function applyKeyIntensity() {
  if (!keyLight) return;
  keyLight.intensity     = LIGHT_LAB.key * LIGHT_LAB.casterShare;
  keyMainLight.intensity = LIGHT_LAB.key * (1 - LIGHT_LAB.casterShare);
}
function applyFillIntensity() {
  if (!hemiLight) return;
  hemiLight.intensity = LIGHT_LAB.fill;
  ambLight.intensity  = LIGHT_LAB.fill * 0.35;
}
function applyRim()       { if (rimLight) rimLight.intensity = LIGHT_LAB.rim; }
function applyKeyColor()  { if (keyLight)  { keyLight.color.setHex(LIGHT_LAB.keyColor); keyMainLight.color.setHex(LIGHT_LAB.keyColor); } }
function applyRimColor()  { if (rimLight)  rimLight.color.setHex(LIGHT_LAB.rimColor); }
function applyHemiColors(){ if (hemiLight) { hemiLight.color.setHex(LIGHT_LAB.hemiSky); hemiLight.groundColor.setHex(LIGHT_LAB.hemiGround); } }
/* Point the key (and the shadow it casts) along the azimuth/elevation dir. In
   headlight mode the per-frame updateLightLab() owns the direction instead. */
function applyKeyDirection() {
  if (LIGHT_LAB.headlight || !keyMainLight) return;
  const d = lightDir(LIGHT_LAB.az, LIGHT_LAB.el);
  keyMainLight.position.copy(d);
  keyMainLight.target.position.set(0, 0, 0); keyMainLight.target.updateMatrixWorld();
  SHADOW_DIR.copy(d).normalize();
  if (_shadowCenter) updateShadowCamera(_shadowCenter, _shadowRadius);
}
function applyShadows() {
  if (keyLight) keyLight.castShadow = LIGHT_LAB.shadows;   // headlight now has a real offset, so its shadow is meaningful
}
function applyExposure() { if (renderer) renderer.toneMappingExposure = LIGHT_LAB.exposure; }
function applyToneMap() {
  if (!renderer) return;
  renderer.toneMapping = TONEMAPS[LIGHT_LAB.tonemap] || THREE.NoToneMapping;
  markMaterialsDirty();   // tone mapping is compiled into the shaders
}
function markMaterialsDirty() {
  scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
  });
}

/* Reposition the shadow caster along `dir` without rebuilding its frustum (size
   depends only on the model radius, which hasn't changed). */
function aimShadow(dir) {
  if (!shadowLight || !_shadowCenter) return;
  const dist = Math.max(_shadowRadius, 1e-3) * 4;
  shadowLight.position.copy(_shadowCenter).addScaledVector(dir, dist);
  shadowLight.target.position.copy(_shadowCenter);
  shadowLight.target.updateMatrixWorld();
}

/* The headlight: the key follows the camera, but offset by the Rotate/Height
   sliders so it sits up-and-to-the-side of the viewer (a studio key that tracks
   your eye) rather than dead-on — which would flatten every form. The offset is
   applied in the camera's frame, so the light keeps a constant angle relative to
   the view as you orbit. Runs each frame from animate(); a no-op when off. */
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _camDir = new THREE.Vector3(), _viewRight = new THREE.Vector3(),
      _viewUp = new THREE.Vector3(), _Ldir = new THREE.Vector3(), _qOff = new THREE.Quaternion();
function updateLightLab() {
  if (!keyMainLight) return;
  const now = performance.now();
  const dt = _llPrevT ? Math.min((now - _llPrevT) / 1000, 0.1) : 0;   // clamp so a tab-stall doesn't lurch
  _llPrevT = now;

  if (LIGHT_LAB.headlight && activeCam) {   // key offset from the camera (a studio key that tracks your eye)
    activeCam.getWorldDirection(_camDir);   // points into the scene
    _viewRight.crossVectors(_camDir, WORLD_UP);
    if (_viewRight.lengthSq() < 1e-6) _viewRight.set(1, 0, 0);   // looking straight up/down: pick a stable right
    _viewRight.normalize();
    _viewUp.crossVectors(_viewRight, _camDir).normalize();
    _Ldir.copy(_camDir).negate();           // base: straight from the viewer
    _qOff.setFromAxisAngle(_viewRight, THREE.MathUtils.degToRad(LIGHT_LAB.el)); _Ldir.applyQuaternion(_qOff);   // lift up
    _qOff.setFromAxisAngle(_viewUp,    THREE.MathUtils.degToRad(LIGHT_LAB.az)); _Ldir.applyQuaternion(_qOff);   // swing aside
    aimRig(_Ldir.normalize(), 0);
    return;
  }
  if (LIGHT_LAB.spin) {                      // orbit the whole rig around the origin's vertical axis
    _lightOrbit = (_lightOrbit + LIGHT_SPIN_DPS * dt) % 360;
    aimRig(lightDir(LIGHT_LAB.az + _lightOrbit, LIGHT_LAB.el), _lightOrbit);
  }
}

/* Aim the key along `keyDirWorld` and swing fill+rim around the origin's Y axis by
   `orbitDeg`. Shared by the headlight and the light-orbit animation. */
function aimRig(keyDirWorld, orbitDeg) {
  keyMainLight.position.copy(keyDirWorld);
  keyMainLight.target.position.set(0, 0, 0); keyMainLight.target.updateMatrixWorld();
  SHADOW_DIR.copy(keyDirWorld);
  if (LIGHT_LAB.shadows) aimShadow(keyDirWorld);
  _qOff.setFromAxisAngle(WORLD_UP, THREE.MathUtils.degToRad(orbitDeg));
  if (fillLight) fillLight.position.copy(FILL_BASE).applyQuaternion(_qOff);
  if (rimLight)  rimLight.position.copy(RIM_BASE).applyQuaternion(_qOff);
}

/* Ground shadow: a ShadowMaterial plane on the model's floor that catches the
   cast shadow, grounding the part and giving a strong depth cue. */
function ensureGroundCatcher() {
  if (groundCatcher) return groundCatcher;
  groundCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ opacity: 0.22 })
  );
  groundCatcher.rotation.x = -Math.PI / 2;   // lie flat in the XZ plane
  groundCatcher.receiveShadow = true;
  groundCatcher.renderOrder = -1;
  scene.add(groundCatcher);
  return groundCatcher;
}
function positionGroundCatcher() {
  if (!groundCatcher) return;
  const box = getWorldBox(); if (!box) return;
  const c = box.getCenter(new THREE.Vector3());
  const span = box.getSize(new THREE.Vector3()).length() * 3 + 1;
  groundCatcher.position.set(c.x, box.min.y, c.z);
  groundCatcher.scale.set(span, span, 1);
}
function setGroundShadow(on) {
  LIGHT_LAB.ground = on;
  if (on) { ensureGroundCatcher(); positionGroundCatcher(); }
  if (groundCatcher) groundCatcher.visible = on;
}

/* Rotate lights: slowly orbit the whole rig around the origin so highlights and
   shadows sweep across the part — the camera stays put. Mutually exclusive with
   the headlight (both want to own the key direction). */
function setLightSpin(on) {
  LIGHT_LAB.spin = on;
  if (on) {
    if (LIGHT_LAB.headlight) { LIGHT_LAB.headlight = false; const sw = $("swHeadlight"); if (sw) sw.classList.remove("on"); }
  } else {
    _lightOrbit = 0;                 // park the rig back at its slider-defined rest pose
    if (fillLight) fillLight.position.copy(FILL_BASE);
    if (rimLight)  rimLight.position.copy(RIM_BASE);
    applyKeyDirection();
  }
}

function applyLightPreset(name) {
  const p = LIGHT_PRESETS[name]; if (!p) return;
  Object.assign(LIGHT_LAB, {
    key:p.key, casterShare:p.casterShare, fill:p.fill, rim:p.rim, az:p.az, el:p.el, exposure:p.exposure, tonemap:p.tonemap, bg:p.bg,
    keyColor:p.keyColor, rimColor:p.rimColor, hemiSky:p.hemiSky, hemiGround:p.hemiGround,
  });
  applyKeyIntensity(); applyFillIntensity(); applyKeyDirection();
  applyRim(); applyKeyColor(); applyRimColor(); applyHemiColors();
  applyExposure(); applyToneMap(); setBg(p.bg);
  syncChips(".ll-preset", "preset", name);   // highlight the active preset (also when applied on boot)
  syncLightLabUI();
  refreshReadout();
}

/* ---- material knobs ---- */
function eachPartMaterial(fn) { state.parts.forEach((p) => { if (p.mesh.material) fn(p.mesh.material, p); }); }
function setRoughness(v) { MAT.roughness = v; eachPartMaterial((m) => { m.roughness = v; }); refreshReadout(); }
function setMetalness(v) { MAT.metalness = v; eachPartMaterial((m) => { m.metalness = v; }); refreshReadout(); }
function setFlatShading(on) {
  MAT.flat = on;
  eachPartMaterial((m) => { m.flatShading = on; m.needsUpdate = true; });
}
function setClay(on) {
  LIGHT_LAB.clay = on;
  eachPartMaterial((m, p) => { m.color.set(on ? CLAY_COLOR : p.color); });
}

/* ---- environment (image-based reflections) ---- */
/* Build a procedural studio environment once: a soft vertical gradient (bright
   overhead softbox -> neutral horizon -> dark floor) baked through PMREM so metal
   parts have something to reflect. Fully offline — no HDR file, core three only. */
function ensureStudioEnv() {
  if (studioEnv.tex || !renderer) return studioEnv.tex;
  const c = document.createElement("canvas"); c.width = 16; c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, "#ffffff");   // zenith softbox
  g.addColorStop(0.25, "#e6e8ea");
  g.addColorStop(0.55, "#b8bcc0");   // horizon
  g.addColorStop(0.80, "#6c7075");
  g.addColorStop(1.00, "#2b2e31");   // floor
  ctx.fillStyle = g; ctx.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  if ("sRGBEncoding" in THREE) tex.encoding = THREE.sRGBEncoding;   // colour-manage the source (r137)
  const pmrem = new THREE.PMREMGenerator(renderer);
  studioEnv.tex = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose(); tex.dispose();
  return studioEnv.tex;
}
function setEnvironment(on) {
  LIGHT_LAB.env = on;
  if (scene) scene.environment = on ? ensureStudioEnv() : null;
}
function setEnvIntensity(v) {
  MAT.envIntensity = v; LIGHT_LAB.envIntensity = v;
  eachPartMaterial((m) => { m.envMapIntensity = v; });
}

/* Edge overlay: dark crease/silhouette lines drawn over each part — the single
   biggest aid to reading form. Added as a child mesh so it follows transforms;
   picking uses non-recursive raycasts, so it never interferes with selection. */
function addPartEdges(mesh) {
  if (mesh.userData.llEdges) { mesh.userData.llEdges.visible = true; return mesh.userData.llEdges; }
  const eg = new THREE.EdgesGeometry(mesh.geometry, 30);   // 30° crease threshold
  const ls = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x2b3238, transparent: true, opacity: 0.5 }));
  ls.renderOrder = 3;
  mesh.add(ls);
  mesh.userData.llEdges = ls;
  return ls;
}
function setEdges(on) {
  LIGHT_LAB.edges = on;
  state.parts.forEach((p) => {
    if (on) addPartEdges(p.mesh);
    else if (p.mesh.userData.llEdges) p.mesh.userData.llEdges.visible = false;
  });
}

function setBg(hex) {
  LIGHT_LAB.bg = hex;
  if (scene) scene.background = new THREE.Color(hex);
  syncChips(".ll-bgc", "bg", hex);
}

function resetLightLab() {
  Object.assign(LIGHT_LAB, {
    key:0.6, casterShare:0.18, fill:0.55, rim:0.28, exposure:1.0, az:35, el:47,
    tonemap:"none", bg:"#F9FAFA", headlight:false, shadows:true, ground:false, spin:false,
    keyColor:0xffffff, rimColor:0xffffff, hemiSky:0xffffff, hemiGround:0x333333,
    env:false, envIntensity:1.0,
    rough:0.6, metal:0.0, flat:false, clay:false, edges:false,
  });
  if (rimLight) rimLight.position.set(0.2, -0.9, -0.8);
  if (fillLight) fillLight.position.set(-1.1, 0.4, -0.6);
  applyKeyIntensity(); applyFillIntensity(); applyKeyDirection(); applyShadows();
  applyRim(); applyKeyColor(); applyRimColor(); applyHemiColors();
  applyExposure(); applyToneMap(); setBg("#F9FAFA");
  setRoughness(0.6); setMetalness(0.0); setFlatShading(false); setClay(false); setEdges(false);
  setGroundShadow(false); setLightSpin(false);
  setEnvironment(false); setEnvIntensity(1.0);
  syncChips(".ll-preset", "preset", null);   // no preset is "active" at the neutral default
  syncLightLabUI();
  refreshReadout();
  toast("Light setup reset");
}

/* Live, copy-pasteable summary so a winning combo can be baked into defaults. */
function refreshReadout() {
  const el = $("llReadout"); if (!el) return;
  const L = LIGHT_LAB;
  const dirNote = L.headlight ? " (rel. camera)" : "";
  el.textContent =
    `key ${L.key.toFixed(2)}  fill ${L.fill.toFixed(2)}  rim ${L.rim.toFixed(2)}  caster ${L.casterShare.toFixed(2)}\n` +
    `exposure ${L.exposure.toFixed(2)}  tone ${L.tonemap}\n` +
    `dir az ${Math.round(L.az)}°  el ${Math.round(L.el)}°${dirNote}\n` +
    `shadows ${L.shadows ? "on" : "off"}  ground ${L.ground ? "on" : "off"}  rot-lights ${L.spin ? "on" : "off"}\n` +
    `mat rough ${L.rough.toFixed(2)}  metal ${L.metal.toFixed(2)}  flat ${L.flat ? "on" : "off"}  env ${L.env ? "on" : "off"}`;
}
function logSetup() {
  const out = {
    lighting: { key: LIGHT_LAB.key, casterShare: LIGHT_LAB.casterShare, fill: LIGHT_LAB.fill,
                rim: rimLight ? rimLight.intensity : 0, exposure: LIGHT_LAB.exposure, toneMapping: LIGHT_LAB.tonemap,
                azimuth: LIGHT_LAB.az, elevation: LIGHT_LAB.el, headlight: LIGHT_LAB.headlight,
                shadows: LIGHT_LAB.shadows, groundShadow: LIGHT_LAB.ground, rotateLights: LIGHT_LAB.spin, background: LIGHT_LAB.bg },
    material: { roughness: LIGHT_LAB.rough, metalness: LIGHT_LAB.metal, flatShading: LIGHT_LAB.flat, clay: LIGHT_LAB.clay, edges: LIGHT_LAB.edges },
    environment: { on: LIGHT_LAB.env, intensity: LIGHT_LAB.envIntensity },
  };
  const json = JSON.stringify(out, null, 2);
  console.log("[Light Lab] current setup:\n" + json);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json).catch(() => {});
  toast("Setup logged to console");
}

/* Emit the current look as a paste-ready LIGHT_PRESETS entry (closes the
   tune-live -> bake-into-source loop). Matches the object shape of LIGHT_PRESETS. */
function copyPreset() {
  const L = LIGHT_LAB;
  const hex = (n) => "0x" + ((n >>> 0) & 0xffffff).toString(16).padStart(6, "0");
  const entry =
    `myPreset: { key:${L.key.toFixed(2)}, casterShare:${L.casterShare.toFixed(2)}, fill:${L.fill.toFixed(2)}, ` +
    `rim:${L.rim.toFixed(2)}, az:${Math.round(L.az)}, el:${Math.round(L.el)}, exposure:${L.exposure.toFixed(2)}, ` +
    `tonemap:"${L.tonemap}", bg:"${L.bg}", keyColor:${hex(L.keyColor)}, rimColor:${hex(L.rimColor)}, ` +
    `hemiSky:${hex(L.hemiSky)}, hemiGround:${hex(L.hemiGround)} },`;
  console.log("[Light Lab] preset entry:\n" + entry);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(entry).catch(() => {});
  toast("Preset entry copied");
}

/* Push LIGHT_LAB values into the panel controls (after a preset / reset). */
function syncLightLabUI() {
  const set = (id, v) => { const e = $(id); if (e) e.value = v; };
  const txt = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  const col = (id, n) => { const e = $(id); if (e) e.value = "#" + ((n >>> 0) & 0xffffff).toString(16).padStart(6, "0"); };
  set("llKey", Math.round(LIGHT_LAB.key * 100));   txt("llKeyV", LIGHT_LAB.key.toFixed(2));
  set("llFill", Math.round(LIGHT_LAB.fill * 100));  txt("llFillV", LIGHT_LAB.fill.toFixed(2));
  set("llRim", Math.round(LIGHT_LAB.rim * 100));   txt("llRimV", LIGHT_LAB.rim.toFixed(2));
  set("llCaster", Math.round(LIGHT_LAB.casterShare * 100)); txt("llCasterV", LIGHT_LAB.casterShare.toFixed(2));
  set("llExp", Math.round(LIGHT_LAB.exposure * 100)); txt("llExpV", LIGHT_LAB.exposure.toFixed(2));
  set("llAz", Math.round(LIGHT_LAB.az));   txt("llAzV", Math.round(LIGHT_LAB.az) + "°");
  set("llEl", Math.round(LIGHT_LAB.el));   txt("llElV", Math.round(LIGHT_LAB.el) + "°");
  col("llKeyCol", LIGHT_LAB.keyColor); col("llRimCol", LIGHT_LAB.rimColor);
  col("llSkyCol", LIGHT_LAB.hemiSky);  col("llGndCol", LIGHT_LAB.hemiGround);
  set("llRough", Math.round(LIGHT_LAB.rough * 100)); txt("llRoughV", LIGHT_LAB.rough.toFixed(2));
  set("llMetal", Math.round(LIGHT_LAB.metal * 100)); txt("llMetalV", LIGHT_LAB.metal.toFixed(2));
  set("llEnv", Math.round(LIGHT_LAB.envIntensity * 100)); txt("llEnvV", LIGHT_LAB.envIntensity.toFixed(2));
  const sw = (id, on) => { const e = $(id); if (e) e.classList.toggle("on", on); };
  sw("swHeadlight", LIGHT_LAB.headlight); sw("swShadows", LIGHT_LAB.shadows);
  sw("swGround", LIGHT_LAB.ground); sw("swSpin", LIGHT_LAB.spin);
  sw("swEnv", LIGHT_LAB.env);
  sw("swFlat", LIGHT_LAB.flat); sw("swClay", LIGHT_LAB.clay); sw("swEdges", LIGHT_LAB.edges);
  syncChips(".ll-tm", "tm", LIGHT_LAB.tonemap);
  syncChips(".ll-bgc", "bg", LIGHT_LAB.bg);
}

function wireLightLab() {
  const panel = document.querySelector(".panel.lightlab");
  if (!DEV.lightPanel) { if (panel) panel.remove(); return; }   // developer panel disabled in source
  if (!panel || !$("llKey")) return;                            // panel markup absent (e.g. stripped build)
  document.querySelectorAll(".ll-preset").forEach((c) => c.addEventListener("click", () => applyLightPreset(c.dataset.preset)));
  const slider = (id, valId, fn, fmt) => {
    const inp = $(id), out = $(valId);
    inp.addEventListener("input", () => { const raw = +inp.value; fn(raw); if (out) out.textContent = fmt(raw); refreshReadout(); });
  };
  slider("llKey", "llKeyV", (v) => { LIGHT_LAB.key = v / 100; applyKeyIntensity(); }, (v) => (v / 100).toFixed(2));
  slider("llFill", "llFillV", (v) => { LIGHT_LAB.fill = v / 100; applyFillIntensity(); }, (v) => (v / 100).toFixed(2));
  slider("llRim", "llRimV", (v) => { LIGHT_LAB.rim = v / 100; applyRim(); }, (v) => (v / 100).toFixed(2));
  slider("llCaster", "llCasterV", (v) => { LIGHT_LAB.casterShare = v / 100; applyKeyIntensity(); }, (v) => (v / 100).toFixed(2));
  slider("llExp", "llExpV", (v) => { LIGHT_LAB.exposure = v / 100; applyExposure(); }, (v) => (v / 100).toFixed(2));
  slider("llAz", "llAzV", (v) => { LIGHT_LAB.az = v; applyKeyDirection(); }, (v) => v + "°");
  slider("llEl", "llElV", (v) => { LIGHT_LAB.el = v; applyKeyDirection(); }, (v) => v + "°");
  slider("llRough", "llRoughV", (v) => { LIGHT_LAB.rough = v / 100; setRoughness(v / 100); }, (v) => (v / 100).toFixed(2));
  slider("llMetal", "llMetalV", (v) => { LIGHT_LAB.metal = v / 100; setMetalness(v / 100); }, (v) => (v / 100).toFixed(2));
  slider("llEnv", "llEnvV", (v) => { setEnvIntensity(v / 100); }, (v) => (v / 100).toFixed(2));

  const colorInput = (id, key, apply) => {
    const inp = $(id); if (!inp) return;
    inp.addEventListener("input", () => { LIGHT_LAB[key] = parseInt(inp.value.slice(1), 16); apply(); refreshReadout(); });
  };
  colorInput("llKeyCol", "keyColor", applyKeyColor);
  colorInput("llRimCol", "rimColor", applyRimColor);
  colorInput("llSkyCol", "hemiSky", applyHemiColors);
  colorInput("llGndCol", "hemiGround", applyHemiColors);

  toggleRow("ll-headlight", () => {
    LIGHT_LAB.headlight = !LIGHT_LAB.headlight; $("swHeadlight").classList.toggle("on", LIGHT_LAB.headlight);
    if (LIGHT_LAB.headlight && LIGHT_LAB.spin) { setLightSpin(false); $("swSpin").classList.remove("on"); }   // mutually exclusive
    applyShadows(); if (!LIGHT_LAB.headlight) applyKeyDirection();   // restore aimed key when leaving headlight
    refreshReadout();
  });
  toggleRow("ll-shadows", () => { LIGHT_LAB.shadows = !LIGHT_LAB.shadows; $("swShadows").classList.toggle("on", LIGHT_LAB.shadows); applyShadows(); refreshReadout(); });
  toggleRow("ll-ground", () => { const on = !LIGHT_LAB.ground; $("swGround").classList.toggle("on", on); setGroundShadow(on); refreshReadout(); });
  toggleRow("ll-spin", () => { const on = !LIGHT_LAB.spin; setLightSpin(on); $("swSpin").classList.toggle("on", LIGHT_LAB.spin); $("swHeadlight").classList.toggle("on", LIGHT_LAB.headlight); refreshReadout(); });
  toggleRow("ll-flat", () => { const on = !LIGHT_LAB.flat; LIGHT_LAB.flat = on; $("swFlat").classList.toggle("on", on); setFlatShading(on); });
  toggleRow("ll-clay", () => { const on = !LIGHT_LAB.clay; $("swClay").classList.toggle("on", on); setClay(on); });
  toggleRow("ll-edges", () => { const on = !LIGHT_LAB.edges; $("swEdges").classList.toggle("on", on); setEdges(on); });
  toggleRow("ll-env", () => { const on = !LIGHT_LAB.env; $("swEnv").classList.toggle("on", on); setEnvironment(on); refreshReadout(); });

  document.querySelectorAll(".ll-tm").forEach((c) => c.addEventListener("click", () => {
    LIGHT_LAB.tonemap = c.dataset.tm; syncChips(".ll-tm", "tm", c.dataset.tm); applyToneMap(); refreshReadout();
  }));
  document.querySelectorAll(".ll-bgc").forEach((c) => c.addEventListener("click", () => setBg(c.dataset.bg)));

  $("llPreset").addEventListener("click", copyPreset);
  $("llLog").addEventListener("click", logSetup);
  $("llReset").addEventListener("click", resetLightLab);
  refreshReadout();
}

function wireUI() {
  // import / open
  $("btnImport").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => { readFilesAndAdd(e.target.files); e.target.value = ""; });

  // menu
  $("btnMenu").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener("click", (e) => { if (!$("menu").contains(e.target) && e.target !== $("btnMenu")) closeMenu(); });
  $("miSave").addEventListener("click", saveFile);
  $("miEdit").addEventListener("click", () => { closeMenu(); setEditMode(true); openInfo(true); $("ifTitle").focus(); });
  $("miConfidential").addEventListener("click", addConfidentialNotice);
  $("miSaveXform").addEventListener("click", saveTransformsAsDefault);
  $("miRemoveXform").addEventListener("click", () => { closeMenu(); resetAllTransforms(); });
  $("miRemovePart").addEventListener("click", () => { closeMenu(); removeSelectedPart(); });
  $("miRemoveAll").addEventListener("click", () => { closeMenu(); removeAllParts(); });
  document.querySelectorAll("#oriChips .chip").forEach((c) => c.addEventListener("click", () => { applyUpAxis(c.dataset.axis); setView("iso"); }));
  $("swGrid").closest(".menu-toggle-row").addEventListener("click", () => setGrid(!state.meta.gridOn));

  // navigator
  document.querySelectorAll(".viewBtn").forEach((b) => b.addEventListener("click", () => { currentViewName = b.dataset.view; setView(b.dataset.view); }));
  $("btnProj").addEventListener("click", () => setProjection(state.meta.projection === "ortho" ? "persp" : "ortho"));
  $("btnFit").addEventListener("click", fitToView);

  // tools — measure
  $("btnMeasure").addEventListener("click", () => setMode(mode === "measure" ? "orbit" : "measure"));
  $("btnRemoveMeas").addEventListener("click", () => setMode(mode === "removeMeas" ? "orbit" : "removeMeas"));
  $("btnClearMeas").addEventListener("click", clearMeasurements);
  toggleRow("meas", () => { measDisplay = !measDisplay; $("swMeasDisp").classList.toggle("on", measDisplay); applyMeasDisplay(); });

  // tools — section
  toggleRow("section", () => {
    state.section.on = !state.section.on;
    $("swSection").classList.toggle("on", state.section.on);
    if (state.section.on) { syncChips(".secAxis", "axis", state.section.axis); buildSection(); syncSecSlider(); } else teardownSection();
  });
  document.querySelectorAll(".secAxis").forEach((c) => c.addEventListener("click", () => {
    state.section.axis = c.dataset.axis; syncChips(".secAxis", "axis", state.section.axis);
    if (state.section.on) buildSection();
    syncSecSlider();   // restore this axis' offset onto the slider
  }));
  $("secFlip").addEventListener("click", () => { state.section.flip = !state.section.flip; $("secFlip").classList.toggle("active", state.section.flip); if (state.section.on) updateSectionGeometry(); });
  $("secSlider").addEventListener("input", (e) => { setSecD(tToD(e.target.value / 1000)); updateSectionGeometry(); });
  // typed offset is already an absolute mm distance from the origin / floor grid
  const commitSecVal = () => {
    const v = parseFloat($("secVal").value);
    if (isFinite(v)) setSecD(v);
    syncSecUI();
  };
  $("secVal").addEventListener("change", commitSecVal);
  $("secVal").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("secVal").blur(); } });

  // tools — annotation
  $("btnAnnot").addEventListener("click", () => setMode(mode === "annotate" ? "orbit" : "annotate"));
  $("btnRemoveAnnot").addEventListener("click", () => setMode(mode === "removeAnnot" ? "orbit" : "removeAnnot"));
  $("btnClearAnnot").addEventListener("click", clearAnnotations);
  toggleRow("annot", () => { annotDisplay = !annotDisplay; $("swAnnotDisp").classList.toggle("on", annotDisplay); applyAnnotDisplay(); });

  // objects
  $("btnIsolate").addEventListener("click", isolatePart);
  $("btnHideSel").addEventListener("click", hideSelected);
  $("btnShowAll").addEventListener("click", showAll);

  // transform parts: toggle edit mode + floating Move/Rotate bar + reset-all + coord inputs
  $("btnXform").addEventListener("click", () => setXformMode(!xformMode));
  $("xfMove").addEventListener("click", () => setGizmoMode("translate"));
  $("xfRotate").addEventListener("click", () => setGizmoMode("rotate"));
  $("xfClose").addEventListener("click", () => setXformMode(false));
  $("btnResetXform").addEventListener("click", resetAllTransforms);
  const wireXf = (id, commit) => {
    const inp = $(id);
    inp.addEventListener("change", commit);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
  };
  ["x", "y", "z"].forEach((axis) => wireXf("pos" + axis.toUpperCase(), () => commitPartCoord(axis)));
  ["X", "Y", "Z"].forEach((ax) => wireXf("rot" + ax, commitPartRot));
  wireXf("scaleU", commitPartScale);

  setupCollapsiblePanels();
  wireLightLab();   // LIGHT LAB (temporary)

  // info panel — hover the (i) button to preview, click to pin it open
  const infoBtn = $("btnInfo"), infoPanelEl = $("infoPanel");
  infoBtn.addEventListener("mouseenter", showInfo);
  infoBtn.addEventListener("mouseleave", scheduleHideInfo);
  infoPanelEl.addEventListener("mouseenter", () => clearTimeout(infoHideTimer));
  infoPanelEl.addEventListener("mouseleave", scheduleHideInfo);
  infoBtn.addEventListener("click", () => { infoPinned = !infoPinned; if (infoPinned) showInfo(); });
  $("ifTitle").addEventListener("input", (e) => { state.meta.title = e.target.value; $("modelName").textContent = e.target.value || "Untitled model"; });
  $("ifDesc").addEventListener("input", (e) => { state.meta.description = e.target.value; });
  $("ifSave").addEventListener("click", commitEdit);
  $("ifDiscard").addEventListener("click", discardEdit);
  // NB: copyright is display-only and intentionally has no input handler.

  // model name in the top bar — only editable while edit mode is on
  const mn = $("modelName");
  mn.addEventListener("click", () => {
    if (!editMode) return;
    mn.contentEditable = "true"; mn.focus();
    if (document.execCommand) document.execCommand("selectAll", false, null);
  });
  mn.addEventListener("blur", () => { mn.contentEditable = "false"; state.meta.title = mn.textContent.trim(); $("ifTitle").value = state.meta.title; refreshInfoPanel(); });
  mn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); mn.blur(); } });
}

let editMode = false;
let editSnapshot = null;
function setEditMode(on) {
  if (on && !editMode) {
    // snapshot the editable fields so Discard can revert
    editSnapshot = {
      title: state.meta.title,
      description: state.meta.description,
      partNames: state.parts.map((p) => p.name),
    };
  }
  editMode = on;
  document.body.classList.toggle("editing", on);
  $("ifTitle").readOnly = !on;
  $("ifDesc").readOnly = !on;
  $("miEdit").classList.toggle("active-item", on);
  $("modelName").title = on ? "Click to rename" : "";
  rebuildObjectsPanel();   // refresh per-row rename affordance / tooltips
}

function commitEdit() {                 // keep the live values, leave edit mode
  setEditMode(false);
  editSnapshot = null;
  toast("Changes saved");
}

function discardEdit() {                 // revert to the snapshot, leave edit mode
  if (editSnapshot) {
    state.meta.title = editSnapshot.title;
    state.meta.description = editSnapshot.description;
    state.parts.forEach((p, i) => { if (editSnapshot.partNames[i] != null) p.name = editSnapshot.partNames[i]; });
    $("modelName").textContent = state.meta.title || "Untitled model";
    rebuildObjectsPanel();
  }
  editSnapshot = null;
  setEditMode(false);
  refreshInfoPanel();
}

/* Confidential notice — add via the menu. Once set it is PERMANENT: it can be
   neither changed nor removed (and it's embedded on Save). */
function addConfidentialNotice() {
  closeMenu();
  if (state.meta.confidential && state.meta.confidential.trim()) {
    toast("Confidential notice is locked — it can't be changed or removed");
    return;
  }
  const txt = prompt("Confidential notice (permanent once added — can't be changed or removed):",
                     "Confidential — not for distribution");
  if (txt == null) return;                       // cancelled
  const v = txt.trim();
  if (!v) { toast("Confidential notice can't be empty"); return; }
  state.meta.confidential = v;
  refreshInfoPanel();                            // reveals + updates the badge
  toast("Confidential notice added");
}

// reflect whether a notice exists in the menu item (and make clear it's locked)
function updateConfidentialMenu() {
  const mi = $("miConfidential");
  if (!mi) return;
  const has = !!(state.meta.confidential && state.meta.confidential.trim());
  mi.classList.toggle("active-item", has);
  mi.classList.toggle("locked", has);
  const lbl = mi.querySelector(".label"), desc = mi.querySelector(".desc");
  if (lbl && lbl.lastChild) lbl.lastChild.textContent = has ? "Confidential notice (locked)" : "Add confidential notice";
  if (desc) desc.textContent = has
    ? "This model is marked confidential. The notice can't be changed or removed."
    : "Mark this model as confidential. Once added, it can't be changed or removed.";
}

let infoHideTimer = null;   // pending hover-out close
let infoPinned = false;     // click-pinned (or opened via Edit) → don't auto-close
function showInfo() {
  clearTimeout(infoHideTimer);
  $("infoPanel").classList.add("open");
  refreshInfoPanel();
}
function scheduleHideInfo() {
  clearTimeout(infoHideTimer);
  // small delay bridges the gap between the button and the panel on the way over
  infoHideTimer = setTimeout(() => {
    if (infoPinned || document.body.classList.contains("editing")) return;
    $("infoPanel").classList.remove("open");
  }, 180);
}
function openInfo(forceOpen) {   // used by Menu → Edit; keep it pinned while editing
  if (forceOpen) infoPinned = true;
  showInfo();
}

function removeSelectedPart() {
  if (!selectedId) { toast("Select a part first"); return; }
  const i = state.parts.findIndex((p) => p.id === selectedId);
  if (i < 0) return;
  detachGizmo();
  modelRoot.remove(state.parts[i].mesh);
  state.parts.splice(i, 1);
  selectedId = null;
  updateXformResetUI(); refreshInfoPanel();
  if (state.section.on) buildSection();
  if (state.parts.length === 0) showOverlay("empty");
}

function removeAllParts() {
  if (state.parts.length === 0) return;
  if (!confirm("Remove all parts from the view?")) return;
  detachGizmo();
  state.parts.forEach((p) => modelRoot.remove(p.mesh));
  state.parts.length = 0; state.files.length = 0; selectedId = null;
  clearMeasurements();
  state.annotations.slice().forEach((a) => removeAnnotation(a.id));
  teardownSection(); state.section.on = false; $("swSection").classList.remove("on");
  // fresh model auto-centres the cut on every plane the next time section is enabled
  state.section.offsets = { x: null, y: null, z: null };
  $("secSlider").value = 500; $("secVal").value = "";
  updateXformResetUI(); refreshInfoPanel(); showOverlay("empty");
}

/* ----------------------------------------------------------------------------
   Boot
---------------------------------------------------------------------------- */
function readEmbedded() {
  const el = $("embedded-data");
  if (!el) return null;
  const raw = el.textContent.trim();
  if (!raw || raw === "null") return null;
  try { return JSON.parse(raw); } catch (e) { console.error("bad embedded data", e); return null; }
}

function boot() {
  document.title = BRAND.name;
  const bn = $("brandName"); if (bn) bn.textContent = BRAND.name;
  initThree();
  wireUI();
  setEditMode(false);   // editing is off by default
  const data = readEmbedded();
  if (data && (data.files || []).length) {
    loadFromState(data);
  } else {
    // empty standalone
    refreshInfoPanel();
    setProjection("persp");
    setGrid(!!state.meta.gridOn);
    showOverlay("empty");
  }
  if (DEV.lightPreset && LIGHT_PRESETS[DEV.lightPreset]) applyLightPreset(DEV.lightPreset);   // chosen boot/production lighting
  if (DEV.env) { setEnvironment(true); syncLightLabUI(); }   // optional baked-in image-based reflections
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
