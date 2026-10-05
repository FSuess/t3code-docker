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
   sidebar lost its background in both themes. The width is now `--sidebar-w`, in
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
4. **The empty state's back cards painted over its icon.** The handoff drew the
   two fanned cards as `.tc-empty-icon`'s own `::before`/`::after` at
   `z-index: -1` inside an `isolation: isolate` box, which paints them above
   that box's background, so their outlines crossed the icon's card. T3's
   EmptyMedia uses sibling elements. Here the cards belong to a wrapper,
   `<span class="tc-empty-media"><span class="tc-empty-icon">…</span></span>`,
   and the icon's card sits above them. They use T3's geometry: 2px out, not 6px. In
   the same component, `.tc-empty--compact` with an icon squeezed its title
   into a one-word column on a phone; it now stacks the title over its line
   beside the icon.

## Local additions

Not in the handoff. Keep them when syncing.

- **Agent marks.** `T3C.agentMark(id)` draws an agent's own mark (Claude Code,
  Codex, OpenCode, Grok, Cursor, Antigravity) as T3 Code's provider settings
  draw it, from `AGENT_MARKS` in `ui.js`, and `.tc-tile--mark` sets it on a
  neutral tile in place of a monogram. One-colour marks fill with
  `currentColor` so they follow the theme; Claude keeps its orange, OpenCode's
  two tones are `--agentmark-ink` and `--agentmark-hole` in `tokens.css`, and
  Antigravity's gradient mark is a 64px image. The class is `tc-agentmark`
  rather than `tc-brand`, which is the sidebar's brand block.
- **Provider marks.** The same function draws the source control providers'
  marks (GitHub, GitLab, Forgejo, Azure DevOps) from `PROVIDER_MARKS`, as T3
  Code's Source Control settings draw them. T3 has none for Gitea, which it
  files under Forgejo; Gitea's is its repository's `assets/logo.svg`. A mark's
  gradient ids start `ID-`, which `agentMark` makes unique per drawing.
