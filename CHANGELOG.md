# Changelog

All notable changes to Patchday are listed here. Versions follow [semantic versioning](https://semver.org). Every release so far is a preview.

## 1.5.0 - 2026-11-14

### Added

- **Update all** asks, after a check found waiting containers, whether they go along: **Update all, including waiting** installs every waiting container update Patchday can install itself (major updates, protected services, optional updates and others) next to the automatic ones, each stack backed up first and rolled back if it is not healthy within 5 minutes. **Automatic only** keeps the old behaviour. Scheduled runs are unchanged.
- **Update all** can be pressed when only waiting containers are left.

## 1.4.0 - 2026-11-14

### Added

- **Update now** next to every waiting or optional container update on **Updates**: Patchday installs that one update right away instead of you doing it in Portainer, after asking once with the reason it waited. The stack and its databases are backed up first, and the container is rolled back if it is not healthy within 5 minutes. Services that must be updated together, like Immich, go as one. Other updates and packages are left for the next run.
- Updates Patchday cannot install itself (Portainer not connected, stack deployed from Git, Compose file not found, no image for this machine, container not run by Compose or Portainer) show no button.

## 1.3.0 - 2026-11-14

### Changed

- Minor container updates no longer install by themselves, unless they fix a security issue. A security fix is found in the release notes (a CVE or GHSA id, or words like "security fix") or in the GitHub security advisories of the image's repository. Patch updates still install by themselves.
- Other minor container updates go to the new **Optional updates** section on **Updates**. **Approve** installs one at the next run; approving again takes it back. Optional updates do not count as waiting for you.
- **Install all minor updates automatically** in **Settings** is off by default. Settings files from older versions are switched off once; turn it on again to get the old behaviour. Homebrew, winget, Chocolatey and Scoop are unchanged.

## 1.2.2 - 2026-11-14

### Changed

- Databases, caches and DNS services take bug-fix releases by themselves, for example PostgreSQL 18.6 to 18.7 or Redis 7.4.11 to 7.4.12, with the usual backup, database dump, health check and rollback. Major and feature updates, Portainer and Immich still wait for you.

## 1.2.1 - 2026-11-14

### Fixed

- macOS: a saved admin password now reaches `sudo` during Homebrew runs. Homebrew starts itself with an empty environment, so the run's token now sits in the helper script, which exists only while the run lasts.
- Windows: an app installed for one user only is no longer stuck in the admin run. winget refuses it there, so Patchday updates it once more from your own session.
- Windows: a beta is never offered for a stable install, for example TeamSpeak 6 beta over TeamSpeak 5. It waits for you instead.
- Windows: Visual Studio Build Tools no longer runs a pointless fresh install. The reason says to open the Visual Studio Installer once and update there.

## 1.2.0 - 2026-11-14

### Added

- Every check and update run writes a run log to `logs/runs/`: each update grouped as failed, applied, waiting or planned, with the reason and the tool's output for failures. The newest 100 are kept. **Open run logs** on **History** opens the folder.
- Minor container updates read their release notes from GitHub, found through the image's source label or its `ghcr.io` name. When no release between the running and the new version mentions breaking changes, the update runs by itself. Images without a known repository still wait for you.
- **Admin password** in **Settings** (macOS, Linux): Patchday checks it with `sudo` and keeps it encrypted in the keychain. During an update run, Homebrew apps that install system files use it instead of failing with "needs your admin password". Outside a run Patchday never hands it out. **Forget** removes it.

### Changed

- **Updates** lists only what still needs something. Applied updates stay in **History** and the run logs.

## 1.1.2 - 2026-11-14

### Fixed

- An update's progress no longer starts over when the next package begins. Each bar keeps counting up from where it was, and the overall bar grows smoothly instead of jumping.

## 1.1.1 - 2026-11-14

### Changed

- Overview puts the whole schedule in one box: **Run on this schedule** on top, the day and time wheels, and the date of the next run below. The separate **Next run** card is gone, so the date shows only once. Outside 00:00 to 06:00, a one-line warning says apps can restart while you use them.

## 1.1.0 - 2026-11-14

### Added

- Day and time wheels on Overview replace the week dial: turn them with the mouse, by dragging or with the arrow keys.
- Dark design, and **Appearance** in **Settings**: system, light or dark.
- Each update shows its steps while it runs: back up, update, test and done for containers; install, repair and done for packages.
- **Export logs** on **History** saves every run as text, with the reason and the tool's output for each failed update. A log book in `logs/` keeps the details.
- Installs repair themselves in three steps: install, a targeted repair, then a fresh install with a cleared download. They stop early only where a fresh install cannot help.

### Changed

- The Schedule page is gone. Day and time are on Overview; the switches, **Never update**, appearance and Portainer are on a new **Settings** page.
- The design system is Liquid Glass too: a light and a dark theme, new tokens, and components for glass, buttons, pills, switches, segmented controls, the sidebar, list rows, progress, the wheel, the update steps and the parallax ground. The app takes its components from it instead of its own copies.

### Fixed

- `download did not match its checksum` when Patchday updated itself: releases now go public only once all files are uploaded, Patchday skips incomplete releases, checks the size, downloads up to three times and falls back to the disk image.

## 1.0.0 - 2026-11-13

### Added

- **Packages** page: every installed package from Homebrew, winget, Chocolatey and Scoop, and one search that also finds packages to install from all of them. Update, skip a version or uninstall right in the row.
- Skip a single version of a package. The next newer version shows up again.
- Export the package list as JSON and import it on another computer, then install everything from it at once.
- **History** page with the last 1000 installs, updates, removals and runs.
- Scoop on Windows, on the Packages page and in scheduled runs.
- Patchday updates itself automatically: it checks once a day, downloads in the background and installs when you close it. **Update Patchday automatically** on the **Schedule** page turns this off.

### Changed

- New light design in layered glass. A sidebar leads to Overview, Updates, Packages, Schedule and History, and every page follows the same pattern. The colored ground moves slightly with the pointer, and stays still when the system asks for reduced motion.
- Installed packages and the search for new ones share one page and one search field.
- The dark theme is gone.
- Scheduled runs leave skipped versions alone.

### Removed

- The landing page draft in `design/landing.html`.

### Security

- Installs and removals started from the Packages page never run through the admin task, which still only accepts its fixed jobs. Package names are checked before they reach any command.

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
