chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PENUT_OPEN_LINKEDIN_DM_COMPOSER") {
    openLinkedInDmComposer(message.task)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message?.type === "PENUT_FILL_LINKEDIN_DM") {
    fillLinkedInDm(message.task)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message?.type === "PENUT_SHOW_MANUAL_FALLBACK") {
    showManualFallback(message.text || "")
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

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

  const opened = await openLinkedInDmComposer(task);
  if (!opened.ok) return opened;

  await sleep(300);
  return fillLinkedInDm(task);
}

async function openLinkedInDmComposer(_task) {
  injectBanner("Opening LinkedIn message composer...");

  const messageButton = await findMessageButton();
  if (!messageButton) {
    injectBanner("Could not find a Message button. The draft will be copied for manual use.", true);
    return {
      ok: false,
      fallback: "clipboard",
      error: "Could not find a Message button. The lead may not allow messages from this account.",
      debug: collectDebugInfo(),
    };
  }

  clickLikeUser(messageButton);
  await waitFor(() => getEditorFromFocusedElement() || queryMessageEditor(), 2500);

  return {
    ok: true,
    composerOpenRequested: true,
    url: window.location.href,
  };
}

async function fillLinkedInDm(task) {
  injectBanner("Looking for LinkedIn message editor...");

  let editor = await findMessageEditor();
  if (!editor && !window.location.href.includes("/messaging/")) {
    const retryButton = await findMessageButton();
    if (retryButton) {
      injectBanner("Message composer did not focus on first attempt. Retrying...");
      clickLikeUser(retryButton);
      await sleep(1500);
      editor = await findMessageEditor();
    }
  }

  if (!editor) {
    injectBanner(
      "LinkedIn opened, but Penut could not safely fill the editor. Draft copied to clipboard; paste it manually.",
      true,
    );
    return {
      ok: false,
      fallback: "clipboard",
      error: "Could not find LinkedIn message editor.",
      debug: collectDebugInfo(),
    };
  }

  setEditorText(editor, task.messageDraft || "");
  const shouldSend = task.sendMode === "approve_then_send";
  if (shouldSend) {
    const sendButton = await findSendButton();
    if (!sendButton) {
      injectBanner("Draft prepared, but Penut could not find an enabled Send button.", true);
      return {
        ok: false,
        prepared: true,
        finalSendClicked: false,
        error: "Draft inserted, but no enabled LinkedIn Send button was found.",
        debug: collectDebugInfo(),
      };
    }

    clickLikeUser(sendButton);
    injectBanner("Penut sent the LinkedIn DM after approval.");
    return {
      ok: true,
      prepared: true,
      finalSendClicked: true,
    };
  }

  injectBanner("Penut prepared the DM draft. Review it in LinkedIn and send manually when ready.");

  return {
    ok: true,
    prepared: true,
    finalSendClicked: false,
  };
}

async function findMessageButton() {
  return waitFor(() => {
    const buttons = Array.from(document.querySelectorAll("button, a"));
    const candidates = buttons.filter(isVisibleMessageButton);
    return (
      candidates.find((button) => button.closest(".pv-top-card, [class*='top-card']")) ||
      candidates.find((button) => button.getBoundingClientRect().top < window.innerHeight * 0.75) ||
      candidates[0]
    );
  }, 5000);
}

async function findMessageEditor() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const directEditor = queryMessageEditor();
    if (directEditor) return directEditor;

    const placeholder = findVisibleElementByText("write a message");
    if (placeholder) {
      clickLikeUser(placeholder);
      await sleep(300);

      const activeEditor = getEditorFromFocusedElement();
      if (activeEditor) return activeEditor;

      const nestedEditor = Array.from(
        placeholder.querySelectorAll?.('[contenteditable="true"], [role="textbox"], textarea') || [],
      ).find(isUsableMessageEditor);
      if (nestedEditor) return nestedEditor;
    }

    await sleep(150);
  }

  return null;
}

function queryMessageEditor() {
  const selector = [
    ".msg-form__contenteditable",
    ".msg-form__msg-content-container [contenteditable='true']",
    ".msg-form [contenteditable='true']",
    '[aria-label*="Write a message" i]',
    '[role="textbox"]',
    '[data-placeholder*="Write a message" i]',
    '[contenteditable="true"]',
    "textarea",
  ].join(", ");
  const editors = Array.from(document.querySelectorAll(selector));
  return editors.find(isUsableMessageEditor) || null;
}

async function findSendButton() {
  return waitFor(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.find((button) => {
      if (!(button instanceof HTMLButtonElement)) return false;
      if (!isVisible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") {
        return false;
      }

      const label = [
        button.innerText,
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
      ]
        .filter(Boolean)
        .join(" ")
        .trim()
        .toLowerCase();

      return label === "send" || /^send\b/.test(label);
    });
  }, 5000);
}

function setEditorText(editor, text) {
  editor.scrollIntoView({ block: "center" });
  clickLikeUser(editor);
  editor.focus();

  if (editor instanceof HTMLTextAreaElement) {
    editor.value = text;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return;
  }

  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", text);
  editor.dispatchEvent(
    new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    }),
  );

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

