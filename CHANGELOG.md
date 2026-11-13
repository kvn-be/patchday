# Changelog

All notable changes to Patchday are listed here. Versions follow [semantic versioning](https://semver.org). Every release so far is a preview.

## 1.0.0 - Unreleased

### Added

- **Packages** tab: every installed package from Homebrew, winget, Chocolatey and Scoop, with filter, a package manager filter and a view of only packages with updates.
- Select several packages to update or uninstall them together.
- **Find** tab: search all package managers at once and install one or several results.
- Skip a single version of a package, or ignore its updates until you allow them again.
- Export the package list as JSON and import it on another computer.
- **History** tab with the last 1000 installs, updates, removals and runs.
- Scoop on Windows, in the package tabs and in scheduled runs.
- Patchday updates itself automatically: it checks once a day, downloads in the background and installs when you close it. **Update Patchday automatically** in **Settings** turns this off.

### Changed

- New light design in layered glass. A sidebar leads to Overview, Updates, Packages, Schedule and History, and every page follows the same pattern. The colored ground moves slightly with the pointer, and stays still when the system asks for reduced motion.
- Installed packages and the search for new ones share one page and one search field.
- The dark theme is gone.
- Scheduled runs leave skipped versions alone.

### Security

- Installs and removals started from the package tabs never run through the admin task, which still only accepts its fixed jobs. Package names are checked before they reach any command.

## 0.2.3 - 2026-11-13

### Added

- Old backups are cleaned up after each run. Folders older than 30 days are removed, the 10 newest always stay.
- Checks for pull requests: tests and type checks run on every pull request and push to `main`.
- `SECURITY.md` with the way to report a vulnerability.
- `docs/testing.md` with a manual test checklist for real machines.
- Tests for the schedule mapping from the dial to launchd and Task Scheduler, the Portainer client, and winget output in English and German.

### Changed

- Release builds also check the TypeScript types.
- The landing page links its downloads to the GitHub releases and states that there is no account.

### Fixed

- winget updates are found even when winget draws its progress spinner in front of the table.

### Removed

- The unused Supabase configuration. Patchday has no account and no telemetry.

## 0.2.2 - 2026-11-06

### Added

- Chocolatey packages on Windows.
- **Show details** with the tool's own message when a package fails.

### Fixed

- More winget failures are repaired or explained, for example a running app or an installer that refuses administrator rights.

## 0.2.1 - 2026-11-06

### Added

- An **Update** button that stays in the header when a new Patchday version is available.

### Changed

- The window keeps a fixed 16:9 layout and scales with its size.

## 0.2.0 - 2026-11-06

### Added

- Patchday updates itself from GitHub releases.
- Progress bars for each update.
- Common failures are repaired automatically, and the report names the next step otherwise.
- On Windows, a one-time admin access creates a task that installs updates without asking again.

## 0.1.0 - 2026-11-06

First preview.

- Week dial to pick the update time, registered with launchd on macOS or Task Scheduler on Windows.
- **Check now** lists every update and changes nothing.
- Updates for Homebrew, winget and Docker Compose stacks, with Portainer support.
- Backup before, health check for up to 5 minutes after, and rollback on failure.
- Fixed rules in `src/core/policy.ts`. Risky updates wait for your decision.
- English and German interface, dark and light theme.
