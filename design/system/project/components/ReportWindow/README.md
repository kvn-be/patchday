# ReportWindow

The result of one update run: when it ran, a tally and one row per update.

The consumer provides the date, the three totals and the rows with name, versions and status.

- Put the tally first, so the outcome reads at a glance.
- Sort rows with what needs attention last, in this order: applied, rolled back, waiting.
- Mark anything that is not real data with a `pd-badge-plain` that reads "Sample data".
- This is the one surface with a border, fill and `shadow-window`.
