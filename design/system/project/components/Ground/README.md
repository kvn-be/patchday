# Ground

The ground behind all glass: four blurred shapes in `shape-periwinkle`, `shape-sky`, `shape-sand` and `shape-rose` on `ground`. In the dark theme the same shapes glow deep and quiet.

The consumer provides one `pd-ground` as the first child of the page with four `pd-blob pd-blob-1` … `pd-blob-4` inside, marked `aria-hidden="true"`, and calls `Patchday.startParallax()` once.

- Parallax: each shape sits at its own depth (0.5 to 1.4) and drifts up to 36px against the pointer, with a 1.1 second ease-out, so the ground lags like liquid. It returns to rest when the pointer leaves.
- Nothing follows the pointer directly, and the glass above never moves.
- With reduced motion the ground stays still; `startParallax` does nothing then.
- Content never sits on the ground alone. Put it on `Glass`.
