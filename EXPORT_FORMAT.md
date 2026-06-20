# Embedding models from CAD (NX / SolidWorks / any script)

The viewer loads its models from a single `<script>` block in the HTML:

```html
<script id="embedded-data" type="application/json">null</script>
```

To produce a ready-to-share viewer, an external script (e.g. a CAD post-export
step) takes the empty **`Standalone_3D_Viewer.html`**, replaces the `null` with a
JSON state object, and writes the result as a new `.html`. That's the entire
integration — no other change to the file is needed.

## JSON schema

```jsonc
{
  "v": 1,
  "meta": {
    "title": "Housing assembly",
    "description": "Rev C, as machined",
    "exportDate": "2026-06-15",      // date only, no time
    "copyright": "© Your Company",
    "confidential": "Confidential — not for distribution",
    "upAxis": "z+",                  // z+ z- x+ x- y+ y-   (CAD default = z+)
    "projection": "persp",           // persp | ortho
    "gridOn": false
  },
  "files": [
    {
      "id": "f1",
      "name": "body1.obj",
      "format": "obj",               // obj | stl | glb
      "data": "<BASE64 OF THE RAW FILE BYTES>"
    }
  ],
  "parts": [                         // optional; omit to auto-name every mesh
    { "fileId": "f1", "index": 0, "name": "Body 1", "color": 11515581, "visible": true }
  ],
  "measurements": [],                // optional
  "annotations": [],                 // optional: { "p":[x,y,z], "text":"…" }
  "section": { "on": false, "axis": "x", "t": 0.5, "flip": false }
}
```

Notes:
- **`data`** is base64 of the exact OBJ/STL/GLB bytes. The model's coordinates
  (origin) are preserved exactly; measurements and the bounding box are reported
  in those file units (mm).
- **`parts[].index`** is the 0-based order of the mesh within its file. For OBJ
  each `o`/`g` group is one part; for STL the whole file is one part.
- **`parts[].color`** is an integer `0xRRGGBB` (e.g. `0xAEB4BD` = `11449533`).
- Only `meta` + `files` are required. Everything else has sensible defaults.

## Minimal example (Python)

This is engine-agnostic — call it after your CAD tool (NX, SolidWorks, …) has
written the OBJ/STL files.

```python
import base64, json, re, datetime, pathlib

def build_viewer(empty_html, out_html, models, title):
    files, parts = [], []
    for i, (path, fmt) in enumerate(models):
        fid = f"f{i+1}"
        data = base64.b64encode(pathlib.Path(path).read_bytes()).decode("ascii")
        files.append({"id": fid, "name": pathlib.Path(path).name,
                      "format": fmt, "data": data})
        parts.append({"fileId": fid, "index": 0,
                      "name": pathlib.Path(path).stem, "visible": True})

    state = {
        "v": 1,
        "meta": {"title": title, "description": "", "copyright": "© Your Company",
                 "confidential": "Confidential — not for distribution",
                 "exportDate": datetime.date.today().isoformat(),
                 "upAxis": "z+", "projection": "persp", "gridOn": False},
        "files": files, "parts": parts,
        "measurements": [], "annotations": [],
        "section": {"on": False, "axis": "x", "t": 0.5, "flip": False},
    }

    payload = json.dumps(state)
    # keep the JSON safe inside a <script> text node
    payload = payload.replace("</script>", "<\\/script>").replace("<!--", "<\\!--")

    html = pathlib.Path(empty_html).read_text(encoding="utf-8")
    html = re.sub(
        r'(<script id="embedded-data" type="application/json">)(.*?)(</script>)',
        lambda m: m.group(1) + payload + m.group(3),
        html, count=1, flags=re.S)
    pathlib.Path(out_html).write_text(html, encoding="utf-8")

# usage:
build_viewer("Standalone_3D_Viewer.html", "Housing_viewer.html",
             [("body1.obj", "obj"), ("body2.stl", "stl")], "Housing assembly")
```

The produced `Housing_viewer.html` opens with the model auto-loaded, centered,
and framed in an isometric view — fully offline.
