const API_BASE_URLS = Object.freeze({
  local: "http://localhost:3000/",
  dev: "https://dev.penut.ai/",
  prod: "https://penut.ai/",
});

export function getOperatorEnvironment() {
  const requestedChannel = String(process.env.PENUT_OPERATOR_CHANNEL || "").trim().toLowerCase();
  const isPackagedElectron = Boolean(process.versions?.electron && !process.defaultApp);
  const inferredChannel = isPackagedElectron ? "prod" : "local";
  const channel = ["local", "dev", "prod"].includes(requestedChannel)
    ? requestedChannel
    : inferredChannel;
  const explicitBaseUrl = String(process.env.PENUT_API_BASE_URL || "").trim();
  return {
    channel,
    apiBaseUrl: normalizeApiBaseUrl(explicitBaseUrl || API_BASE_URLS[channel]),
    plannerMode: getPlannerMode(channel),
  };
}

export function shouldUseBackendPlanner() {
  return getOperatorEnvironment().plannerMode === "backend";
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
