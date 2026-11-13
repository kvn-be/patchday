# Security

## Supported versions

Only the latest release gets fixes. Patchday is a preview, so please update before you report.

## Report a vulnerability

Do not open a public issue. Report it privately instead:

1. Open the [Security tab](https://github.com/kvn-be/patchday/security) of this repository.
2. Select **Report a vulnerability** and describe what you found, how to reproduce it, and which version and operating system you use.

You get an answer within 7 days. Once a fix is released, the report is published as a security advisory.

## Scope

Patchday runs package managers and Docker with the rights of the logged-in user, and on Windows with a scheduled admin task. Reports about these areas are especially welcome:

- Commands that Patchday runs with input from registries, package lists or Compose files.
- The Windows admin task and the macOS launchd job.
- Storage of the Portainer token and of backups in the app data folder.
- The self-update from GitHub releases. Builds are not signed yet, which is a known limit.
