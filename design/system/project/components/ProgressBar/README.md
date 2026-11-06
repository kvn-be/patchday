# ProgressBar

A thin bar that shows how far one update, or a whole run, has come.

The consumer provides the tone, the percent as the width of the inner `span`, and an `aria-label`.

- `pd-progress`: running, with a known percent.
- `pd-progress-busy`: running, but the tool reports no percent. The bar only shows activity and never pretends a number.
- `pd-progress-ok`: finished and confirmed.
- `pd-progress-fail`: failed or rolled back. Always show the short reason next to it.
- Container updates move through fixed steps: backup, update, test.
