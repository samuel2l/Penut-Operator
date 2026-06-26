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

  if (message?.type === "PENUT_EXTRACT_LINKEDIN_PROFILE_URN") {
    Promise.resolve(extractLinkedInProfileUrn(message.task))
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message?.type === "PENUT_HAS_LINKEDIN_DM_COMPOSER") {
    sendResponse({ ok: hasVisibleMessageComposerSurface() });
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
    injectBanner("Could not find a LinkedIn Message button for this profile.", true);
    return {
      ok: false,
      error: "Could not find a LinkedIn Message button for this connected profile.",
      debug: collectDebugInfo(),
    };
  }

  const href = messageButton instanceof HTMLAnchorElement ? messageButton.href : "";
  if (href && href.includes("linkedin.com/messaging/")) {
    return {
      ok: true,
      composerOpenRequested: false,
      messagingUrl: href,
      url: window.location.href,
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

function extractLinkedInProfileUrn(task) {
  const html = document.documentElement.innerHTML;
  const publicIdentifier = getProfileSlug(task?.target?.profileUrl || window.location.href);
  const targetName = normalizeText(task?.target?.name || "");
  const candidates = collectProfileUrnCandidates(html)
    .map((urn) => ({
      urn,
      score: scoreProfileUrnCandidate(html, urn, publicIdentifier, targetName),
    }))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best?.urn) {
    return {
      ok: false,
      error: "Could not extract LinkedIn profile member URN from this page.",
      debug: collectDebugInfo(),
    };
  }

  return {
    ok: true,
    urn: best.urn,
    messagingUrl: `https://www.linkedin.com/messaging/thread/new/?recipient=${encodeURIComponent(best.urn)}&screenContext=NON_SELF_PROFILE_VIEW`,
    candidates: candidates.slice(0, 5),
  };
}

function collectProfileUrnCandidates(html) {
  const candidates = new Set();
  const patterns = [
    /urn:li:fsd_profile:(ACo[A-Za-z0-9_-]+)/g,
    /urn:li:fs_miniProfile:(ACo[A-Za-z0-9_-]+)/g,
    /"entityUrn"\s*:\s*"urn:li:fsd_profile:(ACo[A-Za-z0-9_-]+)"/g,
    /"profileUrn"\s*:\s*"urn:li:fsd_profile:(ACo[A-Za-z0-9_-]+)"/g,
    /"objectUrn"\s*:\s*"urn:li:member:(ACo[A-Za-z0-9_-]+)"/g,
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) candidates.add(match[1]);
  }

  return Array.from(candidates);
}

function scoreProfileUrnCandidate(html, urn, publicIdentifier, targetName) {
  const firstIndex = html.indexOf(urn);
  const windowText =
    firstIndex >= 0
      ? html.slice(Math.max(0, firstIndex - 3000), Math.min(html.length, firstIndex + 3000))
      : "";
  const normalizedWindow = normalizeText(windowText).toLowerCase();

  let score = 0;
  if (firstIndex >= 0) score += 10;
  if (publicIdentifier && normalizedWindow.includes(publicIdentifier.toLowerCase())) score += 120;
  if (targetName && normalizedWindow.includes(targetName.toLowerCase())) score += 80;
  if (normalizedWindow.includes("fsd_profile")) score += 30;
  if (normalizedWindow.includes("topcard") || normalizedWindow.includes("top-card")) score += 25;
  if (normalizedWindow.includes("profile")) score += 10;
  return score;
}

