import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const PORT = Number(process.env.PORT || 4877);
const ROOT = resolve(import.meta.dirname, "..");
const PUBLIC_DIR = join(import.meta.dirname, "public");
const TASK_FILE = join(ROOT, "tasks", "mock-linkedin-dm.json");
const CACHE_FILE = join(ROOT, "tasks", "linkedin-recipient-cache.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let task = JSON.parse(await readFile(TASK_FILE, "utf8"));
let events = [
  event("system", "Loaded mock LinkedIn DM task."),
];
let extensionWaiters = [];
let recipientCache = await readRecipientCache();

function event(type, message, extra = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    message,
    at: new Date().toISOString(),
    ...extra,
  };
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function publicTask() {
  const profileUrl = normalizeLinkedInProfileUrl(task.target?.profileUrl);
  const cachedMessagingUrl = profileUrl ? recipientCache[profileUrl] : undefined;
  return {
    ...task,
    target: {
      ...task.target,
      messagingUrl: task.target?.messagingUrl || cachedMessagingUrl,
      cachedMessagingUrl,
    },
    events,
  };
}

function updateTask(patch, message) {
  task = {
    ...task,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  events = [event("task", message), ...events].slice(0, 50);
}

function claimExtensionTask() {
  if (task.status !== "approved_waiting_for_extension") return null;
  const nextTask = publicTask();
  updateTask({ status: "claimed_by_extension" }, "Extension claimed task.");
  return nextTask;
}

function wakeExtensionWaiters() {
  const readyTask = claimExtensionTask();
  if (!readyTask) return;
  const waiters = extensionWaiters;
  extensionWaiters = [];
  for (const waiter of waiters) waiter(readyTask);
}

function waitForExtensionTask(timeoutMs = 25000) {
  const readyTask = claimExtensionTask();
  if (readyTask) return Promise.resolve(readyTask);

  return new Promise((resolve) => {
    const waiter = (nextTask) => {
      clearTimeout(timeout);
      resolve(nextTask);
    };
    const timeout = setTimeout(() => {
      extensionWaiters = extensionWaiters.filter((item) => item !== waiter);
      resolve(null);
    }, timeoutMs);
    extensionWaiters.push(waiter);
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/task" && req.method === "GET") {
      return json(res, 200, { task: publicTask() });
    }

    if (url.pathname === "/api/task/reset" && req.method === "POST") {
      task = JSON.parse(await readFile(TASK_FILE, "utf8"));
      events = [event("system", "Reset mock LinkedIn DM task.")];
      return json(res, 200, { task: publicTask() });
    }

    if (url.pathname === "/api/task/update" && req.method === "POST") {
      const body = await readBody(req);
      const messageDraft =
        typeof body.messageDraft === "string"
          ? body.messageDraft.trim()
          : task.messageDraft;
      const profileUrl =
        typeof body.profileUrl === "string"
          ? normalizeLinkedInProfileUrl(body.profileUrl)
          : task.target?.profileUrl;
      const targetName =
        typeof body.targetName === "string" && body.targetName.trim()
          ? body.targetName.trim()
          : task.target?.name;
      const target = {
        ...task.target,
        name: targetName,
        profileUrl,
      };
      if (profileUrl !== normalizeLinkedInProfileUrl(task.target?.profileUrl)) {
        delete target.messagingUrl;
      }
      updateTask({ messageDraft, target }, "Task updated in operator shell.");
      return json(res, 200, { task: publicTask() });
    }

    if (url.pathname === "/api/task/approve" && req.method === "POST") {
      updateTask(
        { status: "approved_waiting_for_run" },
        "Task approved. Ready for local browser execution.",
      );
      return json(res, 200, { task: publicTask() });
    }

    if (url.pathname === "/api/task/reject" && req.method === "POST") {
      updateTask({ status: "rejected" }, "Task rejected by account owner.");
      return json(res, 200, { task: publicTask() });
    }

    if (url.pathname === "/api/task/run" && req.method === "POST") {
      if (!["approved_waiting_for_run", "failed"].includes(task.status)) {
        return json(res, 409, {
          error: "Task must be approved before it can run.",
          task: publicTask(),
        });
      }
      updateTask(
        { status: "approved_waiting_for_extension" },
        "Task released to browser extension.",
      );
      wakeExtensionWaiters();
      return json(res, 200, { task: publicTask() });
    }

    if (url.pathname === "/api/extension/next-task" && req.method === "GET") {
      return json(res, 200, { task: claimExtensionTask() });
    }

    if (url.pathname === "/api/extension/wait-task" && req.method === "GET") {
      const nextTask = await waitForExtensionTask();
      return json(res, 200, { task: nextTask });
    }

    if (url.pathname === "/api/extension/events" && req.method === "POST") {
      const body = await readBody(req);
      const status = typeof body.status === "string" ? body.status : undefined;
      const message =
        typeof body.message === "string" ? body.message : "Extension update.";
      const detail = compactDetail(body.detail);
      events = [
        event("extension", message, { status, detail }),
        ...events,
      ].slice(0, 50);
      if (status) task = { ...task, status, updatedAt: new Date().toISOString() };
      return json(res, 200, { task: publicTask() });
    }

    if (url.pathname === "/api/extension/cache-recipient" && req.method === "POST") {
      const body = await readBody(req);
      const profileUrl = normalizeLinkedInProfileUrl(body.profileUrl);
      const messagingUrl =
        typeof body.messagingUrl === "string" && body.messagingUrl.includes("/messaging/")
          ? body.messagingUrl
          : "";
      if (!profileUrl || !messagingUrl) {
        return json(res, 400, { error: "profileUrl and messagingUrl are required." });
      }

      recipientCache = {
        ...recipientCache,
        [profileUrl]: messagingUrl,
      };
      await writeRecipientCache(recipientCache);
      if (normalizeLinkedInProfileUrl(task.target?.profileUrl) === profileUrl) {
        task = {
          ...task,
          target: {
            ...task.target,
            messagingUrl,
          },
          updatedAt: new Date().toISOString(),
        };
      }
      events = [
        event("extension", "Cached LinkedIn DM composer URL for this profile.", {
          status: "cached_recipient",
          detail: { profileUrl, messagingUrl },
        }),
        ...events,
      ].slice(0, 50);
      return json(res, 200, { task: publicTask() });
    }

    return serveStatic(req, res);
  } catch (error) {
    return json(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

async function readRecipientCache() {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeRecipientCache(cache) {
  await writeFile(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
}

function normalizeLinkedInProfileUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    if (parsed.hostname === "linkedin.com") parsed.hostname = "www.linkedin.com";
    if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function compactDetail(detail) {
  if (!detail || typeof detail !== "object") return detail;
  if (!detail.debug) return detail;

  return {
    ...detail,
    debug: {
      url: detail.debug.url,
      title: detail.debug.title,
      activeElement: detail.debug.activeElement,
      visibleCandidateCount: detail.debug.visibleCandidateCount,
      visibleCandidates: detail.debug.visibleCandidates,
    },
  };
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Penut Operator prototype running at http://127.0.0.1:${PORT}`);
});
