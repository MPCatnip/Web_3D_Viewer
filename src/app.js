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
  copyright:    "",            // default for Model information, e.g. "© Acme Corp"
  confidential: "",            // default confidential notice ("" = hidden)
};

const NEUTRAL_COLOR = 0x9099A2;      // default shaded part color (mid neutral grey)
const CAP_COLOR     = 0xb0534e;      // muted red section caps
const SELECT_EMIS   = 0x12385f;      // selection highlight (emissive)
const BG_COLOR      = 0xF9FAFA;
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
  section: { on: false, axis: "x", flip: false, offsets: { x: 0.5, y: 0.5, z: 0.5 } },
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
const viewportEl = $("viewport");

function initThree() {
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
  // gentle key for a directional cue.
  scene.add(new THREE.AmbientLight(0xffffff, 0.2));
  const hemi = new THREE.HemisphereLight(0xffffff, 0x333333, 0.55);
  scene.add(hemi);

  // The key light is split in two so the self-shadow can be really faint without
  // flattening the shading: a low-intensity shadow CASTER plus a same-direction
  // non-casting light carrying the rest of the key brightness. Lit faces get the full
  // KEY_TOTAL; shadowed faces lose only the caster's small SHADOW_SHARE.
  const KEY_TOTAL = 0.6, SHADOW_SHARE = 0.1;
  const key = new THREE.DirectionalLight(0xffffff, SHADOW_SHARE); key.position.set(0.7, 1.3, 1.0);
  const keyMain = new THREE.DirectionalLight(0xffffff, KEY_TOTAL - SHADOW_SHARE); keyMain.position.set(0.7, 1.3, 1.0);
  const fill = new THREE.DirectionalLight(0xffffff, 0.34); fill.position.set(-1.1, 0.4, -0.6);
  const rim = new THREE.DirectionalLight(0xffffff, 0.28); rim.position.set(0.2, -0.9, -0.8);

  // Only `key` casts the soft self-shadow. Its frustum + distance are sized to the
  // model in updateShadowCamera(); only the *direction* (its position here) matters now.
  shadowLight = key;
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0002;            // small depth offset to kill self-shadow acne
  key.shadow.radius = 8;               // penumbra blur (VSM) — higher = softer edges
  key.shadow.blurSamples = 35;          // smoothness of that blur
  scene.add(key.target);                // target must be in the scene graph to take effect

  scene.add(key, keyMain, fill, rim);

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
  if (gridHelper) positionGrid();
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
const SHADOW_DIR = new THREE.Vector3(0.7, 1.3, 1.0).normalize();   // matches key-light direction
function updateShadowCamera(center, radius) {
  if (!shadowLight || !center) return;
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
    roughness: 0.6, metalness: 0.0,   // a little specular so dark parts still catch light
    side: THREE.DoubleSide,
    flatShading: false,
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
        state.files.push({ id: fileId, name, format, data: abToB64(buffer) });
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
}

function resetAllTransforms() {
  state.parts.forEach((p) => { p.mesh.position.copy(p.basePos); p.mesh.quaternion.copy(p.baseQuat); p.mesh.scale.copy(p.baseScale); p.mesh.updateMatrixWorld(true); });
  if (state.section.on) buildSection();
  updateXformResetUI();
  updatePartCoords();
  refreshObjInfo();
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
  $("btnAnnot").classList.toggle("active", m === "annotate");
  $("btnRemoveAnnot").classList.toggle("active", m === "removeAnnot");
  // Rotation stays enabled in every mode. A drag orbits the model; a click (no drag,
  // see onPointerUp) places a measurement/annotation point or changes selection. This
  // lets you place point A, rotate to the far side, then place point B.
  measurePending = null;
  document.querySelectorAll(".label.annot").forEach((el) => el.classList.toggle("removable", m === "removeAnnot"));
  if (m === "measure") showHint('Click two points on the model to measure. <kbd>Esc</kbd> to stop.');
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
    if (!measurePending) { measurePending = local; spawnTempDot(local); }
    else { addMeasurement(measurePending, local); measurePending = null; clearTempDot(); }
  } else if (mode === "annotate") {
    const hit = pickPoint(ev);
    if (!hit) return;
    const local = markerRoot.worldToLocal(hit.point.clone());
    const a = addAnnotation(local, "", { isNew: true });
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
  const d = local.clone().sub(measurePending);
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
  tempDot = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0x385e9d }));
  tempDot.position.copy(local);
  markerRoot.add(tempDot);
}
function clearTempDot() { if (tempDot) { markerRoot.remove(tempDot); tempDot = null; } }

