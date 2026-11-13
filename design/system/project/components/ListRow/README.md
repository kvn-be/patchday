# ListRow

One row in every list: updates, packages and history share it.

The consumer provides `pd-item` with four children in this order: `icon` (the first letter, `icon new` with a dashed edge for things not installed), `name` (a `span` with the name and a `small` with the source), `ver` (versions as `3.4.0 → 3.4.1`, or a time in History) and `acts` (a pill or the row's buttons). A `reason` line and a `pd-progress` may follow. Group rows under a `pd-list-head` with a count: "Waits for you · 1".

- Same column order everywhere, so the eye learns it once.
- Actions sit in the row as buttons. No hidden menus.
- Order groups with what needs you first: waits for you, problems, planned, applied.
- Long names and versions cut with an ellipsis and show in full on hover.
