const BRIDGE = "http://127.0.0.1:4877";
const POLL_ALARM = "penut-operator-poll";
const FAST_POLL_MS = 750;

let fastPollTimer = null;
let isPolling = false;
let isRunningTask = false;
let isLongPolling = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  startFastPolling();
  startLongPolling();
});

chrome.runtime.onStartup.addListener(() => {
  startFastPolling();
  startLongPolling();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    startFastPolling();
    startLongPolling();
    void pollForTask();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PENUT_OPERATOR_POLL_NOW") {
    pollForTask()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});

startFastPolling();
startLongPolling();

function startFastPolling() {
  if (fastPollTimer) return;
  const tick = () => {
    void pollForTask();
    fastPollTimer = setTimeout(tick, FAST_POLL_MS);
  };
  fastPollTimer = setTimeout(tick, 150);
}

async function startLongPolling() {
  if (isLongPolling) return;
  isLongPolling = true;

  while (isLongPolling) {
    if (isRunningTask) {
      await sleep(500);
      continue;
    }

    try {
      const response = await fetch(`${BRIDGE}/api/extension/wait-task`);
      if (!response.ok) {
        await sleep(1000);
        continue;
      }

      const { task } = await response.json();
      if (!task) continue;

      isRunningTask = true;
      await report("running", `Starting ${task.platform} ${task.action} task.`);
      try {
        await runLinkedInTask(task);
      } finally {
        isRunningTask = false;
      }
    } catch {
      await sleep(1000);
    }
  }
}

async function pollForTask() {
  if (isPolling || isRunningTask) return;
  isPolling = true;
  let task = null;
  try {
  const response = await fetch(`${BRIDGE}/api/extension/next-task`);
  if (!response.ok) return;
  ({ task } = await response.json());
  if (!task) return;
  } catch {
    return;
  } finally {
    isPolling = false;
  }

  isRunningTask = true;
  await report("running", `Starting ${task.platform} ${task.action} task.`);
  try {
    await runLinkedInTask(task);
  } finally {
    isRunningTask = false;
  }
}

async function runLinkedInTask(task) {
  if (task.platform !== "linkedin" || task.action !== "send_dm") {
    await report("failed", `Unsupported task: ${task.platform}.${task.action}`);
    return;
  }

  const targetUrl = task.target?.profileUrl;
  if (!targetUrl) {
    await report("failed", "LinkedIn task is missing target profile URL.");
    return;
  }

  const directMessagingUrl = task.target?.messagingUrl;
  const startUrl = directMessagingUrl || targetUrl;
  await report(
    directMessagingUrl ? "opening_composer" : "opening_profile",
    directMessagingUrl
      ? `Opening LinkedIn DM composer for ${task.target?.name || "lead"}.`
      : `Opening LinkedIn profile for ${task.target?.name || "lead"}.`,
  );
  const profileTab = await openOrFocusTab(startUrl);
  await waitForTabReady(profileTab.id);

  try {
    if (directMessagingUrl) {
      await report("composer_opened", "LinkedIn DM composer URL opened.", {
        url: directMessagingUrl,
      });
      const directFill = await sendMessageToLinkedInFrames(profileTab.id, {
        type: "PENUT_FILL_LINKEDIN_DM",
        task,
      });

      if (directFill?.ok) {
        await reportPrepared(directFill);
        return;
      }

      await copyDraftToClipboard(profileTab.id, task.messageDraft || "");
      await report(
        "needs_manual_paste",
        directFill?.error ||
          "LinkedIn composer opened, but the editor could not be filled. Draft copied for manual paste.",
        directFill,
      );
      return;
    }

    await report("profile_opened", "LinkedIn profile loaded. Preparing to open message composer.");
    const openResponse = await sendMessageWithRetry(profileTab.id, {
      type: "PENUT_OPEN_LINKEDIN_DM_COMPOSER",
      task,
    });

    if (!openResponse?.ok) {
      await copyDraftToClipboard(profileTab.id, task.messageDraft || "");
      await report(
        "needs_manual_paste",
        openResponse?.error ||
          "Could not open LinkedIn composer. Draft copied to clipboard for manual paste.",
        openResponse,
      );
      return;
    }

    await report("opening_composer", "Message button clicked. Waiting for LinkedIn composer.");
    await sleep(500);
    const profileFill = await sendMessageToLinkedInFrames(profileTab.id, {
      type: "PENUT_FILL_LINKEDIN_DM",
      task,
    }).catch((error) => ({ ok: false, error: error.message || String(error) }));

    if (profileFill?.ok) {
      await reportPrepared(profileFill);
      return;
    }

    const composeTab = await waitForLinkedInComposerTab(profileTab.id);
    if (composeTab.id !== profileTab.id) {
      await report("composer_opened", "Composer opened in a LinkedIn messaging tab.", {
        tabId: composeTab.id,
      });
    }

    const response =
      composeTab.id === profileTab.id
        ? profileFill
        : await sendMessageToLinkedInFrames(composeTab.id, {
            type: "PENUT_FILL_LINKEDIN_DM",
            task,
          });

    if (response?.ok) {
      await reportPrepared(response);
    } else if (response?.fallback === "clipboard") {
      await copyDraftToClipboard(composeTab.id, task.messageDraft || "");
      await report(
        "needs_manual_paste",
        "LinkedIn opened, but the editor could not be filled. Draft copied to clipboard for manual paste.",
        response,
      );
    } else {
      await report(
        "failed",
        response?.error || "LinkedIn content script could not prepare the DM.",
        response,
      );
    }
  } catch (error) {
    await report("failed", `Extension failed: ${error.message || error}`);
  }
}

