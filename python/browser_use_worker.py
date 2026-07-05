import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

from browser_use import Agent, BrowserProfile, ChatOpenAI


class TaskFailure(RuntimeError):
    """Raised after a user-facing failure event has already been emitted."""


def emit(event_type, message, detail=None):
    payload = {
        "type": event_type,
        "message": message,
    }
    if detail is not None:
        payload["detail"] = detail
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def prepare_worker_cwd():
    raw = os.getenv("PENUT_OPERATOR_WORKER_CWD", "").strip()
    worker_cwd = Path(raw) if raw else Path(os.getenv("TMPDIR", "/tmp")) / "penut-operator-worker"
    worker_cwd.mkdir(parents=True, exist_ok=True)
    os.chdir(worker_cwd)
    return str(worker_cwd)


def uses_penet_proxy():
    return bool(os.getenv("OPENAI_BASE_URL", "").strip()) or os.getenv(
        "PENUT_OPERATOR_PLANNER",
        "",
    ).strip().lower() == "backend"


def build_llm():
    llm_kwargs = {
        "model": os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
    }
    base_url = os.getenv("OPENAI_BASE_URL", "").strip()
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if base_url:
        llm_kwargs["base_url"] = base_url
    if api_key:
        llm_kwargs["api_key"] = api_key
    if uses_penet_proxy():
        llm_kwargs["reasoning_models"] = []
    return ChatOpenAI(**llm_kwargs)


def build_browser_profile():
    emit("agent", "Preparing browser session.")
    return BrowserProfile(
        headless=False,
        keep_alive=True,
        user_data_dir=os.getenv("BROWSER_USE_CHROME_USER_DATA_DIR"),
        profile_directory=os.getenv("BROWSER_USE_CHROME_PROFILE_DIRECTORY", "Default"),
    )


def build_agent_kwargs(task_prompt):
    return {
        "task": task_prompt,
        "llm": build_llm(),
        "browser_profile": build_browser_profile(),
        "directly_open_url": True,
    }


def friendly_error_message(raw):
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not text:
        return "Task could not finish."
    lowered = text.lower()
    if "payload too large" in lowered or "request entity too large" in lowered:
        return "Penut rejected the planning request because it was too large. The Penut server limit needs to match what local OpenAI accepts."
    if text.startswith("Result files:"):
        return "The browser agent returned a local file listing instead of completing the task."
    if "<!doctype html" in lowered or "<html" in lowered:
        return "Penut could not process the browser planning request."
    if len(text) > 240:
        return f"{text[:237]}..."
    return text


def looks_like_false_file_listing(result):
    text = str(result or "").strip()
    return text.startswith("Result files:")


def task_error_message(history):
    final_result = ""
    if hasattr(history, "final_result"):
        try:
            final_result = history.final_result() or ""
        except Exception:
            final_result = ""
    if final_result:
        return friendly_error_message(final_result)

    if hasattr(history, "errors"):
        try:
            errors = [
                friendly_error_message(error)
                for error in (history.errors() or [])
                if str(error).strip()
            ]
            if errors:
                return errors[-1]
        except Exception:
            pass

    return "Task could not finish."


def fail_task(message):
    friendly = friendly_error_message(message)
    emit("agent", "Task could not finish.", {"reason": friendly})
    raise TaskFailure(friendly)


async def run_task(task_prompt):
    started_at = time.perf_counter()
    prepare_worker_cwd()
    emit("agent", "Starting task.")

    browser_started_at = time.perf_counter()
    agent = Agent(**build_agent_kwargs(task_prompt))
    emit("agent", "Browser is ready.")

    run_started_at = time.perf_counter()
    emit("agent", "Opening Chrome.")
    history = await agent.run()

    final_result = ""
    if hasattr(history, "final_result"):
        try:
            final_result = history.final_result() or ""
        except Exception:
            final_result = ""

    if looks_like_false_file_listing(final_result):
        fail_task(final_result)

    if hasattr(history, "is_successful") and not history.is_successful():
        fail_task(task_error_message(history))

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
        emit("agent", "Task is missing instructions.")
        sys.exit(1)

    task_prompt = sys.argv[1]
    try:
        asyncio.run(run_task(task_prompt))
    except TaskFailure as exc:
        sys.stderr.write(str(exc) + "\n")
        sys.exit(1)
    except Exception as exc:
        fail_msg = friendly_error_message(exc)
        emit("agent", "Task could not finish.", {"reason": fail_msg})
        sys.stderr.write(fail_msg + "\n")
        sys.exit(1)


def elapsed_ms(started_at):
    return round((time.perf_counter() - started_at) * 1000)


if __name__ == "__main__":
    main()
