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

      await report(
        "failed",
        directFill?.error ||
          "LinkedIn composer opened, but the DM editor could not be filled.",
        directFill,
      );
      return;
    }

    await report("profile_opened", "LinkedIn profile loaded. Preparing to open message composer.");
    const extracted = await sendMessageWithRetry(profileTab.id, {
      type: "PENUT_EXTRACT_LINKEDIN_PROFILE_URN",
      task,
    }).catch((error) => ({ ok: false, error: error.message || String(error) }));

    if (extracted?.ok && extracted.messagingUrl) {
      await report("opening_composer", "Extracted LinkedIn member id. Opening DM composer directly.", {
        messagingUrl: extracted.messagingUrl,
        urn: extracted.urn,
      });
      await cacheRecipientUrl(task, extracted.messagingUrl);
      const composerTab = await openOrFocusTab(extracted.messagingUrl);
      await waitForTabReady(composerTab.id);
      const extractedFill = await sendMessageToLinkedInFrames(composerTab.id, {
        type: "PENUT_FILL_LINKEDIN_DM",
        task,
      });

      if (extractedFill?.ok) {
        await reportPrepared(extractedFill);
        return;
      }

      await report(
        "failed",
        extractedFill?.error ||
          "Opened LinkedIn DM composer from extracted member id, but could not fill the editor.",
        extractedFill,
      );
      return;
    }

    await report("opening_composer", "Could not extract member id. Trying profile Message button.", extracted);
    const openResponse = await sendMessageWithRetry(profileTab.id, {
      type: "PENUT_OPEN_LINKEDIN_DM_COMPOSER",
      task,
    }).catch((error) => ({ ok: false, possibleNavigation: true, error: error.message || String(error) }));

    if (!openResponse?.ok) {
      const possibleComposerTab = await waitForLinkedInComposerTab(profileTab.id);
      if (possibleComposerTab?.url?.includes("linkedin.com/messaging/")) {
        await cacheRecipientUrl(task, possibleComposerTab.url);
        const possibleFill = await sendMessageToLinkedInFrames(possibleComposerTab.id, {
          type: "PENUT_FILL_LINKEDIN_DM",
          task,
        });
        if (possibleFill?.ok) {
          await report("composer_opened", "LinkedIn DM composer opened after Message click.", {
            url: possibleComposerTab.url,
          });
          await reportPrepared(possibleFill);
          return;
        }
      }

      await report(
        "failed",
        openResponse?.error ||
          "Could not open LinkedIn DM composer from this connected profile.",
        openResponse,
      );
      return;
    }

    if (openResponse.messagingUrl) {
      await cacheRecipientUrl(task, openResponse.messagingUrl);
      await report("opening_composer", "Opening LinkedIn DM composer from Message link.", {
        messagingUrl: openResponse.messagingUrl,
      });
      const linkedComposerTab = await openOrFocusTab(openResponse.messagingUrl);
      await waitForTabReady(linkedComposerTab.id);
      const linkedFill = await sendMessageToLinkedInFrames(linkedComposerTab.id, {
        type: "PENUT_FILL_LINKEDIN_DM",
        task,
      });

      if (linkedFill?.ok) {
        await reportPrepared(linkedFill);
        return;
      }

      await report(
        "failed",
        linkedFill?.error ||
          "Opened LinkedIn DM composer from Message link, but could not fill the editor.",
        linkedFill,
      );
      return;
    }

    await report("opening_composer", "Message button clicked. Waiting for LinkedIn composer.");
    await sleep(500);
    const discoveredTab = await waitForLinkedInComposerTab(profileTab.id);
    if (discoveredTab?.url?.includes("linkedin.com/messaging/")) {
      await cacheRecipientUrl(task, discoveredTab.url);
      await report("composer_opened", "Discovered and cached LinkedIn DM composer URL.", {
        url: discoveredTab.url,
      });
    }

    const fillTab = discoveredTab || profileTab;
    if (fillTab.id === profileTab.id && !fillTab.url?.includes("linkedin.com/messaging/")) {
      const overlayReady = await sendMessageWithRetry(profileTab.id, {
        type: "PENUT_HAS_LINKEDIN_DM_COMPOSER",
      }).catch(() => ({ ok: false }));
      if (!overlayReady?.ok) {
        await report(
          "failed",
          "Clicked Message, but LinkedIn did not open a detectable DM composer.",
          overlayReady,
        );
        return;
      }
    }

    const profileFill = await sendMessageToLinkedInFrames(fillTab.id, {
      type: "PENUT_FILL_LINKEDIN_DM",
      task,
    }).catch((error) => ({ ok: false, error: error.message || String(error) }));

    if (profileFill?.ok) {
      await reportPrepared(profileFill);
      return;
    }

    const composeTab = fillTab.id === profileTab.id ? await waitForLinkedInComposerTab(profileTab.id) : fillTab;
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
    } else {
      await report(
        "failed",
        response?.error || "LinkedIn DM composer did not open or could not be filled.",
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

  while (Date.now() - started < 8000) {
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

async function cacheRecipientUrl(task, messagingUrl) {
  const profileUrl = task.target?.profileUrl;
  if (!profileUrl || !messagingUrl) return;
  await fetch(`${BRIDGE}/api/extension/cache-recipient`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileUrl, messagingUrl }),
  }).catch(() => {});
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
          if (!bestFailure) bestFailure = response;
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