const MEAS_COLOR = 0x385e9d;
const XRAY_OPACITY = 0.3;
function addMeasurement(a, b) {
  const id = uid("m");
  const group = new THREE.Group();
  const lineGeo = new THREE.BufferGeometry().setFromPoints([a, b]);

  // Solid pass (depth-tested): the dots + line, hidden where the model is in front.
  const matDot = new THREE.MeshBasicMaterial({ color: MEAS_COLOR });
  const da = new THREE.Mesh(sphereGeo, matDot); da.position.copy(a);
  const db = new THREE.Mesh(sphereGeo, matDot); db.position.copy(b);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: MEAS_COLOR }));

  // X-ray pass (no depth test): the same dots + line drawn through the model, faded.
  // Same colour, so where the solid pass is visible the overlay blends in invisibly;
  // only the part behind the model shows up — and only at the reduced opacity.
  const matDotX = new THREE.MeshBasicMaterial({ color: MEAS_COLOR, transparent: true, opacity: XRAY_OPACITY, depthTest: false, depthWrite: false });
  const daX = new THREE.Mesh(sphereGeo, matDotX); daX.position.copy(a); daX.renderOrder = 4;
  const dbX = new THREE.Mesh(sphereGeo, matDotX); dbX.position.copy(b); dbX.renderOrder = 4;
  const lineX = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: MEAS_COLOR, transparent: true, opacity: XRAY_OPACITY, depthTest: false, depthWrite: false }));
  lineX.renderOrder = 4;

  group.add(da, db, line, daX, dbX, lineX);
  markerRoot.add(group);

  const d = b.clone().sub(a);
  const el = document.createElement("div");
  el.className = "label measure";
  el.innerHTML = `${fmt(d.length())} mm<span class="comp">Δ ${fmt(d.x)} · ${fmt(d.y)} · ${fmt(d.z)}</span>`;
  const label = new THREE.CSS2DObject(el);
  label.position.copy(a.clone().add(b).multiplyScalar(0.5));
  group.add(label);

  const m = { id, a: a.clone(), b: b.clone(), group, label, el };
  state.measurements.push(m);
  applyMeasDisplay();
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

  const a = { id, p: local.clone(), lp: lp.clone(), text, group, marker, line, lineX, geo, obj, el, txt, _editing: false, _isNew: !!opts.isNew };

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
// offset (0..1) along the cut normal, remembered per file axis
function secT() { return state.section.offsets[state.section.axis]; }
function setSecT(v) { state.section.offsets[state.section.axis] = clamp01(v); }
// world-space cut normal for the active axis, ignoring flip (the offset axis)
function sectionBaseNormal() {
  return AXES[state.section.axis].clone().applyQuaternion(modelRoot.quaternion).normalize();
}

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
}

function updateSectionGeometry() {
  if (!state.section.on || !capMesh) return;
  const box = getWorldBox();
  if (!box) return;
  const bn = sectionBaseNormal();                          // un-flipped offset axis
  const center = box.getCenter(new THREE.Vector3());
  const { min, max } = projectRange(box, bn);
  const eps = (max - min) * 0.001 + 1e-4;
  const d = (min + eps) + (max - min - 2 * eps) * secT();  // distance along bn — fixed by offset

  // Flip only swaps which side is removed; the cut stays put. A plane (n, c) and
  // (-n, -c) are the same plane geometrically but clip opposite half-spaces.
  if (state.section.flip) { sectionPlane.normal.copy(bn).negate(); sectionPlane.constant = d; }
  else                    { sectionPlane.normal.copy(bn);          sectionPlane.constant = -d; }

  // place cap on the plane near model centre (position is flip-independent)
  const onPlane = center.clone().add(bn.clone().multiplyScalar(d - bn.dot(center)));
  capMesh.position.copy(onPlane);
  capMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), sectionPlane.normal);

  // read-out: distance from the world origin (grid 0) along the axis, in mm. `d` is
  // already the plane's signed offset from the origin along bn (origin·bn = 0), so the
  // reading is origin-based, not bounding-box-based. Leave the field alone while typing.
  const rel = d;
  const inp = $("secVal");
  if (document.activeElement !== inp) inp.value = fmt(rel);
}

