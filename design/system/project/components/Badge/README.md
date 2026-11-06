# Badge

A small pill that shows the state of an update or a label for the app.

The consumer provides the `pd-badge` class, one tone and the text.

- `pd-badge-ok`: the update is applied.
- `pd-badge-wait`: a person must decide.
- `pd-badge-back`: the update failed and was rolled back. Also used for rules that never run.
- `pd-badge-plain`: a neutral label such as the version or "Sample data".
- Never show a status color without its word.