function getProfileSlug(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/in\/([^/?#]+)/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

async function fillLinkedInDm(task) {
  injectBanner("Looking for LinkedIn message editor...");

  const onMessagingPage = window.location.href.includes("/messaging/");
  if (!onMessagingPage && !hasVisibleMessageComposerSurface()) {
    return {
      ok: false,
      error: "LinkedIn DM composer is not open on this profile page.",
      debug: collectDebugInfo(),
    };
  }

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
      "LinkedIn opened, but Penut could not find the DM editor.",
      true,
    );
    return {
      ok: false,
      error: "Could not find LinkedIn DM editor.",
      debug: collectDebugInfo(),
    };
  }

  const inserted = setEditorText(editor, task.messageDraft || "");
  if (!inserted) {
    injectBanner("Penut found the DM editor, but the draft did not insert.", true);
    return {
      ok: false,
      error: "Found LinkedIn DM editor, but draft insertion did not stick.",
      debug: collectDebugInfo(),
    };
  }
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
  while (Date.now() - started < 10000) {
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
    ".msg-form__contenteditable[contenteditable='true']",
    ".msg-form__contenteditable [contenteditable='true']",
    ".msg-form__contenteditable",
    ".msg-form__msg-content-container [contenteditable='true']",
    ".msg-form [contenteditable='true']",
    ".msg-form div[role='textbox']",
    ".msg-form textarea",
    ".ProseMirror[contenteditable='true']",
    '[aria-label*="Write a message" i]',
    '[aria-label*="Type a message" i]',
    '[role="textbox"]',
    '[data-placeholder*="Write a message" i]',
    '[data-placeholder*="Type a message" i]',
    '[contenteditable="true"]',
    "textarea",
  ].join(", ");
  const editors = Array.from(document.querySelectorAll(selector))
    .map(resolveEditableElement)
    .filter(Boolean);
  return pickBestEditor(editors);
}

function resolveEditableElement(element) {
  if (!(element instanceof HTMLElement)) return null;
  if (element.matches("textarea, [contenteditable='true'], [role='textbox']")) return element;
  return element.querySelector("textarea, [contenteditable='true'], [role='textbox']");
}

function pickBestEditor(editors) {
  const uniqueEditors = Array.from(new Set(editors)).filter(isUsableMessageEditor);
  if (!uniqueEditors.length) return null;

  return uniqueEditors
    .map((editor) => ({ editor, score: scoreMessageEditor(editor) }))
    .sort((a, b) => b.score - a.score)[0].editor;
}

function scoreMessageEditor(editor) {
  const rect = editor.getBoundingClientRect();
  const className = String(editor.className || "").toLowerCase();
  const label = [
    editor.getAttribute("aria-label"),
    editor.getAttribute("data-placeholder"),
    editor.closest("[aria-label]")?.getAttribute("aria-label"),
    editor.closest("[class]")?.className,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;
  if (editor.closest(".msg-form")) score += 100;
  if (editor.closest('[class*="msg-form"]')) score += 90;
  if (editor.closest('[class*="msg-"]')) score += 40;
  if (className.includes("msg-form")) score += 40;
  if (className.includes("prosemirror")) score += 30;
  if (label.includes("write a message") || label.includes("type a message")) score += 60;
  if (label.includes("message")) score += 25;
  if (rect.top > window.innerHeight * 0.35) score += 20;
  if (rect.width > 240) score += 10;
  return score;
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
    return editor.value === text;
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

  return normalizeText(editor.innerText || editor.textContent || "").includes(normalizeText(text).slice(0, 24));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
  const inStrictComposerSurface = Boolean(
    editor.closest(".msg-form") ||
      editor.closest('[class*="msg-form"]') ||
      editor.closest('[class*="msg-overlay-conversation"]'),
  );
  const inMessageSurface = Boolean(
    inStrictComposerSurface ||
      editor.closest('[class*="msg-"]') ||
      editor.closest('[class*="conversation"]') ||
      editor.closest('[data-view-name*="message" i]'),
  );

  const label = [
    editor.getAttribute("aria-label"),
    editor.getAttribute("data-placeholder"),
    editor.getAttribute("placeholder"),
    editor.className,
    editor.closest("[aria-label]")?.getAttribute("aria-label"),
    editor.closest("[class]")?.className,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const isLinkedInComposer =
    label.includes("write a message") ||
    label.includes("type a message") ||
    (onMessagingPage && label.includes("message")) ||
    inMessageSurface ||
    (onMessagingPage &&
      (editor.isContentEditable || editor.getAttribute("contenteditable") === "true") &&
      editor.getBoundingClientRect().top > window.innerHeight * 0.25) ||
    (!onMessagingPage && inStrictComposerSurface);

  return Boolean(isLinkedInComposer);
}

function hasVisibleMessageComposerSurface() {
  return Array.from(
    document.querySelectorAll(
      ".msg-form, [class*='msg-form'], [class*='msg-overlay-conversation']",
    ),
  ).some((element) => element instanceof HTMLElement && isVisible(element, 120, 40));
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
        href: element instanceof HTMLAnchorElement ? element.href : null,
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
