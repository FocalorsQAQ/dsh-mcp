# v0.1.0 Windows release validation

Platform: Windows x64. Production CLI/SDK: `0.2.2-alpha.2`. Bundled Node.js:
`24.22.1`; bundled Python: `3.13.9`. No real model credentials or paid API calls
were used in these checks.

- TypeScript server/UI checks and production builds passed.
- All 126 unit tests passed with the local networking and directory-link
  permissions needed by integration cases.
- Source publication audit passed; credentials, local chats, run state,
  dependency caches and private test artifacts are excluded from Git.
- Actual Inno Setup installer installed into a new directory containing spaces,
  using the same release archives and embedded SHA-256 values as the online path.
- Bundled Node/Python ran successfully; CLI and SDK versions matched and the CLI
  resolved entirely within the installation.
- Repeated initialization preserved the user's configuration.
- Packaged Electron UI launched and switched to English.
- The full local MCP smoke suite ran using the **installed** Node, Python,
  server, SDK and CLI, including context, file edits, nested delegation,
  concurrency, queueing, pause/resume, interrupted sessions and delivery retry.
- The test installation uninstalled successfully and retained its separate
  user-data directory.

Packaging uses short dependency paths for Windows compatibility and preserves
pnpm's hoisted aliases needed by shared native module loaders. These two cases
were found and corrected during installation testing.

Reproduce locally with `node scripts/test-release.mjs` after building release
artifacts. After publishing, add `--online` to exercise the public GitHub URLs.
All fixture data stays under `.test-output/`; the test does not touch real API
credentials or the development server's state.
