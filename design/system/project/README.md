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

- One `Sidebar` with four places in a fixed order: Overview, Updates, Packages, History. Settings, language and coffee sit at its foot.
- Day and time of the weekly run are two `Wheel`s on Overview. There is no separate schedule page.
- Every page has the same head: title in `display`, one sentence in `ink-2`, the main action on the right. At most one `pd-btn-main` in a page head.
- Every list uses `ListRow`: icon, name with source, version, status or actions. Group rows under a `pd-list-head` with a count, what needs you first.
- Actions sit in the row as buttons. No hidden menus, no right-click.
- Settings save by themselves. The Settings page holds the run switches, the Never update list, the appearance, Portainer and the Windows admin access.

## Color and material

- Two themes, light and dark Liquid Glass, chosen in Settings: system, light or dark. Every colour is a token with both values; components never hard-code a surface colour.
- The page is `ground` with the four blurred shapes of `Ground`.
- Two layers, kept apart. **Content** (status panel, cards, lists, settings) sits on `Surface`: `surface` fill, 12px blur, `surface-edge`, `shadow-surface`, no rim. **The function layer** (sidebar, page toolbars, the schedule wheels, search, dialogs) is `Glass`, Liquid Glass after Apple: gradient `glass-top` to `glass`, 22px blur with 190% saturation, 0.5px `glass-edge`, `shadow-glass` (rim light `rim` top left, counter edge and lens glow `rim-soft`, floating shadow).
- Never glass on glass: a glass control may sit on a surface, not on other glass.
- Page actions are grouped in one `Toolbar` capsule at the top right. Text buttons only; icons would get a capsule of their own.
- Scrolling lists fade at their edges (`pd-scroll-edge`) so the controls above stay legible.
- Text is `ink`, secondary text `ink-2`, small notes `ink-3`. All pass 4.5:1 on the lightest glass.
- Buttons are glass. The one main action per place is prominent glass, tinted with `tint` and `on-tint` text; every other action is clear glass with a rim. In the dark theme `tint` turns light, so the main button becomes a light pill. The chosen sidebar item and segment are glass lenses.
- Accessibility: with `prefers-reduced-transparency` glass turns solid and edges stop fading; with `prefers-contrast: more` every glass and surface gets an `ink-3` edge.
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
- Radii by place, concentric: `radius-full` for controls, toolbars and search, `radius-control` for sidebar items (sidebar 26px minus its 12px padding), `radius-field` for fields and row icons, `radius-panel` for panels and cards, `radius-hero` for the Overview status and the schedule panels, `radius-sheet` for dialogs.

## Motion

- The ground drifts against the pointer at four depths, up to 36px, 1.1 seconds ease-out. Nothing sits on the pointer itself, and glass never moves.
- Buttons lift 1px on hover and give to 0.97 on press. Switches slide with a soft spring; while pressed the knob widens into a glass lens.
- Wheels glide to a row and snap; neighbours tilt away and fade.
- `Steps` pop each reached hub and draw its ring; the running phase fills its bar slowly.
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
