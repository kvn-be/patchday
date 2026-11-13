# Changelog

All notable changes to Patchday are listed here. Versions follow [semantic versioning](https://semver.org). Every release so far is a preview.

## Unreleased

### Added

- Old backups are cleaned up after each run. Folders older than 30 days are removed, the 10 newest always stay.
- Checks for pull requests: tests and type checks run on every pull request and push to `main`.
- `SECURITY.md` with the way to report a vulnerability.
- `docs/testing.md` with a manual test checklist for real machines.

### Changed

- Release builds also check the TypeScript types.
- The landing page links its downloads to the GitHub releases and states that there is no account.

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
