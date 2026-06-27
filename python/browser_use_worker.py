import asyncio
import json
import os
import sys
import time

try:
    from browser_use.beta import Agent, BrowserProfile, ChatOpenAI
except ImportError:  # pragma: no cover
    from browser_use import Agent, BrowserProfile, ChatOpenAI


def emit(event_type, message, detail=None):
    payload = {
        "type": event_type,
        "message": message,
    }
    if detail is not None:
        payload["detail"] = detail
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


async def run_task(task_prompt):
    started_at = time.perf_counter()
    emit("agent", "Starting task.")

    browser_started_at = time.perf_counter()
    agent = Agent(
        task=task_prompt,
        llm=ChatOpenAI(model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini")),
        browser_profile=BrowserProfile(
            headless=False,
            user_data_dir=os.getenv("BROWSER_USE_CHROME_USER_DATA_DIR"),
            profile_directory=os.getenv("BROWSER_USE_CHROME_PROFILE_DIRECTORY", "Default"),
        ),
    )
    emit("agent", "Browser ready.", {"ms": elapsed_ms(browser_started_at)})

    run_started_at = time.perf_counter()
    history = await agent.run()
    final_result = ""
    if hasattr(history, "final_result"):
        try:
            final_result = history.final_result() or ""
        except Exception:
            final_result = ""

    emit(
        "agent",
        "Task finished.",
        {
            "result": final_result,
            "ms": elapsed_ms(run_started_at),
            "totalMs": elapsed_ms(started_at),
        },
    )
    emit("complete", final_result or "Task complete.")


def main():
    if len(sys.argv) < 2:
        emit("agent", "Missing task prompt for browser-use worker.")
        sys.exit(1)

    task_prompt = sys.argv[1]
    try:
        asyncio.run(run_task(task_prompt))
    except Exception as exc:
        emit("agent", "Browser-use worker failed.", {"error": str(exc)})
        sys.stderr.write(str(exc) + "\n")
        sys.exit(1)


def elapsed_ms(started_at):
    return round((time.perf_counter() - started_at) * 1000)


if __name__ == "__main__":
    main()
