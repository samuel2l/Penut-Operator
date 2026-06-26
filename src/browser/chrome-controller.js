export class ChromeController {
  #onEvent;
  #page;

  constructor({ onEvent }) {
    this.#onEvent = onEvent;
  }

  async connect() {
    await this.#emit("browser", "Preparing Chrome controller.");
    await this.#ensurePlaywrightAvailable();
    await this.#emit("browser", "Chrome controller is ready in dry-run mode.");
  }

  async execute(step) {
    switch (step.action) {
      case "goto":
        return this.#goto(step.target);
      case "wait_for_page":
        return this.#waitForPage(step.target);
      case "search_linkedin":
      case "open_best_profile_match":
      case "open_message_composer":
      case "type_message":
      case "pause_before_send":
        return this.#dryRun(step);
      default:
        throw new Error(`Unsupported browser action: ${step.action}`);
    }
  }

  async #goto(url) {
    await this.#emit("browser", `Would navigate Chrome to ${url}.`, { url });
    if (this.#page) await this.#page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async #waitForPage(target) {
    await this.#emit("browser", `Would wait for page: ${target}.`);
  }

  async #dryRun(step) {
    await this.#emit("browser", `Dry run action: ${step.action}.`, {
      target: step.target,
    });
  }

  async #ensurePlaywrightAvailable() {
    try {
      await import("playwright-core");
    } catch {
      await this.#emit("browser", "Playwright is not installed yet; running agent in dry-run mode.");
    }
  }

  async #emit(type, message, detail) {
    await this.#onEvent?.({ type, message, detail });
  }
}