async function openOrFocusTab(url) {
  const existingTabs = await chrome.tabs.query({ url });
  const existing = existingTabs[0];
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true, url });
    return chrome.tabs.get(existing.id);
  }
  return chrome.tabs.create({ url, active: true });
}

async function waitForLinkedInComposerTab(profileTabId) {
  const started = Date.now();
  let lastProfileTab = await chrome.tabs.get(profileTabId);

  while (Date.now() - started < 1800) {
    const profileTab = await chrome.tabs.get(profileTabId).catch(() => null);
    if (profileTab?.url?.includes("linkedin.com/messaging/")) {
      await waitForTabReady(profileTab.id);
      return profileTab;
    }
    if (profileTab) lastProfileTab = profileTab;

    const tabs = await chrome.tabs.query({
      url: ["https://www.linkedin.com/messaging/*"],
    });
    const activeMessagingTab =
      tabs.find((tab) => tab.active) ||
      tabs.sort((a, b) => (b.id || 0) - (a.id || 0))[0];

    if (activeMessagingTab) {
      await chrome.tabs.update(activeMessagingTab.id, { active: true });
      await waitForTabReady(activeMessagingTab.id);
      return activeMessagingTab;
    }

    await sleep(200);
  }

  return lastProfileTab;
}

async function copyDraftToClipboard(tabId, text) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    args: [text],
    func: async (draft) => {
      let copied = false;
      try {
        await navigator.clipboard.writeText(draft);
        copied = true;
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = draft;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.documentElement.append(textarea);
        textarea.select();
        copied = document.execCommand("copy");
        textarea.remove();
      }
      return copied;
    },
  });

  const copied = results.some((result) => result.result === true);
  if (!copied) await showManualFallback(tabId, text);
  return copied;
}

async function waitForTabReady(tabId) {
  const started = Date.now();
  while (Date.now() - started < 2200) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      await sleep(100);
      return;
    }
    await sleep(100);
  }
}

async function reportPrepared(response) {
  if (response.finalSendClicked) {
    await report("sent", "LinkedIn DM sent after approval.", response);
    return;
  }

  await report(
    "prepared_waiting_final_confirmation",
    "LinkedIn DM draft prepared. User must review and send manually.",
    response,
  );
}

async function sendMessageToLinkedInFrames(tabId, message) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  const linkedinFrames = frames
    .filter((frame) => frame.url?.startsWith("https://www.linkedin.com/"))
    .sort((a, b) => {
      if (a.frameId === 0) return -1;
      if (b.frameId === 0) return 1;
      return a.frameId - b.frameId;
    });

  const frameIds = linkedinFrames.length ? linkedinFrames.map((frame) => frame.frameId) : [0];
  return new Promise((resolve) => {
    let pending = frameIds.length;
    let bestFailure = null;

    for (const frameId of frameIds) {
      sendMessageWithRetry(tabId, message, frameId)
        .then((response) => {
          if (response?.ok) {
            resolve(response);
            return;
          }
          if (response?.fallback === "clipboard") bestFailure = response;
          else if (!bestFailure) bestFailure = response;
        })
        .catch((error) => {
          if (!bestFailure) bestFailure = { ok: false, error: error.message || String(error) };
        })
        .finally(() => {
          pending -= 1;
          if (pending === 0) {
            resolve(bestFailure || { ok: false, error: "No LinkedIn frame could handle the task." });
          }
        });
    }
  });
}

async function sendMessageWithRetry(tabId, message, frameId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const options = typeof frameId === "number" ? { frameId } : undefined;
      return options
        ? await chrome.tabs.sendMessage(tabId, message, options)
        : await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      await sleep(150);
    }
  }
  throw new Error("Could not reach LinkedIn content script.");
}

async function showManualFallback(tabId, text) {
  await sendMessageToLinkedInFrames(tabId, {
    type: "PENUT_SHOW_MANUAL_FALLBACK",
    text,
  }).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function report(status, message, detail = {}) {
  await fetch(`${BRIDGE}/api/extension/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, message, detail }),
  }).catch(() => {});
}
