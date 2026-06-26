import { ChromeController } from "../browser/chrome-controller.js";
import { createLinkedInDmPlanner } from "./planners/linkedin-dm-planner.js";

export class OperatorAgentRuntime {
  #stopped = false;
  #onEvent;
  #browser;

  constructor({ onEvent, allowDryRun = false }) {
    this.#onEvent = onEvent;
    this.#browser = new ChromeController({ onEvent, allowDryRun });
  }

  stop() {
    this.#stopped = true;
  }

  async run(task) {
    await this.#emit("agent", "Operator run started.", {
      taskId: task.id,
      safetyMode: task.safetyMode,
    });

    const plan = createLinkedInDmPlanner(task);
    await this.#browser.connect();

    for (const step of plan.steps) {
      if (this.#stopped) {
        await this.#emit("agent", "Operator run stopped by user.");
        return { ok: false, stopped: true };
      }

      await this.#emit("agent", step.message, {
        action: step.action,
        target: step.target,
      });
      await this.#browser.execute(step);
    }

    await this.#emit("agent", "Draft prepared. Operator paused before final Send.");
    return { ok: true, pausedBeforeSend: true };
  }

  async #emit(type, message, detail) {
    await this.#onEvent?.({ type, message, detail });
  }
}
