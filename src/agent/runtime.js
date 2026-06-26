import { ChromeController } from "../browser/chrome-controller.js";
import { AIActionPlanner } from "./ai/action-planner.js";
import { BrowserActions } from "./browser-actions.js";

const MAX_STEPS = 25;
const MAX_REJECTED_ACTIONS = 4;

export class OperatorAgentRuntime {
  #stopped = false;
  #onEvent;
  #browser;
  #planner;
  #allowDryRun;

  constructor({ onEvent, allowDryRun = false, planner }) {
    this.#onEvent = onEvent;
    this.#allowDryRun = allowDryRun;
    this.#browser = new ChromeController({ onEvent, allowDryRun });
    this.#planner = planner || (allowDryRun ? new DryRunActionPlanner() : new AIActionPlanner());
  }

  stop() {
    this.#stopped = true;
  }

  async run(task) {
    await this.#emit("agent", "Operator run started.", {
      taskId: task.id,
    });

    await this.#browser.connect();

    const history = [];

    for (let stepIndex = 0; stepIndex < MAX_STEPS; stepIndex += 1) {
      if (this.#stopped) {
        await this.#emit("agent", "Operator run stopped by user.");
        return { ok: false, stopped: true };
      }

      const observation = await this.#observeWithContent();
      await this.#emit("agent", "Observed browser page.", {
        url: observation.url,
        title: observation.title,
        elementCount: observation.elements.length,
      });

      const decision = await this.#planner.nextAction({ task, observation, history });
      const validDecision = validateDecisionOrReject(decision, observation, history, task);
      if (validDecision.action === "rejected") {
        const rejectionCount = history.filter((entry) => entry.action === "rejected").length + 1;
        await this.#emit("agent", validDecision.reason, {
          step: stepIndex + 1,
          rejectedAction: decision.action,
          elementId: decision.elementId,
          url: decision.url,
          rejectionCount,
        });
        if (rejectionCount >= MAX_REJECTED_ACTIONS) {
          throw new Error(`AI planner kept choosing rejected actions. Last issue: ${validDecision.reason}`);
        }
        history.push({
          action: "rejected",
          reason: validDecision.reason,
          rejectedAction: decision.action,
          url: observation.url,
          requestedUrl: decision.url,
          elementId: decision.elementId,
        });
        continue;
      }

      const guardedDecision = validDecision;
      const targetElement = observation.elements.find(
        (element) => element.id === guardedDecision.elementId,
      );

      await this.#emit("agent", guardedDecision.reason || `Action: ${guardedDecision.action}`, {
        step: stepIndex + 1,
        action: guardedDecision.action,
        elementId: guardedDecision.elementId,
        url: guardedDecision.url,
        text: summarizeText(guardedDecision.text),
      });

      history.push({
        action: guardedDecision.action,
        reason: guardedDecision.reason,
        url: observation.url,
        requestedUrl: guardedDecision.url,
        elementId: guardedDecision.elementId,
        elementLabel: targetElement?.label || "",
        elementRole: targetElement?.role || "",
        elementEditable: targetElement?.editable || false,
        text: summarizeText(guardedDecision.text),
      });

      if (guardedDecision.action === BrowserActions.Complete) {
        await this.#emit("agent", guardedDecision.text || "Operator task complete.");
        return { ok: true, complete: true };
      }

      if (guardedDecision.action === BrowserActions.PauseForUser) {
        await this.#emit("agent", guardedDecision.text || "Operator paused for user review.");
        return { ok: true, pausedBeforeSend: true };
      }

      if (
        guardedDecision.action === BrowserActions.Fail &&
        observation.elements.length === 0 &&
        !observation.visibleText
      ) {
        await this.#emit("agent", "Ignoring fail decision on empty browser observation; waiting for page content.", {
          step: stepIndex + 1,
          url: observation.url,
        });
        await this.#browser.execute({
          action: BrowserActions.Wait,
          milliseconds: 1500,
        });
        continue;
      }

      if (guardedDecision.action === BrowserActions.Fail) {
        throw new Error(guardedDecision.text || guardedDecision.reason || "Operator could not continue.");
      }

      await this.#browser.execute(guardedDecision);
    }

    throw new Error(`Operator reached the ${MAX_STEPS}-step limit without completing the task.`);
  }

  async #emit(type, message, detail) {
    await this.#onEvent?.({ type, message, detail });
  }

  async #observeWithContent() {
    if (this.#allowDryRun) return this.#browser.observePage();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const observation = await this.#browser.observePage();
      if (observation.elements.length > 0 || observation.visibleText) return observation;

      await this.#emit("agent", "Browser page had no observable controls yet; waiting.", {
        attempt: attempt + 1,
        url: observation.url,
        title: observation.title,
      });
      await this.#browser.execute({
        action: BrowserActions.Wait,
        milliseconds: 1500,
      });
    }

    return this.#browser.observePage();
  }
}

class DryRunActionPlanner {
  #called = false;

  async nextAction() {
    if (this.#called) {
      return {
        action: BrowserActions.Complete,
        reason: "Dry-run planner completed.",
        url: "",
        elementId: "",
        text: "Dry-run architecture smoke test completed.",
        key: "",
        direction: "",
        milliseconds: 0,
      };
    }

    this.#called = true;
    return {
      action: BrowserActions.OpenUrl,
      reason: "Dry-run planner would start by opening the relevant site.",
      url: "https://www.linkedin.com",
      elementId: "",
      text: "",
      key: "",
      direction: "",
      milliseconds: 0,
    };
  }
}