async function showManualFallback(text) {
  const copied = await copyTextBestEffort(text);
  const existing = document.querySelector("#penut-operator-manual-fallback");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "penut-operator-manual-fallback";

  const title = document.createElement("div");
  title.textContent = copied ? "Draft copied" : "Manual fallback";
  title.style.fontWeight = "800";
  title.style.marginBottom = "8px";

  const body = document.createElement("div");
  body.textContent = copied
    ? "LinkedIn blocked automation. Paste the copied draft into the message box."
    : "LinkedIn blocked automation and clipboard access. Copy this draft manually.";
  body.style.marginBottom = "10px";

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = false;
  Object.assign(textarea.style, {
    width: "100%",
    height: "96px",
    boxSizing: "border-box",
    border: "1px solid #cbd5e1",
    borderRadius: "6px",
    padding: "8px",
    font: "13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  });

  const copyButton = document.createElement("button");
  copyButton.textContent = "Copy draft";
  Object.assign(copyButton.style, {
    marginTop: "10px",
    border: "0",
    borderRadius: "6px",
    padding: "8px 10px",
    background: "#2563eb",
    color: "#fff",
    fontWeight: "800",
    cursor: "pointer",
  });
  copyButton.addEventListener("click", async () => {
    const ok = await copyTextBestEffort(text);
    copyButton.textContent = ok ? "Copied" : "Select text and copy";
    textarea.focus();
    textarea.select();
  });

  Object.assign(panel.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "2147483647",
    width: "360px",
    maxWidth: "calc(100vw - 32px)",
    padding: "14px",
    borderRadius: "8px",
    boxShadow: "0 18px 40px rgba(15, 23, 42, 0.28)",
    background: "#ffffff",
    color: "#142033",
    font: "13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  });

  panel.append(title, body, textarea, copyButton);
  document.documentElement.append(panel);
  textarea.focus();
  textarea.select();

  return { ok: copied, fallbackVisible: true };
}

async function copyTextBestEffort(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.documentElement.append(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function isVisibleMessageButton(button) {
  if (!(button instanceof HTMLElement)) return false;
  if (!isVisible(button, 40, 24) || button.getAttribute("aria-hidden") === "true") {
    return false;
  }

  const label = [
    button.innerText,
    button.getAttribute("aria-label"),
    button.getAttribute("title"),
  ]
    .filter(Boolean)
    .join(" ")
    .trim()
    .toLowerCase();

  return label === "message" || /^message\b/.test(label) || /\bmessage\b/.test(label);
}

function clickLikeUser(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();
  const rect = element.getBoundingClientRect();
  const options = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };

  for (const eventName of ["mouseover", "mousedown", "mouseup", "click"]) {
    element.dispatchEvent(new MouseEvent(eventName, options));
  }
  element.click?.();
}

function isUsableMessageEditor(editor) {
  if (!(editor instanceof HTMLElement)) return false;

  if (!isVisible(editor, 120, 8)) {
    return false;
  }

  const onMessagingPage = window.location.href.includes("/messaging/");
  const inMessageSurface = Boolean(
    editor.closest(".msg-form") ||
      editor.closest('[class*="msg-form"]') ||
      editor.closest('[class*="msg-"]') ||
      editor.closest('[data-view-name*="message" i]'),
  );

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
    inMessageSurface ||
    (!onMessagingPage && (editor.isContentEditable || editor.getAttribute("role") === "textbox"));

  return Boolean(isLinkedInComposer);
}

function isVisible(element, minWidth = 1, minHeight = 1) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width >= minWidth &&
    rect.height >= minHeight &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    style.opacity !== "0"
  );
}

function getEditorFromFocusedElement() {
  const active = document.activeElement;
  if (!active) return null;
  if (isUsableMessageEditor(active)) return active;

  const closestEditor = active.closest?.(
    '.msg-form__contenteditable, [contenteditable="true"], [role="textbox"], textarea',
  );
  if (isUsableMessageEditor(closestEditor)) return closestEditor;

  return null;
}

function findVisibleElementByText(text) {
  const needle = text.toLowerCase();
  const elements = Array.from(document.querySelectorAll("div, p, span"));
  return elements.find((element) => {
    if (!(element instanceof HTMLElement)) return false;
    const value = (element.innerText || element.textContent || "").trim().toLowerCase();
    if (!value.includes(needle)) return false;

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 120 &&
      rect.height > 16 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(fn, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const value = fn();
      if (value) return resolve(value);
      if (Date.now() - started >= timeoutMs) return resolve(null);
      setTimeout(tick, 100);
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

function collectDebugInfo() {
  const candidates = Array.from(
    document.querySelectorAll(
      'textarea, [contenteditable], [role="textbox"], [aria-label], [data-placeholder], button, a',
    ),
  )
    .slice(0, 120)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        tag: element.tagName,
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        dataPlaceholder: element.getAttribute("data-placeholder"),
        contenteditable: element.getAttribute("contenteditable"),
        text: (element.innerText || element.textContent || "").trim().slice(0, 80),
        className: String(element.className || "").slice(0, 120),
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none",
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    });

  return {
    url: window.location.href,
    title: document.title,
    activeElement: document.activeElement
      ? {
          tag: document.activeElement.tagName,
          role: document.activeElement.getAttribute("role"),
          ariaLabel: document.activeElement.getAttribute("aria-label"),
          className: String(document.activeElement.className || "").slice(0, 120),
        }
      : null,
    visibleCandidateCount: candidates.filter((candidate) => candidate.visible).length,
    visibleCandidates: candidates.filter((candidate) => candidate.visible).slice(0, 20),
  };
}
