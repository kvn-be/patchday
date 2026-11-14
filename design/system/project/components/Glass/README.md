# Glass

The surface for everything that holds content: the sidebar, panels, cards and dialogs.

The consumer provides the `pd-glass` class and a radius from its place: `radius-panel` for panels and cards, `radius-hero` for the Overview status and the schedule panels, 26px for the sidebar.

- Glass needs something behind it. Put it over `Ground`, never over a flat colour.
- Text on glass uses `ink`, `ink-2` or `ink-3`. All three pass 4.5:1 on the lightest glass.
- Never stack glass on glass more than once. A row inside a panel brightens on hover instead.
- Dialogs are stronger glass: 86% white, `shadow-dialog`, and a light blurred backdrop.
