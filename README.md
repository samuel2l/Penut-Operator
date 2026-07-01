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

Local development can use a `.env` file:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4.1-mini
```

Production builds do not require end users to provide OpenAI keys. In packaged prod,
Operator points browser-use at Penut's authenticated OpenAI-compatible proxy using
the user's Operator session token.

Python browser-use worker for local development:

```bash
pip install -r python/requirements.txt
```

For the full local verification gate:

```bash
npm run verify
```

`verify` runs syntax checks, launches Electron in startup smoke-test mode, and
then runs the non-UI agent dry-run. Use it before packaging or release work.

## Chrome Setup For Real Browser Control

The worker uses a persistent Chrome profile directory so logins can carry across runs on the same machine.

Before running browser actions, enable this Chrome setting once:

```text
Chrome > View > Developer > Allow JavaScript from Apple Events
```

Then start Operator:

```bash
npm run dev
```

When macOS asks for automation permissions, approve them for Penut Operator/Electron. If Chrome cannot be controlled, Operator marks the task failed and writes the setup instructions into the execution log. Dry-run mode is only used by the agent dry-run test.

## Release Builds

Packaging is handled by `electron-builder`.

```bash
npm run pack       # unpacked local app
npm run dist:mac   # macOS dmg + zip
npm run dist:win   # Windows installer
```

Channel helpers:

```bash
npm run dev:local
npm run dev:dev
npm run dev:prod
```

Packaged Electron builds default to the prod channel unless
`PENUT_OPERATOR_CHANNEL` is set.

## Runtime Bundle

The packaged app includes `python/browser_use_worker.py` and
`python/requirements.txt`.

For production CI, build and prepare a platform-specific runtime archive:

```bash
PENUT_STANDALONE_PYTHON_ARCHIVE_URL=https://...
PENUT_STANDALONE_PYTHON_ARCHIVE_SHA256=...
npm run build:runtime
PENUT_PYTHON_RUNTIME_ARCHIVE_FILE=build/runtime-archives/<archive>
npm run prepare:runtime
npm run verify:runtime
```

`build:runtime` starts from a standalone, portable Python archive for the
current OS/CPU, verifies the archive checksum when
`PENUT_STANDALONE_PYTHON_ARCHIVE_SHA256` is set, installs
`python/requirements.txt`, verifies `import browser_use; import openai`,
rejects non-portable Python symlinks, and writes an Operator runtime archive
into `build/runtime-archives`.
`prepare:runtime` extracts that archive into `build/python-runtime`, and
`verify:runtime` confirms the packaged runtime can import the required Python
modules. During Electron packaging, `build/python-runtime` is copied to app
resources as `python-runtime`.

The release workflow builds this archive separately for macOS arm64, macOS x64,
and Windows x64, so each packaged app ships a matching Python runtime.

If no bundled runtime exists, Operator falls back to a managed venv under app
user data and exposes a **Repair runtime** button in Settings. That path is good
for local/dev recovery, but production releases should ship a prepared runtime.

## Signing And Notarization

macOS release builds expect these CI secrets:

```text
MACOS_CERTIFICATE
MACOS_CERTIFICATE_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

Windows release builds expect:

```text
WINDOWS_CERTIFICATE
WINDOWS_CERTIFICATE_PASSWORD
```

The Python runtime archives are public pinned artifacts, so their URLs and
SHA256 checksums are committed directly in `.github/workflows/release.yml`
instead of being stored as GitHub secrets.

Pinned Python runtime sources for the initial production release:

```text
MACOS_ARM64_STANDALONE_PYTHON_ARCHIVE_URL=https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-aarch64-apple-darwin-install_only_stripped.tar.gz
MACOS_ARM64_STANDALONE_PYTHON_ARCHIVE_SHA256=79daa8e9dea1e64ad50aebb05a807289023a474c2020b72361eb44d67fa2401e

MACOS_X64_STANDALONE_PYTHON_ARCHIVE_URL=https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-x86_64-apple-darwin-install_only_stripped.tar.gz
MACOS_X64_STANDALONE_PYTHON_ARCHIVE_SHA256=064731aded38b1a12909088d40d9e0e385dc989e38a1e1de9917610254194962

WINDOWS_X64_STANDALONE_PYTHON_ARCHIVE_URL=https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-x86_64-pc-windows-msvc-install_only_stripped.tar.gz
WINDOWS_X64_STANDALONE_PYTHON_ARCHIVE_SHA256=2933d50847057b9131ff89578a220b9206c40fd6bc34d0c12afb716bd9bf8fc9
```

Launch support is macOS arm64, macOS x64, and Windows x64. Linux and other
platforms should not be advertised until we add matching Electron targets,
runtime archives, installer QA, and browser-control testing for those
platforms.

Auto-update metadata is configured for:

```text
https://penut.ai/operator/updates
```

The Penut website must host the artifacts generated by `electron-builder` at
that path.

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