// convert a typed mm offset (from the world origin / grid 0) into a slider position (0..1)
function offsetToT(rel) {
  const box = getWorldBox();
  if (!box) return secT();
  const bn = sectionBaseNormal();
  const { min, max } = projectRange(box, bn);
  const eps = (max - min) * 0.001 + 1e-4;
  const span = (max - min) - 2 * eps;
  if (span <= 0) return 0.5;
  const d = rel;   // origin-based: the plane sits at distance `rel` from the origin along bn
  return clamp01((d - (min + eps)) / span);
}

// mirror the active-axis offset onto the slider + input
function syncSecUI() {
  $("secSlider").value = Math.round(secT() * 1000);
  if (state.section.on) updateSectionGeometry();
}

/* ----------------------------------------------------------------------------
   Floor grid
---------------------------------------------------------------------------- */
function ensureGrid() {
  const box = getWorldBox();
  const size = box ? box.getSize(new THREE.Vector3()).length() * 1.5 : 100;
  if (gridHelper) scene.remove(gridHelper);
  const div = 20;
  gridHelper = new THREE.GridHelper(size, div, 0xC2C7CD, 0xE1E3E7);
  scene.add(gridHelper);
  positionGrid();
}
function positionGrid() {
  if (!gridHelper) return;
  const box = getWorldBox();
  if (box) gridHelper.position.set(box.getCenter(new THREE.Vector3()).x, box.min.y, box.getCenter(new THREE.Vector3()).z);
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
    nm.title = p.name;
    nm.addEventListener("dblclick", () => { if (editMode) beginRenamePart(nm, p.id); });

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
    meta: Object.assign({}, state.meta),
    files: state.files.map((f) => ({ id: f.id, name: f.name, format: f.format, data: f.data })),
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
    measurements: state.measurements.map((m) => ({ a: m.a.toArray(), b: m.b.toArray() })),
    annotations: state.annotations.map((a) => ({ p: a.p.toArray(), o: a.lp.clone().sub(a.p).toArray(), text: a.text })),
    section: { on: state.section.on, axis: state.section.axis, flip: state.section.flip, offsets: Object.assign({}, state.section.offsets) },
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
  // migrate older files that stored a single `t` instead of per-axis offsets
  const def = (typeof sec.t === "number") ? sec.t : 0.5;
  const off = sec.offsets || {};
  state.section = {
    on: !!sec.on, axis: sec.axis || "x", flip: !!sec.flip,
    offsets: {
      x: (typeof off.x === "number") ? off.x : def,
      y: (typeof off.y === "number") ? off.y : def,
      z: (typeof off.z === "number") ? off.z : def,
    },
  };

  applyUpAxis(state.meta.upAxis || "z+");

  // group part-meta by file for re-applying after parse
  const partsByFile = {};
  (data.parts || []).forEach((p) => { (partsByFile[p.fileId] = partsByFile[p.fileId] || []).push(p); });

  const files = data.files || [];
  const tasks = files.map((f) => {
    const buf = b64ToAb(f.data);
    const metaParts = (partsByFile[f.id] || []).sort((a, b) => a.index - b.index);
    return addFile(f.name, buf, { format: f.format, fileId: f.id, metaParts, fromState: true });
  });

  Promise.all(tasks).then(() => {
    (data.measurements || []).forEach((m) => addMeasurement(new THREE.Vector3().fromArray(m.a), new THREE.Vector3().fromArray(m.b)));
    (data.annotations || []).forEach((a) => {
      const p = new THREE.Vector3().fromArray(a.p);
      const lp = a.o ? p.clone().add(new THREE.Vector3().fromArray(a.o)) : null;
      addAnnotation(p, a.text || "", lp ? { lp } : {});
    });
    finishLoad();
    $("secFlip").classList.toggle("active", state.section.flip);
    if (state.section.on) { $("swSection").classList.add("on"); syncChips(".secAxis", "axis", state.section.axis); buildSection(); }
    $("secSlider").value = Math.round(secT() * 1000);
  });
}

