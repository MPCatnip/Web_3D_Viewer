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
      "enc": "deflate",              // optional: "deflate" = data is zlib-compressed; omit for raw bytes
      "data": "<BASE64 OF THE (DEFLATED) FILE BYTES>"
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
- **`data`** is base64 of the OBJ/STL/GLB bytes. By default these are the raw file
  bytes; set **`enc: "deflate"`** to store them zlib-compressed instead (Python
  `zlib.compress`), which shrinks OBJ/STL by ~85–90%. Either way the model's
  coordinates (origin) are preserved exactly; measurements and the bounding box
  are reported in those file units (mm).
- **`enc`** is optional. Set it to `"deflate"` to mark `data` as compressed; omit
  it to treat `data` as raw bytes (older viewers without pako still read raw files).
  The viewer **auto-detects the compression wrapper**, so you can use whatever your
  language ships built-in — no Adler-32 hand-rolling, no .NET-version juggling:
    - **zlib** (RFC 1950): Python `zlib.compress`, Node `zlib.deflateSync`, .NET `ZLibStream`
    - **raw deflate** (RFC 1951): .NET `DeflateStream` (works on .NET Framework too)
    - **gzip** (RFC 1952): Python `gzip.compress`, .NET `GZipStream`
  All three load identically; pick the easiest for your toolchain. (The in-app
  "Save file" writes zlib.)
- **`parts[].index`** is the 0-based order of the mesh within its file. For OBJ
  each `o`/`g` group is one part; for STL the whole file is one part.
- **`parts[].color`** is an integer `0xRRGGBB` (e.g. `0xAEB4BD` = `11449533`).
- Only `meta` + `files` are required. Everything else has sensible defaults.

## Minimal example (Python)

This is engine-agnostic — call it after your CAD tool (NX, SolidWorks, …) has
written the OBJ/STL files.

```python
import base64, json, re, datetime, pathlib, zlib

def build_viewer(empty_html, out_html, models, title):
    files, parts = [], []
    for i, (path, fmt) in enumerate(models):
        fid = f"f{i+1}"
        raw = pathlib.Path(path).read_bytes()
        data = base64.b64encode(zlib.compress(raw, 9)).decode("ascii")  # deflate to shrink the file
        files.append({"id": fid, "name": pathlib.Path(path).name,
                      "format": fmt, "enc": "deflate", "data": data})
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

## Minimal example (C# / NXOpen)

Same contract, no browser. `DeflateStream` is in every .NET (incl. the .NET
Framework runtime NX hosts), so this needs no extra packages; the viewer
auto-detects the raw-deflate wrapper it produces.

```csharp
using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;

static string DeflateB64(byte[] raw)
{
    using (var ms = new MemoryStream())
    {
        // leaveOpen:true so we can ToArray() after the stream flushes on dispose
        using (var ds = new DeflateStream(ms, CompressionLevel.Optimal, true))
            ds.Write(raw, 0, raw.Length);
        return Convert.ToBase64String(ms.ToArray());
    }
}

static void BuildViewer(string emptyHtml, string outHtml,
                        (string path, string fmt)[] models, string title)
{
    var files = new List<string>();
    var parts = new List<string>();
    for (int i = 0; i < models.Length; i++)
    {
        string fid = "f" + (i + 1);
        string name = Path.GetFileName(models[i].path);
        string data = DeflateB64(File.ReadAllBytes(models[i].path));
        files.Add($"{{\"id\":\"{fid}\",\"name\":\"{name}\",\"format\":\"{models[i].fmt}\",\"enc\":\"deflate\",\"data\":\"{data}\"}}");
        parts.Add($"{{\"fileId\":\"{fid}\",\"index\":0,\"name\":\"{Path.GetFileNameWithoutExtension(name)}\",\"visible\":true}}");
    }

    string today = DateTime.Now.ToString("yyyy-MM-dd");
    string state =
        "{\"v\":1,\"meta\":{\"title\":" + Quote(title) +
        ",\"description\":\"\",\"copyright\":\"© Your Company\"," +
        "\"confidential\":\"Confidential — not for distribution\"," +
        "\"exportDate\":\"" + today + "\",\"upAxis\":\"z+\",\"projection\":\"persp\",\"gridOn\":false}," +
        "\"files\":[" + string.Join(",", files) + "]," +
        "\"parts\":[" + string.Join(",", parts) + "]," +
        "\"measurements\":[],\"annotations\":[]," +
        "\"section\":{\"on\":false,\"axis\":\"x\",\"t\":0.5,\"flip\":false}}";

    // keep the JSON safe inside a <script> text node
    state = state.Replace("</script>", "<\\/script>").Replace("<!--", "<\\!--");

    string html = File.ReadAllText(emptyHtml, Encoding.UTF8);
    html = Regex.Replace(html,
        "(<script id=\"embedded-data\" type=\"application/json\">)(.*?)(</script>)",
        m => m.Groups[1].Value + state.Replace("$", "$$") + m.Groups[3].Value,
        RegexOptions.Singleline);
    File.WriteAllText(outHtml, html, new UTF8Encoding(false));
}

static string Quote(string s) =>
    "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

// usage:
//   BuildViewer("Standalone_3D_Viewer.html", "Housing_viewer.html",
//               new[] { ("body1.obj","obj"), ("body2.stl","stl") }, "Housing assembly");
```

> If you'd rather assemble the state with `System.Text.Json` / `Newtonsoft.Json`,
> do — the hand-built JSON above just avoids a dependency. Either way keep the two
> `</script>` / `<!--` replacements, and remember `Regex.Replace`'s replacement
> string treats `$` specially (the `state.Replace("$", "$$")` above escapes it).
