# ProgressBar

A thin bar that shows how far one update, or a whole run, has come.

The consumer provides `pd-progress` with one tone, the percent as the width of the inner `span`, and an `aria-label`.

- No tone: running with a known percent, in `ink`.
- `pd-progress-busy`: running without a percent. It only shows activity and never pretends a number.
- `pd-progress-ok`: finished and confirmed. `pd-progress-fail`: failed or rolled back, always with the reason next to it.
- Inside a `ListRow` it spans the name to the actions.
