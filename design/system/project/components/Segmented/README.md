# Segmented

Two or three choices in one pill: the language, or a list filter such as "All" and "With updates".

The consumer provides `pd-segmented` (add `pd-segmented-small` in the sidebar), the buttons, and keeps `aria-pressed` on the chosen one.

- The chosen part is solid white with `ink` text; the others are `ink-2`.
- Language: `EN` and `DE` only, the same labels in both languages. Switching updates every text and `lang` at once, without a reload.
- Filters show their count in the label: "With updates 3".
