chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "PENUT_PREPARE_LINKEDIN_DM") return false;

  prepareLinkedInDm(message.task)
    .then((result) => sendResponse(result))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  return true;
});

async function prepareLinkedInDm(task) {
  injectBanner("Preparing LinkedIn DM draft...");

  const messageButton = await findMessageButton();
  if (!messageButton) {
    injectBanner("Could not find a Message button on this LinkedIn profile.", true);
    return {
      ok: false,
      error: "Could not find a Message button. The lead may not allow messages from this account.",
    };
  }

  messageButton.click();

  const editor = await findMessageEditor();
  if (!editor) {
    injectBanner("Message window opened, but no editable message field was found.", true);
    return {
      ok: false,
      error: "Could not find LinkedIn message editor.",
    };
  }

  setEditorText(editor, task.messageDraft || "");
  injectBanner(
    "Penut prepared the DM draft. Review it in LinkedIn and send manually when ready.",
  );

  return {
    ok: true,
    prepared: true,
    finalSendClicked: false,
  };
}

async function findMessageButton() {
  return waitFor(() => {
    const buttons = Array.from(document.querySelectorAll("button, a"));
    return buttons.find((button) => {
      const label = [
        button.innerText,
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return /\bmessage\b/.test(label);
    });
  }, 10000);
}

async function findMessageEditor() {
  return waitFor(() => {
    const selector = [
      ".msg-form__contenteditable",
      '[aria-label*="Write a message" i]',
      '[role="textbox"]',
      '[data-placeholder*="Write a message" i]',
      '[contenteditable="true"]',
      "textarea",
    ].join(", ");
    const editors = Array.from(document.querySelectorAll(selector));
    return editors.find(isUsableMessageEditor);
  }, 15000);
}

function setEditorText(editor, text) {
  editor.scrollIntoView({ block: "center" });
  editor.click();
  editor.focus();

  if (editor instanceof HTMLTextAreaElement) {
    editor.value = text;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return;
  }

  const inputEvent = new InputEvent("input", {
    bubbles: true,
    cancelable: true,
    inputType: "insertText",
    data: text,
  });

  document.execCommand("selectAll", false, null);
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted || !editor.textContent?.includes(text.slice(0, 12))) {
    editor.textContent = "";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    editor.append(paragraph);
  }

  editor.dispatchEvent(inputEvent);
  editor.dispatchEvent(new Event("change", { bubbles: true }));
}

function isUsableMessageEditor(editor) {
  if (!(editor instanceof HTMLElement)) return false;

  const rect = editor.getBoundingClientRect();
  const style = window.getComputedStyle(editor);
  if (
    rect.width < 120 ||
    rect.height < 8 ||
    style.visibility === "hidden" ||
    style.display === "none"
  ) {
    return false;
  }

  const label = [
    editor.getAttribute("aria-label"),
    editor.getAttribute("data-placeholder"),
    editor.getAttribute("placeholder"),
    editor.className,
    editor.closest("[aria-label]")?.getAttribute("aria-label"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const isLinkedInComposer =
    label.includes("write a message") ||
    label.includes("message") ||
    editor.closest(".msg-form") ||
    editor.closest('[class*="msg-form"]');

  return Boolean(isLinkedInComposer);
}

function waitFor(fn, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const value = fn();
      if (value) return resolve(value);
      if (Date.now() - started >= timeoutMs) return resolve(null);
      setTimeout(tick, 250);
    };
    tick();
  });
}

function injectBanner(message, isError = false) {
  const existing = document.querySelector("#penut-operator-banner");
  if (existing) existing.remove();

  const banner = document.createElement("div");
  banner.id = "penut-operator-banner";
  banner.textContent = message;
  Object.assign(banner.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: "2147483647",
    maxWidth: "360px",
    padding: "12px 14px",
    borderRadius: "8px",
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.22)",
    background: isError ? "#b42318" : "#142033",
    color: "#fff",
    font: "600 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  });
  document.documentElement.append(banner);
}
