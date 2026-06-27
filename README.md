# Penut Operator

Penut Operator is a local desktop app for approved browser tasks.

The current direction is an AI browser operator:

1. Penut creates a plain-language task.
2. The account owner reviews and approves it in Operator.
3. Operator uses the user's Chrome session to carry out the browser work.
4. Operator pauses before sensitive final actions such as Send or Post.
5. Every step is logged locally for audit and debugging.

## Current Architecture

This repository now contains the Electron-first operator scaffold:

```text
src/main/          Electron main process and IPC
src/renderer/      Approval UI
src/agent/         AI action planner, local agent runtime, and browser action vocabulary
src/browser/       Generic normal-Chrome control abstraction
src/storage/       Local task storage
fixtures/          Sample task seed data
```

The old Chrome-extension prototype has been removed from the active code path.

## Scripts

```bash
npm install
npm run dev
```

Create a local `.env` file before running the real AI operator:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4.1-mini

Python browser-use worker:

pip install -r python/requirements.txt

The worker reuses `OPENAI_API_KEY` and `OPENAI_MODEL` from the environment.
```

For a non-UI smoke test:

```bash
npm run agent:dry-run
```

## Chrome Setup For Real Browser Control

The desktop app now controls the user's normal Chrome app on macOS through Apple Events. It does not require a separate Chrome profile or a remote-debugging port.

Before running browser actions, enable this Chrome setting once:

```text
Chrome > View > Developer > Allow JavaScript from Apple Events
```

Then start Operator:

```bash
npm run dev
```

When macOS asks for automation permissions, approve them for Penut Operator/Electron. If Chrome cannot be controlled, Operator marks the task failed and writes the setup instructions into the execution log. Dry-run mode is only used by the CLI smoke test.

For syntax checks:

```bash
npm run check
```

## Browser-Control Plan

The active implementation is an AI browser-agent loop:

- Use normal Chrome via Apple Events on macOS for the first proof of concept.
- Observe the current browser page as structured data.
- Ask the AI planner for one next action.
- Execute only approved generic actions: open URL, click element, type text, press key, scroll, wait, pause, complete, or fail.
- Repeat until the task is complete, paused for user review, or blocked.
- Use DOM/accessibility state first; screenshots can be added later for ambiguous visual decisions and audit artifacts.
- Do not execute arbitrary model-generated code.
- Keep a safety checkpoint before final send/post actions.

The UI and runtime are intentionally separated so the browser-control layer can evolve without rewriting the desktop app.
