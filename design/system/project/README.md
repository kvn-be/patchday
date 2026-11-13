Patchday keeps a computer up to date on a schedule. The design says one thing: this runs quietly in the background, and finding your way takes no effort. Think of a watchmaker's dial seen through clear glass.

## Content fundamentals

- Default language is English. German is the only other language, switched with `Segmented` in the sidebar. Every string exists in both.
- Write to one person: "you" in English, "du" in German.
- Use sentence case. Never use all caps labels, emoji or exclamation marks.
- Name what people recognize: "Waits for you", not "Pending approval".
- A control says what happens: "Check now", "Update all", "Install".
- Every page says in one sentence what it is for: "One search for what you have and what you can add."
- Errors name what failed and the next step. They never apologize.
- Count with the right number: "1 update waits for you", "7 updates are ready".

Real copy:

> 6 install by themselves at the next run, with a backup first. 1 waits for your decision.

> Alles, worum sich Patchday kümmert, an einem Ort.

Use 24-hour time in both languages. Write versions as `3.4.0 → 3.4.1`. Keep product terms as they are: Homebrew, winget, Chocolatey, Scoop, Docker, Portainer.

## Navigation

- One `Sidebar` with five places in a fixed order: Overview, Updates, Packages, Schedule, History. Settings, language and coffee sit at its foot.
- Every page has the same head: title in `display`, one sentence in `ink-2`, the main action on the right. At most one `pd-btn-main` in a page head.
- Every list uses `ListRow`: icon, name with source, version, status or actions. Group rows under a `pd-list-head` with a count, what needs you first.
- Actions sit in the row as buttons. No hidden menus, no right-click.
- Settings that are switches save by themselves. Only Portainer and the Windows admin access live in the Settings dialog.

## Color and material

- One theme: Liquid Glass. There is no dark theme.
- The page is `ground` with the four blurred shapes of `Ground`. Content always sits on `Glass`: `glass` fill, 30px blur, `glass-edge`, `shadow-glass`.
- Text is `ink`, secondary text `ink-2`, small notes `ink-3`. All pass 4.5:1 on the lightest glass.
- Actions are solid: `ink` with `on-ink` for main, `glass-strong` with `control-edge` for secondary. Never a glass button.
- `brass` is the only ornament: the logo, the dial hand and the focus ring. `coffee` fills the coffee button and nothing else.
- `ok`, `wait` and `back` mean status only, always with a word. A good-time hint uses `ok`, a daytime warning `back`.

## Type

- Set the name, page titles, the status sentence and the dial time in `display` (Bodoni Moda). Do not set `display` below 20px.
- Set everything else in `text`: the system face (SF Pro on macOS, Segoe UI on Windows), Instrument Sans as the fallback.
- Use `code` for commands and tool output only.
- Use `font-variant-numeric: tabular-nums` where versions or times line up.

## Layout

- The app window keeps 16:9, from 960 x 540 to 1920 x 1080. Lay it out once for 1280 x 720; the page zooms with the window.
- Sidebar 248px, 28px gap, content to the right. Only panels scroll, never the page.
- Radii by place: `radius-full` for controls, `radius-control` for sidebar items, `radius-field` for fields and row icons, `radius-panel` for panels and cards, `radius-hero` for the Overview status and the schedule panels.

## Motion

- The ground drifts against the pointer at four depths, up to 36px, 1.1 seconds ease-out. Nothing sits on the pointer itself, and glass never moves.
- Buttons lift 1px on hover and give to 0.97 on press. Switches slide in 0.2 seconds.
- The dial hand sweeps to the chosen time on load.
- Respect `prefers-reduced-motion`: the ground stays still, buttons do not move, and the end state shows at once.

## Focus

A solid 3px `brass` ring, 3px offset, on every control. The search field shows it around the whole field.

## Iconography

- Draw icons inline on a 24px grid, 1.8px stroke, round caps and joins, `currentColor`. There is no icon library.
- Existing icons: home, arrow up in a circle, box, clock, history arrow, gear, search, in `Sidebar` and the package search.
- Row icons are the first letter of the name on a white tile, dashed for things that are not installed.
- Use the `Logos` asset for the mark, or draw it inline with `var(--brass)` as `Sidebar` does.

## Support

The coffee button sits at the foot of the sidebar, always in view. It links to `https://ko-fi.com/kvnbe` and never interrupts anything.