function validateDecisionOrReject(decision, observation, history, task) {
  try {
    return validateDecision(decision, observation, history, task);
  } catch (error) {
    return {
      action: "rejected",
      reason: error.message,
    };
  }
}

function validateDecision(decision, observation, history, task) {
  if (!decision || typeof decision !== "object") {
    throw new Error("AI planner returned an invalid action.");
  }

  if (!Object.values(BrowserActions).includes(decision.action)) {
    throw new Error(`AI planner returned unsupported action: ${decision.action}`);
  }

  if (decision.action === BrowserActions.OpenUrl && !decision.url) {
    throw new Error("AI planner returned open_url without a URL.");
  }

  if (decision.action === BrowserActions.OpenUrl && redundantOpenUrl(decision, observation, history)) {
    throw new Error(`AI planner tried to reload an already-open URL: ${decision.url}`);
  }

  const targetElement = observation.elements.find((element) => element.id === decision.elementId);
  if ([BrowserActions.ClickElement, BrowserActions.TypeText].includes(decision.action) && !targetElement) {
    throw new Error(`AI planner referenced an unknown element id: ${decision.elementId}`);
  }

  if (decision.action === BrowserActions.TypeText && !decision.text) {
    throw new Error("AI planner returned type_text without text.");
  }

  if (decision.action === BrowserActions.Wait && repeatedWait(history)) {
    throw new Error("AI planner waited repeatedly without progress.");
  }

  if (
    decision.action === BrowserActions.TypeText &&
    decision.text.length > 80 &&
    isSearchOrNavigationField(targetElement)
  ) {
    throw new Error(
      `AI planner tried to type a long draft into a search/navigation field: "${targetElement.label}".`,
    );
  }

  if (decision.action === BrowserActions.ClickElement && repeatedSameClick(decision, observation, history)) {
    throw new Error(
      `AI planner repeated the same click on "${targetElement.label}" without progress.`,
    );
  }

  if (decision.action === BrowserActions.ClickElement && badGenericInboxClick(targetElement, task)) {
    throw new Error(
      `AI planner tried to open generic inbox navigation for a person-specific message task: "${targetElement.label}".`,
    );
  }

  if (decision.action === BrowserActions.PauseForUser) {
    const lastTyped = [...history].reverse().find((entry) => entry.action === BrowserActions.TypeText);
    if (lastTyped && isSearchOrNavigationLabel(lastTyped.elementLabel)) {
      throw new Error(
        `AI planner tried to pause after typing into a search/navigation field: "${lastTyped.elementLabel}".`,
      );
    }
  }

  return decision;
}

function badGenericInboxClick(element, task) {
  const prompt = task.prompt || "";
  if (!/\b(dm|message|send)\b/i.test(prompt)) return false;
  if (!/\b(to|for)\s+[A-Z][\p{L}'-]+/u.test(prompt)) return false;

  const label = element?.label || "";
  if (!/\b(messaging|messages|inbox)\b/i.test(label)) return false;
  return !personNameFromPrompt(prompt)
    .toLowerCase()
    .split(/\s+/)
    .some((part) => part && label.toLowerCase().includes(part));
}

function personNameFromPrompt(prompt) {
  return (
    prompt.match(/\b(?:to|for)\s+(.+?)(?:\s+saying\b|\s+about\b|:|\.|$)/i)?.[1] || ""
  ).trim();
}

function repeatedSameClick(decision, observation, history) {
  const recentClicks = history
    .slice(-4)
    .filter((entry) => entry.action === BrowserActions.ClickElement);
  const repeats = recentClicks.filter(
    (entry) => entry.url === observation.url && entry.elementId === decision.elementId,
  );
  return repeats.length >= 2;
}

function redundantOpenUrl(decision, observation, history) {
  const targetUrl = normalizeUrl(decision.url);
  if (!targetUrl) return false;

  if (targetUrl === normalizeUrl(observation.url)) return true;

  const recentOpenUrls = history
    .slice(-5)
    .filter((entry) => entry.action === BrowserActions.OpenUrl)
    .map((entry) => normalizeUrl(entry.requestedUrl || ""))
    .filter(Boolean);

  return recentOpenUrls.filter((url) => url === targetUrl).length >= 2;
}

function repeatedWait(history) {
  return history.slice(-2).every((entry) => entry.action === BrowserActions.Wait);
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    const removableParams = ["origin", "ref", "ref_src", "trk"];
    for (const param of removableParams) url.searchParams.delete(param);
    return `${url.origin}${url.pathname.replace(/\/$/, "")}?${url.searchParams.toString()}`.replace(/\?$/, "");
  } catch {
    return "";
  }
}

function isSearchOrNavigationField(element) {
  if (!element) return false;
  if (!element.editable) return false;
  return isSearchOrNavigationLabel(element.label);
}

function isSearchOrNavigationLabel(label) {
  return /\b(search|looking for|find|global search|navigation|nav)\b/i.test(label || "");
}

function summarizeText(text) {
  if (!text) return "";
  const value = String(text);
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}
