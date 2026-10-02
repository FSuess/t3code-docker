# Vendored design system

These three files come from the T3 Code Console design handoff
(`t3code-console-handoff/design-system/`). They are the component layer the
console is built from, and are kept as close to the handoff as possible so a
newer handoff can be dropped in and diffed:

| File | From | Notes |
| --- | --- | --- |
| `tokens.css` | `tokens.css` | The custom properties only; the generated type classes (`.display`, `.title`, `.body`…) are left out because they are too generic for a page. |
| `components.css` | `components/bundle.css` | Verbatim except the fixes below. |
| `ui.js` | `components/bundle.js` | Verbatim except the fixes below. Exposes `window.T3C`. |

The page's own layout (the shell, the phone bar, overlays, the toaster) lives in
`../console.css`, never here.

## Local fixes

Each of these is a bug in the handoff, not a restyle. Keep them when syncing.

1. **`--sidebar` meant two things.** The handoff's `tokens.css` declares
   `--sidebar` as the sidebar's colour in each theme block and again as the
   256px layout width in `:root`. With `data-theme` on `<html>` both selectors
   match the same element with equal specificity, so the width won and the
   sidebar lost its ground in both themes. The width is now `--sidebar-w`, in
   `tokens.css` and in `.tc-app`'s grid in `components.css`. (The handoff's
   mockups set `data-theme` on an inner element, which hid the collision.)
2. **Copy did nothing over plain HTTP.** `navigator.clipboard` only exists in a
   secure context, and the console is usually opened at `http://host:3774`, so
   every Copy narrated "Press ⌘C". `ui.js` now falls back to a selected textarea
   and `execCommand('copy')` before narrating, and exposes the result as
   `T3C.copyText(text) -> Promise<boolean>`.
3. **"Press ⌘C" everywhere.** The narration names the keys of the platform it
   runs on (`⌘C` on Apple devices, `Ctrl C` elsewhere), as the Kbd guideline
   asks; `T3C.copyKeys` carries it.
