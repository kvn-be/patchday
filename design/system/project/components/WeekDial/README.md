# WeekDial

The signature of Patchday: a dial with one tick for each of the 168 hours of the week, used to pick when updates run.

The consumer provides an SVG, a range input and the chosen hour of the week (0 is Monday 00:00, 147 is Sunday 03:00, the default), and saves changes. Mount it with `Patchday.mountWeekDial(svg, input, { hour, days, short })`; pass `days` and `short` for German.

- Always pair the dial with a range input. It gives keyboard and screen reader access.
- The arcs mark the quiet hours, 00:00 to 06:00. Outside them, show a note that updates can restart running apps.
- Show the day and time in the centre, and repeat them in a sentence near the dial.
- Use the dial once per screen. It is the one element allowed to be large and bold.
- The load sweep is the only ambient motion in the system.
