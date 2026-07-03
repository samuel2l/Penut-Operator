const API_BASE_URLS = Object.freeze({
  local: "http://localhost:3000/",
  dev: "https://dev.penut.ai/",
  prod: "https://penut.ai/",
});

export function getOperatorEnvironment() {
  const requestedChannel = String(process.env.PENUT_OPERATOR_CHANNEL || "").trim().toLowerCase();
  const isPackagedElectron = Boolean(process.versions?.electron && !process.defaultApp);
  const inferredChannel = isPackagedElectron ? "prod" : "local";
  const explicitChannel = ["local", "dev", "prod"].includes(requestedChannel)
    ? requestedChannel
    : null;
  const channel = explicitChannel || inferredChannel;
  const explicitBaseUrl = String(process.env.PENUT_API_BASE_URL || "").trim();
  const channelBaseUrl = API_BASE_URLS[channel];
  const apiBaseUrl = resolveApiBaseUrl({
    channel,
    explicitChannel,
    explicitBaseUrl,
    channelBaseUrl,
  });
  return {
    channel,
    apiBaseUrl,
    plannerMode: getPlannerMode(channel),
    simulatePackaged: isSimulatingPackaged(),
  };
}

function resolveApiBaseUrl({ channel, explicitChannel, explicitBaseUrl, channelBaseUrl }) {
  // Local dev can override the API host via .env (for ngrok, etc.).
  if (channel === "local" && explicitBaseUrl && !isSimulatingPackaged()) {
    return normalizeApiBaseUrl(explicitBaseUrl);
  }
  // dev:prod / dev:dev / packaged builds should use the channel URL even if
  // PENUT_API_BASE_URL is set in .env for local work.
  if (explicitChannel && explicitChannel !== "local") {
    return normalizeApiBaseUrl(channelBaseUrl);
  }
  return normalizeApiBaseUrl(explicitBaseUrl || channelBaseUrl);
}

export function shouldUseBackendPlanner() {
  return getOperatorEnvironment().plannerMode === "backend";
}

export function isSimulatingPackaged() {
  return process.env.PENUT_OPERATOR_SIMULATE_PACKAGED === "1";
}

export function shouldLoadDotenv() {
  return !isSimulatingPackaged();
}

export function normalizeApiBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (raw.endsWith("/api")) return raw;
  if (raw.endsWith("/api/platform")) return raw.replace(/\/platform$/, "");
  return `${raw}/api`;
}

function getPlannerMode(channel) {
  const requested = String(process.env.PENUT_OPERATOR_PLANNER || "").trim().toLowerCase();
  if (["backend", "local"].includes(requested)) return requested;
  return channel === "local" ? "local" : "backend";
}
