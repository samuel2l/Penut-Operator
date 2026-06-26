import { execFile } from "node:child_process";

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

  async execute(step) {
    switch (step.action) {
      case "goto":
        return this.#goto(step.target);
      case "wait_for_page":
        return this.#waitForPage(step.target);
      case "search_linkedin":
        return this.#searchLinkedIn(step.target);
      case "open_best_profile_match":
        return this.#openBestProfileMatch(step.target);
      case "open_message_composer":
        return this.#openMessageComposer(step.target);
      case "type_message":
        return this.#typeMessage(step.target);
      case "pause_before_send":
        return this.#pauseBeforeSend();
      default:
        throw new Error(`Unsupported browser action: ${step.action}`);
    }
  }

  async #goto(url) {
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
    await this.#emitObservation("Navigation complete.");
  }

  async #waitForPage(target) {
    if (this.#dryRun) return this.#dryRunAction("Would wait for page.", { target });

    await this.#waitUntilReady();
    await this.#emitObservation(`Observed page after waiting for ${target}.`);
  }

  async #searchLinkedIn(recipient) {
    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(recipient)}`;
    await this.#goto(searchUrl);
  }

  async #openBestProfileMatch(recipient) {
    if (this.#dryRun) return this.#dryRunAction("Would open best profile match.", { recipient });

    const result = await this.#runJsonScript(`
      const anchors = Array.from(document.querySelectorAll('a[href*="/in/"]'));
      const visibleLinks = anchors
        .filter((anchor) => {
          const rect = anchor.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((anchor) => ({
          href: anchor.href,
          text: (anchor.innerText || anchor.textContent || "").replace(/\\s+/g, " ").trim(),
        }))
        .filter((anchor) => anchor.href && !anchor.href.includes('/search/'));

      const normalizedRecipient = ${jsonString(recipient)}.toLowerCase();
      const best =
        visibleLinks.find((anchor) => anchor.text.toLowerCase().includes(normalizedRecipient)) ||
        visibleLinks[0];

      if (!best) return { ok: false, reason: "No LinkedIn profile result was visible." };
      location.href = best.href.split("?")[0];
      return { ok: true, href: best.href, text: best.text };
    `);

    if (!result.ok) throw new Error(result.reason);
    await this.#emit("browser", "Opened LinkedIn profile match.", result);
    await this.#waitUntilReady();
    await this.#emitObservation("Profile loaded.");
  }

  async #openMessageComposer(recipient) {
    if (this.#dryRun) return this.#dryRunAction("Would open message composer.", { recipient });

    const result = await this.#runJsonScript(`
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelFor = (node) =>
        [
          node.innerText,
          node.textContent,
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\\s+/g, " ")
          .trim();

      const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter(visible)
        .map((node) => ({ node, label: labelFor(node) }));
      const messageControl = controls.find(({ label }) => /\\bmessage\\b/i.test(label));

      if (!messageControl) return { ok: false, reason: "No visible Message button was found." };
      messageControl.node.click();
      return { ok: true, label: messageControl.label };
    `);

    if (!result.ok) throw new Error(result.reason);
    await this.#emit("browser", "Opened the LinkedIn message composer.", result);
    await delay(1500);
    await this.#emitObservation("Composer opened.");
  }

  async #typeMessage(message) {
    if (this.#dryRun) return this.#dryRunAction("Would type message.", { message });

    const result = await this.#runJsonScript(`
      const message = ${jsonString(message)};
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'))
        .filter(visible);
      const editor =
        editors.find((node) => /msg-form|message|compose/i.test(node.closest("form, div, section")?.className || "")) ||
        editors[editors.length - 1];

      if (!editor) return { ok: false, reason: "No visible DM editor was found." };

      editor.focus();
      if (editor.tagName.toLowerCase() === "textarea") {
        editor.value = message;
      } else {
        editor.innerHTML = "";
        editor.textContent = message;
      }
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    `);

    if (!result.ok) throw new Error(result.reason);
    await this.#emit("browser", "Typed the DM draft into normal Chrome.", {
      characterCount: message.length,
    });
  }

  async #pauseBeforeSend() {
    if (this.#dryRun) return this.#dryRunAction("Would pause before send.");
    await this.#emit("browser", "Paused before final Send. Human review required.");
  }

  async #waitUntilReady() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const state = await this.#executeJavaScript("document.readyState").catch(() => "");
      if (state === "interactive" || state === "complete") return;
      await delay(250);
    }
  }

  async #emitObservation(message) {
    if (this.#dryRun) return;
    const observation = await this.#runJsonScript(`
      const elements = Array.from(document.querySelectorAll('a, button, input, textarea, [role="button"], [contenteditable="true"]'))
        .slice(0, 40)
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          return {
            index,
            tag: node.tagName.toLowerCase(),
            label: [
              node.innerText,
              node.getAttribute("aria-label"),
              node.getAttribute("placeholder"),
              node.getAttribute("href"),
            ]
              .filter(Boolean)
              .join(" ")
              .replace(/\\s+/g, " ")
              .trim()
              .slice(0, 140),
            visible: rect.width > 0 && rect.height > 0,
          };
        })
        .filter((element) => element.visible && element.label)
        .slice(0, 12);

      return {
        url: location.href,
        title: document.title,
        elements,
      };
    `);
    await this.#emit("browser", message, observation);
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

function jsonString(value) {
  return JSON.stringify(String(value));
}

function cleanAppleScriptError(message) {
  return String(message || "").replace(/\s+/g, " ").trim();
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
