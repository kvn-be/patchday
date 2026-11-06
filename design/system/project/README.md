Patchday keeps a computer up to date on a schedule. The design says one thing: this runs quietly at night, and it is built with care. Think of a watchmaker's dial in the blue hour.

## Content fundamentals

- Default language is English. German is the only other language, switched with `LanguageSwitch`. Every string exists in both.
- Write to one person: "you" in English, "du" in German.
- Use sentence case. Never use all caps labels, emoji or exclamation marks.
- Name what people recognize: "Waiting for you", not "Pending approval".
- A control says what happens, and the result repeats the word: "Copy", then "Copied".
- Say plainly when something does not exist yet: "Not available yet."
- Errors name what failed and the next step. They never apologize.

Real copy:

> Your updates run every Sunday at 03:00, with a backup first, a health check after, and a rollback if anything fails.

> Deine Updates laufen jeden Sonntag um 03:00.

Use 24-hour time in both languages. Write versions as `3.4.0 → 3.4.1`. Keep product terms as they are: Homebrew, winget, Docker, Portainer.

## Color

- Dark is the default. Use `dark` unless the person chose `light`. Do not follow the system setting on first launch.
- Set pages on `night`. Raise windows with `night-raised`. Sink bars and fields with `night-sunk`.
- Set text in `moon`, secondary text in `haze`.
- `brass` is the only ornament. Keep it to the logo, the dial hand, the focus ring and the coffee button. Never tint a surface with it.
- `ok`, `wait` and `back` mean status only. Always pair them with a word.
- Use `line` for separators and `control-line` for anything people can operate.

## Type

- Set the name and headings in `display` (Bodoni Moda). Set everything else in `text` (Instrument Sans).
- Use `code` for commands only, never for labels or data.
- Use `wordmark` once per page.
- Load both faces from Google Fonts:

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:opsz,wght@6..96,400..600&family=Instrument+Sans:wght@400..600&display=swap">
```

- Bodoni hairlines get thin at small sizes. Do not set `display` below 20px.
- Use `font-variant-numeric: tabular-nums` where versions or times line up.

## Scale and layout

- Size type with `step-0` to `step-3` and sections with `space-section`. Fixed pixel sizes in the type styles are the upper limits.
- Keep content in a 1240px column with a 16px gutter, 40px (`space-5`) from 720px up.
- Align left. Only the week dial is centred.
- Stack columns to one below 960px. The app window must work from 400px wide.

## Shape and depth

- `radius-full` for controls, `radius-window` for windows, `radius-field` for fields. Do not use one radius for everything.
- Most content sits directly on `night` with a `line` above it. Only real windows get a border, fill and `shadow-window`.

## Motion

- One moment only: the dial hand sweeps through the week to the chosen time on load, 1.5 seconds, easing out.
- Everything else answers an action. Respect `prefers-reduced-motion` and show the end state.

## Focus

A solid 2px `brass` ring, 3px offset, on every control. It holds at least 3:1 on all surfaces in both themes.

## Iconography

- Draw icons inline on a 24px grid, 1.7 to 1.8px stroke, round caps, `currentColor`. There is no icon library.
- Existing icons: coffee cup and moon, in `Button`.
- Use the `Logos` asset for the mark. It is never redrawn in another color.

## Support

The coffee button is always in view: in the header and in the closing band. It links to `https://ko-fi.com/kvnbe` and never interrupts anything.
