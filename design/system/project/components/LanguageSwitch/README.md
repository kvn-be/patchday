# LanguageSwitch

A two-part control that switches between English and German.

The consumer provides the two buttons, keeps `aria-pressed` in step with the language and saves the choice.

- English is the default. These are the only two languages.
- Keep the labels `EN` and `DE` in both languages.
- Update `lang` on the root element, all visible text and all `aria-label` values at once, without a reload.
