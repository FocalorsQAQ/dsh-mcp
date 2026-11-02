# Windows release build

Run on Windows x64 with Node.js 24.9+, pnpm 11 and Python 3.13+ for the packaging
script (application runtime minimum remains Python 3.10). Use a clean checkout
and the committed lockfile. No API key or live model call is required.

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm ui:build
pnpm test
pnpm release:audit
pnpm release:fetch
```

`packaging/release.json` pins runtime versions and download hashes. Fetching
build inputs uses the official Node.js/Python sites and Inno Setup's GitHub
release. Install the verified Inno Setup compiler into `.release-cache/InnoSetup`
or set `ISCC_PATH` to an existing `ISCC.exe`.

```powershell
pnpm release:stage
python scripts/release/archive.py
node scripts/release/build-installer.mjs
```

Staging walks the installed production dependency graph, preserving separate
versions and license files. Runtime directory links are recorded in a manifest
instead of archived as machine-specific junctions. The initializer validates and
restores these links at the user's installation path. Bundled Node.js and Python
are separate from the host system. `core-manifest.json` records upstream source
and version; `THIRD_PARTY_PACKAGES.json` records every shipped npm package.

Before publication, run `node scripts/test-release.mjs`. It compiles the same
installer source with an isolated Windows application ID and Start menu group,
then installs the release payloads into temporary directories with separate
workspace, data and Codex settings. Changing `/DIR` alone does not isolate
Windows uninstall registration. The test runs an MCP task against a local mock
provider, the packaged Electron windows, and installation/uninstallation checks.
No credentials, model configuration, chats, test artifacts or local `.env` files
belong in either archive or source control.

Test the current upgrade path using `node scripts/test-release.mjs --upgrade-from 0.1.9`.
The isolated installer disables Windows startup registration with `/UISTARTUP=0`;
the companion itself is tested separately with temporary configuration and processes.
The packaged service-close test uses mock workers and delivery callbacks, never real chats.

For historical recovery coverage, use `node scripts/test-release.mjs --upgrade-from 0.1.1
--through-failed-012` (on one command line). Keep the original baseline release
archives in `release-output` and their source tags locally. This reproduces v0.1.2's old-link
conflict, then verifies recovery by the new installer, preservation of user
configuration/data, runtime tasks, the floating UI and uninstall.

Publish the two ZIPs, installer, `SHA256SUMS.txt` and `release-manifest.json` in
the matching GitHub release. The installer embeds the exact release URLs and ZIP
hashes; it never uses a moving `latest` URL. Verify public downloads after
publication. Source archives are provided by GitHub from the release tag. The
initial release is unsigned and marked as a prerelease.
