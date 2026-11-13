# WeekDial

The signature of Patchday: a dial with one tick for each of the 168 hours of the week, used to pick when updates run.

The consumer provides an SVG, a range input and the chosen hour of the week (0 is Monday 00:00, 147 is Sunday 03:00, the default), and saves changes. Mount it with `Patchday.mountWeekDial(svg, input, { hour, days, short, onChange })`; pass `days` and `short` for German.

- Always pair the dial with a range input. It gives keyboard and screen reader access.
- The arcs mark the quiet hours, 00:00 to 06:00. Outside them, show a note in `back` that updates can restart running apps; inside, a note in `ok`.
- Show the day and time in the centre, and repeat the next run in a sentence below.
- The large dial lives on the Schedule page. Overview shows a small, static one with the hand and the time.
