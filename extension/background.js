const BRIDGE = "http://127.0.0.1:4877";
const POLL_ALARM = "penut-operator-poll";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void pollForTask();
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

async function pollForTask() {
  const response = await fetch(`${BRIDGE}/api/extension/next-task`);
  if (!response.ok) return;
  const { task } = await response.json();
  if (!task) return;
  await report("running", `Starting ${task.platform} ${task.action} task.`);
  await runLinkedInTask(task);
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

  const tab = await chrome.tabs.create({ url: targetUrl, active: true });
  await waitForTabComplete(tab.id);

  try {
    const response = await sendMessageWithRetry(tab.id, {
      type: "PENUT_PREPARE_LINKEDIN_DM",
      task,
    });
    if (response?.ok) {
      await report(
        "prepared_waiting_final_confirmation",
        "LinkedIn DM draft prepared. User must review and send manually.",
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

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1500);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendMessageWithRetry(tabId, message) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      await sleep(750);
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
