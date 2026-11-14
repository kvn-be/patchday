# Wheel

A drum of choices: the chosen row sits in the band in the middle, its neighbours tilt away and fade. Overview uses two, for the day and the hour of the weekly run.

The consumer provides an empty element and mounts it with `Patchday.mountWheel(root, { items: [{ value, label }], value, label, rowHeight, onChange })`. It returns `{ set(value, animate), get() }`. Put a short heading above each wheel ("Day", "Time").

- Scroll, drag, click a row, or use the arrow keys, Page Up, Page Down, Home and End. The list is a `listbox` with the chosen row as its active option.
- It snaps to a row and reports a change once it rests, so a quick turn saves once.
- A wheel inside a hidden page takes its place when it shows, and reports nothing before.
- Five rows tall; 36px rows on Overview, 44px elsewhere. No loop: the week starts on Monday and the day starts at 00:00.
- With reduced motion it jumps instead of gliding, and rows do not tilt.
