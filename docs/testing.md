# Manual test checklist

Run this list before a release is marked as stable, on at least one Mac and one Windows PC. Note the Patchday version, the date and the result of each step. If a step fails, keep the report file and the log, and open an issue with both.

Target machines:

- **Mac:** Apple silicon, Homebrew, OrbStack, Portainer with at least one stack.
- **Windows:** Windows 11, winget, optional Chocolatey and Docker Desktop.

## 1. Install and first start

- [ ] Download the build for the machine from the [Releases page](https://github.com/kvn-be/patchday/releases).
- [ ] macOS: open the `.dmg`, drag Patchday to **Applications**, then allow it in **System Settings > Privacy & Security > Open Anyway**.
- [ ] Windows: run `Patchday-Setup-<version>.exe`, select **More info**, then **Run anyway**.
- [ ] The app starts dark and in English.
- [ ] Windows: the **Allow admin access once** prompt appears. Select **Allow once** and confirm the Windows prompt. **Settings** now shows `Admin access is set up. Updates run without prompts.`
- [ ] The language switch and the theme switch change every visible text and color.

## 2. Check now

- [ ] Select **Check now**. The button shows `Checking…`, then a report.
- [ ] Nothing was installed: compare `brew outdated`, `winget upgrade` and `docker ps` before and after.
- [ ] Every outdated package and container appears. Compare with `npm run scan` from a source checkout if in doubt.
- [ ] Badges match the [rules](../README.md#the-rules): patch updates are **Planned**, majors, databases and Portainer itself are **Waiting for you** with a reason below.
- [ ] Windows: if Windows is set to German, winget prints German columns. The list must still be complete.
- [ ] Without a Portainer token, Portainer stacks only get suggestions. Save the token in **Settings** and check again: those stacks are now planned where the rules allow it.

## 3. Report

- [ ] The report file exists in the app data folder under `reports/`.
  - macOS: `~/Library/Application Support/Patchday/reports/`
  - Windows: `%APPDATA%\Patchday\reports\`
- [ ] Versions are shown as `3.4.0 → 3.4.1`, times in 24-hour format.
- [ ] Every **Failed** or **Waiting for you** line names what happened and the next step. **Show details** shows the tool's own message.

## 4. Schedule

- [ ] Drag the hand to the next full hour that is at least 10 minutes away. **Next run** shows that day and time.
- [ ] Turn on **Run on this schedule**. Leave **Install updates on schedule** off.
- [ ] macOS: `launchctl print gui/$(id -u)/io.github.kvn-be.patchday` shows the job with the chosen weekday and hour.
- [ ] Windows: `schtasks /Query /TN Patchday /V /FO LIST` shows a weekly task on the chosen day and time.
- [ ] Keep the computer awake and logged in. At the chosen time, a run starts without opening a window and shows a notification.
- [ ] The new report is a preview: items are **Planned**, nothing was installed.
- [ ] Turn **Run on this schedule** off. The launchd job or the scheduled task is gone.

## 5. Update run with a rollback

This step uses a small test stack that is made to fail its health check after the update. It touches no real stack.

1. Create a folder `patchday-test` with this `compose.yaml`:

   ```yaml
   services:
     web:
       image: nginx:1.27.0-alpine
       healthcheck:
         # Healthy only on 1.27.0, so every newer version fails and must be rolled back.
         test: ["CMD-SHELL", "nginx -v 2>&1 | grep -q 'nginx/1.27.0'"]
         interval: 10s
         retries: 3
   ```

2. Run `docker compose up -d` in that folder and wait until `docker ps` shows `(healthy)`.

- [ ] Select **Check now**. `patchday-test` shows as **Planned** with a patch update `1.27.0-alpine → 1.27.<n>-alpine`.
- [ ] Select **Update now** and confirm. The progress bar runs through `Backing up`, `Installing`, `Testing` and `Rolling back`.
- [ ] After at most about 5 minutes, the stack is **Rolled back**.
- [ ] `compose.yaml` again says `nginx:1.27.0-alpine`, its comments and layout are unchanged, and the container is healthy.
- [ ] A backup folder for the stack exists under `backups/` and contains the original stack file.
- [ ] Other updates in the same run were installed and show **Applied**, or name their reason.
- [ ] Remove the test stack with `docker compose down` and delete the folder.

Optional, Mac only: repeat with the stack deployed through Portainer instead of Compose. The rollback must go through Portainer, and Portainer must show the old file afterwards.

## 6. Backups and self-update

- [ ] After a run, backup folders older than 30 days are removed, the 10 newest stay, and folders you created by hand are untouched.
- [ ] With an older version installed, **Update Patchday** appears and installs the latest release. The app restarts on the new version.
- [ ] Automatic update: install the previous release, start it, and wait a minute. The note `Patchday <version> is downloaded` appears. Close Patchday: the next start shows the new version, and **History** lists `Patchday updated`.
- [ ] Turn off **Update Patchday automatically** on the **Schedule** page, set `lastSelfCheck` in `settings.json` to an old date, and restart. Nothing is downloaded.

## 7. Navigation, packages and history

Use a small, harmless package for every step, for example `jq` with Homebrew, `jqlang.jq` with winget, `jq` with Chocolatey and `jq` with Scoop.

- [ ] The sidebar opens Overview, Updates, Packages, Schedule and History. The updates count next to **Updates** matches the Overview.
- [ ] Move the pointer: the colored ground drifts slightly, the glass stays still. With **Reduce motion** turned on in the system, the ground does not move.
- [ ] **Packages** lists every installed package of each package manager on the machine. The counts match `brew list`, `winget list`, `choco list` and `scoop list`.
- [ ] Type `jq` in the search. Installed matches show first, packages you can add appear below after a moment.
- [ ] Install `jq` from the search and confirm. Windows: Chocolatey shows an admin prompt. Cancel it once: the status says `the admin prompt was cancelled`.
- [ ] The package now appears under **Installed**, and **History** has an entry with the right package manager.
- [ ] **With updates** shows only packages with an update. **Update** installs one, **Skip** hides that version, and **Check now** does not plan it.
- [ ] Add a package to **Never update** on the **Schedule** page. Its row shows `Updates ignored`. Remove it again.
- [ ] **Export list**, then uninstall `jq` and **Import list** with that file. `jq` shows under **From your list** and can be installed from there.
- [ ] Uninstall `jq` with confirmation. It disappears from **Installed**, and **History** lists the removal.
- [ ] A search for `-h` or `a$(x)` is refused with a message, and nothing runs.
