# Batch 1: Local Prototype

## Goal

Prove the local loop before touching the main Penut codebase:

1. A local operator shell shows a delegated LinkedIn DM task.
2. The account owner can edit, approve, reject, or run it.
3. A Chrome extension can receive the approved task.
4. The extension opens LinkedIn in the user's existing logged-in browser session.
5. The extension prepares the DM and pauses before final send.

## Scope

Included:

- Local desktop-style operator shell.
- Mock LinkedIn DM task.
- Chrome Manifest V3 extension.
- Local HTTP bridge between shell and extension.
- Safe LinkedIn DM draft automation.

Not included yet:

- Real Penut auth.
- Real Penut server APIs.
- Tauri packaging.
- Database persistence.
- Automatic final send.
- LinkedIn/X production hardening.

## Run

From this folder:

```bash
npm run desktop
```

Then open:

```text
http://127.0.0.1:4877
```

Load the extension in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select `/Users/samuel/penut-operator/extension`.

## Safety

The prototype should not click the final LinkedIn Send button. It prepares the draft and asks the user to review/send manually.
