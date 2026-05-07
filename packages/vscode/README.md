# ATLAS.OS VS Code Extension

This package is the VS Code host for Atlas. It runs locally in the VS Code
extension host and embeds `@atlas/core`; it is not a hosted service and does not
require an Atlas backend server.

Current status: Phase 2.B smoke path. The side-bar webview, typed bridge, local
session host, and `Atlas: Run Turn` command are present. VS Code-native tools
are still pending.

## Development

```bash
pnpm --filter atlas-os-vscode build
pnpm --filter atlas-os-vscode test:run
```

The package produces `dist/extension.cjs` for the extension host and
`dist/webview/` for the side-bar webview.

## Manual Test

1. Run `pnpm --filter atlas-os-vscode build`.
2. In VS Code, open this repository.
3. Open the Command Palette and run `Developer: Install Extension from Location...`.
4. Choose `packages/vscode`.
5. Reload VS Code when prompted.
6. Open Atlas from the secondary sidebar on the right, then press `Ping` or send a prompt.

For a live prompt, Atlas still needs the normal local setup: run `atlas init`
once and configure a provider key in `~/.atlas/config.yaml` or environment
variables. Without that, the extension should show a clear local setup error.
