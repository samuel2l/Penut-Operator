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
src/agent/         Local agent runtime and task planner
src/browser/       Browser-control abstraction
src/storage/       Local task storage
fixtures/          Sample task seed data
```

The old Chrome-extension prototype has been removed from the active code path.

## Scripts

```bash
npm install
npm run dev
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

The next implementation layer is a hybrid browser agent:

- Use normal Chrome via Apple Events on macOS for the first proof of concept.
- Use DOM/accessibility state first.
- Use screenshots only for ambiguous visual decisions and audit artifacts.
- Keep a safety checkpoint before final send/post actions.

The first supported workflow is:

```text
Send a LinkedIn DM to [person] about [topic]. Pause before final Send.
```

The UI and runtime are intentionally separated so the browser-control layer can evolve without rewriting the desktop app.
