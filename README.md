# Switchboard (VS Code Extension)

Switchboard is a lightweight VS Code extension that helps you switch between agent sessions/threads without reloading the window.

## What it does

- Session/thread switcher in a dedicated activity bar view
- Per-session repo tree in a custom explorer view
- Thread context panel in a webview
- Terminal handoff/focus command per active session

## Development

```bash
npm install
npm run compile
```

Run in VS Code:

1. Open this folder in VS Code
2. Press `F5` to launch an Extension Development Host
3. Open the **Switchboard** activity icon

## Install locally as VSIX

```bash
npm run package
```

This creates a `.vsix` file in the project root.

Install it:

```bash
code --install-extension switchboard-1.0.0.vsix
```

You can uninstall later with:

```bash
code --uninstall-extension mohit-local.switchboard
```

## Publish to VS Code Marketplace

Before publishing, update these fields in `package.json`:

- `publisher`
- `repository.url`
- `homepage`
- `bugs.url`

Then:

1. Create a publisher in VS Code Marketplace (Azure DevOps)
2. Create a Personal Access Token (PAT) with marketplace publish permissions
3. Login once:

```bash
npx vsce login <publisher-name>
```

4. Publish:

```bash
npm run publish:marketplace
```

## Recommended next improvements

- Add unread/activity counters in session list
- Persist repo tree expansion state per session
- Wire terminal handoff to your real agent CLI switch command
