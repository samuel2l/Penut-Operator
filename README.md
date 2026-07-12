# Browser Operator

Local desktop app for AI browser automation.

Create a task in plain language, run it against your Chrome profile, and watch the activity log while the agent works.

## Quick start

1. Install dependencies:

```bash
npm install
pip install -r python/requirements.txt
```

2. Add your OpenAI key:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4.1-mini
```

3. Start the app:

```bash
npm run dev
```

4. In Settings, choose the Chrome profile Operator should use.

5. Create a task, describe what should happen, then click **Run this task**.

Activity updates appear in the task detail view while the run is in progress.

## How it works

```text
src/main/          Electron main process and IPC
src/renderer/      Task list, editor, activity log, settings
src/storage/       Local task and settings storage
python/            browser-use worker that drives Chrome
```

Flow:

1. You create a local task and write a prompt.
2. Operator launches the Python browser-use worker.
3. The worker uses your `OPENAI_API_KEY` and selected Chrome profile.
4. Events stream back into the Activity panel.

No cloud account or backend is required. Everything runs locally.

## Scripts

```bash
npm run dev          # start Electron
npm run start        # same as dev
npm run verify       # syntax check + smoke startup + dry-run
npm run agent:dry-run
```

## Chrome setup

Operator uses a persistent Chrome profile so logins carry across runs.

On macOS, enable this once:

```text
Chrome > View > Developer > Allow JavaScript from Apple Events
```

Approve macOS automation permissions for Browser Operator / Electron when prompted. Close Chrome completely before a run if the profile is locked.

## Python runtime

For local development, install Python deps into a venv or your environment:

```bash
pip install -r python/requirements.txt
```

If the automation engine is missing, open **Settings** and click **Repair runtime**.

For packaged builds, prepare a portable runtime:

```bash
OPERATOR_STANDALONE_PYTHON_ARCHIVE_URL=https://...
OPERATOR_STANDALONE_PYTHON_ARCHIVE_SHA256=...
npm run build:runtime
OPERATOR_PYTHON_RUNTIME_ARCHIVE_FILE=build/runtime-archives/<archive>
npm run prepare:runtime
npm run verify:runtime
```

## Packaging

```bash
npm run pack       # unpacked local app
npm run dist:mac   # macOS dmg + zip
npm run dist:win   # Windows installer
```
