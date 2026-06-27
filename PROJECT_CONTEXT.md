# Penut Operator Project Context

## Product Goal

Penut Operator is a desktop companion app for Penut. Penut can create tasks that require browser-only/manual user actions, such as sending a LinkedIn DM, commenting on Instagram, or sending a Telegram message. Some of these actions are not available or not allowed through official APIs, so this app exists to run those approved actions in a browser session.

The intended user flow is simple:

1. A task appears in the app.
2. The user can edit the natural-language task.
3. The user clicks Approve.
4. The task starts executing immediately.
5. The app shows friendly activity history while it runs.

There is no second approval gate after clicking Approve. The approval click means "do this task."

## Penut Context

Penut is the primary product. This app is a companion execution surface for tasks Penut cannot complete through APIs. The future integration should let a Penut user/agent create a browser task, have it appear in Operator, and let the account owner approve it locally.

Penut already has its own approval concepts, so this app should avoid duplicating a complicated approval workflow. Operator should remain focused on:

- showing/editing the task
- approving/running it
- executing through the browser
- recording a readable run history

## Current Architecture

The app is Electron-based.

- `src/main/main.js`: Electron main process, IPC handlers, browser-use worker launch
- `src/main/preload.cjs`: renderer-safe IPC API
- `src/renderer/*`: user-facing approval/task/activity UI
- `src/storage/task-store.js`: local active task storage
- `python/browser_use_worker.py`: Python browser-use execution worker
- `python/requirements.txt`: Python dependencies

The original custom browser-control loop still exists under `src/agent` and `src/browser`, but current execution has moved toward `browser-use` because hardening a custom browser agent for every site did not scale.

## Browser Execution Direction

Current execution path:

1. Renderer sends the current textarea prompt to `window.penutOperator.runAgent(prompt)`.
2. Main process saves that prompt and marks the task running.
3. Main process launches `python/browser_use_worker.py`.
4. The worker uses `browser-use` and OpenAI to execute the task.
5. Worker output streams back into the Activity panel.

The worker uses the local project virtualenv when available:

```bash
.venv/bin/python
```

It also expects the browser-use terminal binary:

```bash
~/.local/bin/browser-use-terminal
```

## Browser Profile Decision

For now, the app uses a persistent Chrome profile directory so users can stay logged in across runs. The current dev setup points at the local Chrome profile:

```text
~/Library/Application Support/Google/Chrome
profile_directory: Default
```

We briefly explored attaching to an already-open Chrome instance via CDP/remote debugging, but removed it because it is not a clean production path for this app. The production-friendly direction is a first-time setup flow where the user selects which Chrome profile Operator should use.

## API Keys

The worker reuses:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`

These are read from `.env` / process environment. No separate Browser Use Cloud key is required for the current local worker path.

Important: `.env` may contain a live OpenAI key. Do not commit or share it.

## UX Principles

The UI should stay non-technical. Activity logs are user-facing and should not show:

- raw JSON
- stack traces
- Rust SDK messages
- browser-use internals
- Python tracebacks
- low-level file errors unless translated into plain language

Preferred activity messages are short and plain:

- Starting task.
- Browser ready.
- Opened the page.
- Task finished.
- Task could not finish.

## Recent Fixes / Known Issues

Recent fixes:

- Approve now saves the textarea prompt and starts execution.
- Save button was removed.
- Prompt reset race was addressed by passing the prompt directly to the run IPC handler.
- Task writes were changed to use unique temp files and a write queue.
- Main process now launches `.venv/bin/python` when available, so `browser_use` is importable.
- Activity logs stream live from the worker.

Known issue as of this note:

- The machine is nearly out of disk space. `df -h` showed only about `130MiB` free.
- `browser-use` itself is not the main disk consumer. Larger local consumers observed were Chrome caches, Codex runtime caches, and general macOS caches.
- If disk space is too low, even tiny writes like `data/active-task.json.*.tmp` can fail.

## Safe Cleanup Targets

These are cache/temp targets that can be cleaned when disk is critically low:

```bash
rm -rf ~/Library/Caches/Google/Chrome
rm -rf ~/.cache/codex-runtimes
rm -rf ~/Library/Caches/electron
rm -rf ~/Library/Caches/node-gyp
rm -rf ~/Library/Caches/Homebrew
rm -rf ~/Library/Caches/pip
rm -f data/active-task.json.*.tmp
```

Do not delete source files, `.env`, or `data/active-task.json` unless intentionally resetting local state.

## Next Good Steps

1. Free disk space before further testing.
2. Re-run `npm run dev`.
3. Test a simple Telegram or navigation task.
4. Confirm the prompt no longer resets to the sample task.
5. Confirm Activity logs remain plain and useful.
6. Later, design a production setup flow for choosing the user Chrome profile.
