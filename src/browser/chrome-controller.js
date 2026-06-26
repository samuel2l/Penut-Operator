import { execFile } from "node:child_process";
import { BrowserActions } from "../agent/browser-actions.js";

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[contenteditable='true']",
].join(",");

export class ChromeController {
  #onEvent;
  #dryRun = false;
  #allowDryRun;

  constructor({ onEvent, allowDryRun = false }) {
    this.#onEvent = onEvent;
    this.#allowDryRun = allowDryRun;
  }

  async connect() {
    await this.#emit("browser", "Preparing normal Chrome controller.");

    if (process.platform !== "darwin") {
      if (this.#allowDryRun) {
        this.#dryRun = true;
        await this.#emit("browser", "Normal Chrome control is currently implemented for macOS only; using dry-run mode.");
        return;
      }

      throw new Error("Normal Chrome control is currently implemented for macOS only.");
    }

    if (this.#allowDryRun) {
      this.#dryRun = true;
      await this.#emit("browser", "Browser actions will run in dry-run mode.");
      return;
    }

    try {
      await runAppleScript(`
        tell application "Google Chrome"
          activate
          if not (exists window 1) then make new window
        end tell
      `);
      await this.#executeJavaScript("location.href");
      await this.#emit("browser", "Connected to normal Chrome.", {
        mode: "apple_events",
      });
    } catch (error) {
      throw new Error(
        [
          "Could not control normal Chrome.",
          "In Chrome, enable View > Developer > Allow JavaScript from Apple Events, then approve macOS automation permissions for Penut Operator/Electron.",
          `Original error: ${cleanAppleScriptError(error.message)}`,
        ].join(" "),
      );
    }
  }

  async observePage() {
    if (this.#dryRun) {
      return {
        url: "dry-run://browser",
        title: "Dry run",
        visibleText: "",
        elements: [],
      };
    }

    await this.#waitUntilReady();
    return this.#runJsonScript(`
      const selector = ${jsonStringify(INTERACTIVE_SELECTOR)};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const labelFor = (node) =>
        clean([
          node.innerText,
          node.getAttribute("aria-label"),
          node.getAttribute("placeholder"),
          node.getAttribute("title"),
          node.getAttribute("name"),
          node.getAttribute("type"),
          node.getAttribute("value"),
          node.href,
        ].filter(Boolean).join(" "));
      const roleFor = (node) => {
        if (node.getAttribute("role")) return node.getAttribute("role");
        const tag = node.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (tag === "input" || tag === "textarea" || node.isContentEditable) return "textbox";
        return "";
      };

      const elements = Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .slice(0, 80)
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const tag = node.tagName.toLowerCase();
          const editable = tag === "textarea" || tag === "input" || node.isContentEditable;
          return {
            id: "el_" + index,
            tag,
            role: roleFor(node),
            label: labelFor(node).slice(0, 220),
            href: node.href || "",
            editable,
            clickable: !editable || tag === "select",
            searchLike: editable && /search|looking for|find/i.test(labelFor(node)),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
        .filter((element) => element.label || element.editable);

      return {
        url: location.href,
        title: document.title,
        visibleText: clean(document.body?.innerText || "").slice(0, 5000),
        elements,
      };
    `);
  }

  async execute(decision) {
    switch (decision.action) {
      case BrowserActions.OpenUrl:
        return this.#openUrl(decision.url);
      case BrowserActions.ClickElement:
        return this.#clickElement(decision.elementId);
      case BrowserActions.TypeText:
        return this.#typeText(decision.elementId, decision.text);
      case BrowserActions.PressKey:
        return this.#pressKey(decision.key);
      case BrowserActions.Scroll:
        return this.#scroll(decision.direction);
      case BrowserActions.Wait:
        return this.#wait(decision.milliseconds);
      case BrowserActions.PauseForUser:
      case BrowserActions.Complete:
      case BrowserActions.Fail:
        return;
      default:
        throw new Error(`Unsupported browser action: ${decision.action}`);
    }
  }

  async #openUrl(url) {
    if (!url) throw new Error("open_url requires a URL.");
    if (this.#dryRun) return this.#dryRunAction("Would navigate Chrome.", { url });

    await this.#emit("browser", `Navigating normal Chrome to ${url}.`, { url });
    await runAppleScript(`
      tell application "Google Chrome"
        activate
        if not (exists window 1) then make new window
        set URL of active tab of front window to ${appleScriptString(url)}
      end tell
    `);
    await this.#waitUntilReady();
  }

  async #clickElement(elementId) {
    if (!elementId) throw new Error("click_element requires elementId.");
    if (this.#dryRun) return this.#dryRunAction("Would click element.", { elementId });

    const result = await this.#runJsonScript(`
      const selector = ${jsonStringify(INTERACTIVE_SELECTOR)};
      const index = Number(${jsonStringify(elementId)}.replace("el_", ""));
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
      const node = nodes[index];
      if (!node) return { ok: false, reason: "Observed element no longer exists.", elementId: ${jsonStringify(elementId)} };
      node.scrollIntoView({ block: "center", inline: "center" });
      node.focus?.();
      node.click();
      return {
        ok: true,
        elementId: ${jsonStringify(elementId)},
        label: [
          node.innerText,
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
          node.href,
        ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim().slice(0, 220),
      };
    `);

    if (!result.ok) throw new Error(result.reason);
    await this.#emit("browser", "Clicked observed element.", result);
    await delay(800);
  }

  async #typeText(elementId, text) {
    if (!elementId) throw new Error("type_text requires elementId.");
    if (this.#dryRun) return this.#dryRunAction("Would type text.", { elementId, text });

    const result = await this.#runJsonScript(`
      const selector = ${jsonStringify(INTERACTIVE_SELECTOR)};
      const index = Number(${jsonStringify(elementId)}.replace("el_", ""));
      const text = ${jsonStringify(text || "")};
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
      const node = nodes[index];
      if (!node) return { ok: false, reason: "Observed element no longer exists.", elementId: ${jsonStringify(elementId)} };

      node.scrollIntoView({ block: "center", inline: "center" });
      node.focus?.();

      if (node.tagName.toLowerCase() === "input" || node.tagName.toLowerCase() === "textarea") {
        node.value = text;
      } else if (node.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);

        const inserted = document.execCommand?.("insertText", false, text);
        if (!inserted) {
          node.textContent = text;
        }
      } else {
        return { ok: false, reason: "Observed element is not editable.", elementId: ${jsonStringify(elementId)} };
      }

      node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, elementId: ${jsonStringify(elementId)}, characterCount: text.length };
    `);

    if (!result.ok) throw new Error(result.reason);
    await this.#emit("browser", "Typed text into observed element.", result);
  }

  async #pressKey(key) {
    const normalized = normalizeKey(key);
    if (!normalized) throw new Error("press_key requires a supported key.");
    if (this.#dryRun) return this.#dryRunAction("Would press key.", { key: normalized });

    await runAppleScript(`
      tell application "Google Chrome" to activate
      tell application "System Events" to keystroke ${appleScriptString(normalized)}
    `);
    await this.#emit("browser", "Pressed key.", { key: normalized });
    await delay(500);
  }

  async #scroll(direction) {
    const amount = direction === "up" ? -700 : 700;
    if (this.#dryRun) return this.#dryRunAction("Would scroll page.", { direction });

    await this.#executeJavaScript(`window.scrollBy({ top: ${amount}, behavior: "smooth" });`);
    await this.#emit("browser", "Scrolled page.", { direction: direction || "down" });
    await delay(600);
  }

  async #wait(milliseconds) {
    const duration = Math.min(Math.max(Number(milliseconds) || 1000, 250), 5000);
    if (this.#dryRun) return this.#dryRunAction("Would wait.", { milliseconds: duration });

    await delay(duration);
    await this.#emit("browser", "Waited for page update.", { milliseconds: duration });
  }

  async #waitUntilReady() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const state = await this.#executeJavaScript("document.readyState").catch(() => "");
      if (state === "interactive" || state === "complete") return;
      await delay(250);
    }
  }

  async #runJsonScript(body) {
    const raw = await this.#executeJavaScript(`
      (() => {
        try {
          const result = (() => { ${body} })();
          return JSON.stringify(result ?? {});
        } catch (error) {
          return JSON.stringify({ ok: false, reason: error.message });
        }
      })();
    `);
    return JSON.parse(raw || "{}");
  }

  async #executeJavaScript(source) {
    return runAppleScript(`
      tell application "Google Chrome"
        activate
        if not (exists window 1) then make new window
        execute active tab of front window javascript ${appleScriptString(source)}
      end tell
    `);
  }

  async #dryRunAction(message, detail) {
    await this.#emit("browser", message, detail);
  }

  async #emit(type, message, detail) {
    await this.#onEvent?.({ type, message, detail });
  }
}

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function appleScriptString(value) {
  return JSON.stringify(String(value));
}

function jsonStringify(value) {
  return JSON.stringify(value ?? "");
}

function normalizeKey(key) {
  const value = String(key || "").trim();
  const supported = new Set(["Enter", "Escape", "Tab", "Backspace", "ArrowDown", "ArrowUp"]);
  if (!supported.has(value)) return "";
  if (value === "Enter") return "\r";
  if (value === "Escape") return String.fromCharCode(27);
  if (value === "Tab") return "\t";
  return value;
}

function cleanAppleScriptError(message) {
  return String(message || "").replace(/\s+/g, " ").trim();
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
