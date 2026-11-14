# Steps

The phases of one update as hubs joined by bars, shown in the update's row while it runs.

The consumer mounts it with `Patchday.mountSteps(root, { steps })` and calls `set(current, state, label)` on every progress event: `current` is the index of the running phase (-1 before it starts, `steps - 1` when finished), `state` is `running`, `done` or `failed`, and `label` names the item and phase for screen readers. Keep the same instance per item between renders, so its transitions play.

- Containers have four hubs: back up, update, test, done. Packages have three: install, repair, done.
- A reached hub pops to full size and draws its ring; the bar of the running phase fills slowly, since tools report no percent.
- Finished turns every part `ok`. A failure marks the hub where it happened in `back` and stops.
- Always pair it with the phase in a `Pill` and the reason below the row.
- With reduced motion hubs and bars change without animation.
