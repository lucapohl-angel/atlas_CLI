# ATLAS.OS VS Code Extension

This package is the VS Code host for Atlas. It runs locally in the VS Code
extension host and embeds `@atlas/core`; it is not a hosted service and does not
require an Atlas backend server.

Current status: Phase 2.E-ready local package. The side-bar webview, typed
bridge, local session host, `Atlas: Run Turn` command, VS Code-native tools,
inline approval cards with modal fallback, transcript/composer, slash
autocomplete, live model/agent pickers, MCP manager, saved sessions, workflow
status, session todos, clickable file references, SecretStorage-backed provider
keys, safe settings controls, Codex browser sign-in, webview turn cancellation,
and VSIX packaging are present.

## Development

```bash
pnpm --filter atlas-os-vscode build
pnpm --filter atlas-os-vscode test:run
pnpm --filter atlas-os-vscode run package
```

The package produces `dist/extension.cjs` for the extension host and
`dist/webview/` for the side-bar webview. `pnpm --filter atlas-os-vscode run
package` also writes `dist/atlas-os-vscode.vsix`.

## Auth And Settings

The extension reads `~/.atlas/config.yaml`, layers explicit VS Code settings
under `atlas.*`, and stores new provider secrets in VS Code SecretStorage. Secret
values are not sent to the webview. Use the Settings screen key buttons for API
keys, or run `Atlas: Sign in to ChatGPT / Codex` for Codex OAuth.

## Manual Test

1. Run `pnpm --filter atlas-os-vscode build`.
2. In VS Code, open this repository.
3. Open the Command Palette and run `Developer: Install Extension from Location...`.
4. Choose `packages/vscode`.
5. Reload VS Code when prompted.
6. Open Atlas from the secondary sidebar on the right, then send a prompt.

For a live prompt, Atlas still needs the normal local setup: run `atlas init`
once and configure a provider key in `~/.atlas/config.yaml` or environment
variables. Without that, the extension should show a clear local setup error.
