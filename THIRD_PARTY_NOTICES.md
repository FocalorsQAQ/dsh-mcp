# Third-party components

The dsh-mcp source is licensed under MIT, copyright 2026 FocalorsQAQ.
Third-party components keep their own licenses; this project's MIT license does
not replace them. This is an independent community integration, not an official
DeepSeek or OpenAI product.

The core is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
copyright 2026 DeepSeek, MIT. CLI, SDK client and LLM packages are pinned to
`0.2.2-alpha.2`. The Windows CLI core archive redistributes the official npm
packages with their installed dependencies; it is not an upstream-built binary.
The upstream GitHub release is
[dsh-v0.2.2-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.2).
The separate checkout recorded in `upstream.lock.json` is a source reference,
not the provenance of the published npm packages.

Release archives preserve package license/notice files and include an inventory
in `THIRD_PARTY_PACKAGES.json`. DeepSeek's MIT notice is included in
`licenses/deepseek-harness-MIT.txt`. Windows application archives also contain
Node.js and Python, with their original license files. Electron includes its
license and Chromium's third-party notices in its runtime directory. Other
components include the MCP TypeScript SDK, React and Zod under their respective
licenses, recorded in the inventory and their package directories.

Build tooling is not part of the application unless explicitly included. The
Windows online installer is generated with Inno Setup; Inno Setup's license is
available at https://github.com/jrsoftware/issrc/blob/main/LICENSE.TXT.
