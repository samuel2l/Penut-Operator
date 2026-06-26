import "dotenv/config";

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
