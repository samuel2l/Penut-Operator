import "dotenv/config";

import { getOperatorEnvironment } from "../../config/environment.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export class OpenAIClient {
  #apiKey;
  #model;

  constructor({
    apiKey,
    model,
  } = {}) {
    this.#apiKey = apiKey || process.env.OPENAI_API_KEY;
    this.#model = model || process.env.OPENAI_MODEL || "gpt-4.1-mini";
  }

  get configured() {
    return Boolean(this.#apiKey);
  }

  async createJsonResponse({ instructions, input, schema }) {
    if (!this.#apiKey) {
      throw new Error("Missing OPENAI_API_KEY. Add it to .env, then run Operator again.");
    }

    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.#model,
        instructions,
        input,
        text: {
          format: {
            type: "json_schema",
            name: "operator_action",
            strict: true,
            schema,
          },
        },
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || `OpenAI request failed with ${response.status}.`;
      throw new Error(message);
    }

    const text = extractOutputText(payload);
    if (!text) throw new Error("OpenAI returned no action.");
    return JSON.parse(text);
  }
}

export class PenutPlannerClient {
  #accessToken;
  #baseUrl;

  constructor({
    accessToken,
    baseUrl,
  } = {}) {
    this.#accessToken = accessToken || process.env.PENUT_OPERATOR_ACCESS_TOKEN;
    this.#baseUrl = baseUrl || getOperatorEnvironment().apiBaseUrl;
  }

  get configured() {
    return Boolean(this.#accessToken && this.#baseUrl);
  }

  async createJsonResponse({ input }) {
    if (!this.#accessToken) {
      throw new Error("Sign in to Penut before running Operator tasks.");
    }

    const request = JSON.parse(input);
    const response = await fetch(`${this.#baseUrl}/browser/planner/next-action`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        taskId: request.task?.remoteId || request.task?.id,
        task: {
          prompt: request.task?.prompt || "",
          intent: request.task?.intent || null,
        },
        observation: request.observation || {},
        recentHistory: request.recentHistory || [],
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        payload?.message ||
        payload?.error ||
        "Penut could not plan the next browser action.";
      throw new Error(message);
    }
    if (!payload?.action) {
      throw new Error("Penut returned no browser action.");
    }
    return payload.action;
  }
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;

  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return "";
}
