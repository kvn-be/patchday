# Button

A pill button: `pd-btn` plus `pd-btn-main`, `pd-btn-line` or `pd-btn-coffee`, optionally `pd-btn-small`. `pd-link` is the quiet text action.

The consumer provides the label and, for icon-only buttons with `pd-btn-icon`, an `aria-label`.

- Buttons are solid, never glass, so they read on any surface. Main is `ink` with white text (17.9:1), secondary is near-white with `ink` text and a `control-edge` border.
- One `pd-btn-main` per page head, for the action that matters most. In rows the main action may repeat.
- `pd-btn-coffee` only links to `https://ko-fi.com/kvnbe`.
- `pd-btn-small` (36px) is for rows and the sidebar. Everything else is 44px.
- Hover lifts 1px, press gives to 0.97. Both stop with reduced motion.
- Labels are verbs: "Check now", "Update all", "Install".