/* shared post-load wiring */
function finishLoad() {
  rebuildObjectsPanel();
  updateXformResetUI();   // surfaces reset controls if any saved part has a transform
  refreshInfoPanel();
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
    if (!state.meta.gridOn) setGrid(true);
    else if (gridHelper) ensureGrid();
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
function wireUI() {
  // import / open
  $("btnImport").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => { readFilesAndAdd(e.target.files); e.target.value = ""; });

  // menu
  $("btnMenu").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener("click", (e) => { if (!$("menu").contains(e.target) && e.target !== $("btnMenu")) closeMenu(); });
  $("miSave").addEventListener("click", saveFile);
  $("miEdit").addEventListener("click", () => { closeMenu(); setEditMode(true); openInfo(true); $("ifTitle").focus(); });
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
  $("btnClearMeas").addEventListener("click", clearMeasurements);
  toggleRow("meas", () => { measDisplay = !measDisplay; $("swMeasDisp").classList.toggle("on", measDisplay); applyMeasDisplay(); });

  // tools — section
  toggleRow("section", () => {
    state.section.on = !state.section.on;
    $("swSection").classList.toggle("on", state.section.on);
    if (state.section.on) { syncChips(".secAxis", "axis", state.section.axis); buildSection(); } else teardownSection();
  });
  document.querySelectorAll(".secAxis").forEach((c) => c.addEventListener("click", () => {
    state.section.axis = c.dataset.axis; syncChips(".secAxis", "axis", state.section.axis);
    $("secSlider").value = Math.round(secT() * 1000);   // restore this axis' offset
    if (state.section.on) buildSection();
  }));
  $("secFlip").addEventListener("click", () => { state.section.flip = !state.section.flip; $("secFlip").classList.toggle("active", state.section.flip); if (state.section.on) updateSectionGeometry(); });
  $("secSlider").addEventListener("input", (e) => { setSecT(e.target.value / 1000); updateSectionGeometry(); });
  // typed offset: parse the mm value, map back to a slider position, clamp to bounds
  const commitSecVal = () => {
    const rel = parseFloat($("secVal").value);
    if (isFinite(rel)) setSecT(offsetToT(rel));
    syncSecUI();
  };
  $("secVal").addEventListener("change", commitSecVal);
  $("secVal").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("secVal").blur(); } });

  // tools — annotation
  $("btnAnnot").addEventListener("click", () => setMode(mode === "annotate" ? "orbit" : "annotate"));
  $("btnRemoveAnnot").addEventListener("click", () => setMode(mode === "removeAnnot" ? "orbit" : "removeAnnot"));
  toggleRow("annot", () => { annotDisplay = !annotDisplay; $("swAnnotDisp").classList.toggle("on", annotDisplay); applyAnnotDisplay(); });

  // objects
  $("btnIsolate").addEventListener("click", isolatePart);
  $("btnHideSel").addEventListener("click", hideSelected);
  $("btnShowAll").addEventListener("click", showAll);

  // transform parts: toggle edit mode + floating Move/Rotate bar + reset-all + coord inputs
  $("btnXform").addEventListener("click", () => setXformMode(!xformMode));
  $("xfMove").addEventListener("click", () => setGizmoMode("translate"));
  $("xfRotate").addEventListener("click", () => setGizmoMode("rotate"));
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
  // fresh model starts centred on every plane
  state.section.offsets = { x: 0.5, y: 0.5, z: 0.5 };
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
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
