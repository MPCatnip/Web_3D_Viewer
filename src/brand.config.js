/* ============================================================================
   Brand config — single source of truth for re-branding.
   Edit this file (name/copyright/confidential), src/brand-colors.css (palette)
   and src/brand-logo.svg (logo mark) to re-brand the viewer. No other source
   file should need to change.

   Declared as a plain top-level `const` (no wrapping IIFE) so it lands in the
   shared script-scope lexical environment that all classic <script> tags in
   this document contribute to — src/app.js's IIFE reads `BRAND` through that
   shared scope. build.mjs inlines this file's <script> tag before
   src/app.js's <script> tag, which is required for that to work.
   ========================================================================== */
const BRAND = {
  name:         "3D Viewer",   // applied to document.title + header wordmark
  copyright:    "",            // default for Model information, e.g. "© 3D Corp"
  confidential: "",            // default confidential notice ("" = hidden)
};
