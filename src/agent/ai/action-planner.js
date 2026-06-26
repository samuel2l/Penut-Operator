import { BrowserActionDescriptions, BrowserActions } from "../browser-actions.js";
import { OpenAIClient } from "./openai-client.js";

const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: Object.values(BrowserActions),
    },
    reason: {
      type: "string",
      description: "Short explanation for the log.",
    },
    url: {
      type: "string",
      description: "URL for open_url, otherwise empty.",
    },
    elementId: {
      type: "string",
      description: "Observed element id for click_element or type_text, otherwise empty.",
    },
    text: {
      type: "string",
      description: "Text for type_text or fail/pause/complete notes, otherwise empty.",
    },
    key: {
      type: "string",
      description: "Keyboard key for press_key, otherwise empty.",
    },
    direction: {
      type: "string",
      enum: ["down", "up", ""],
      description: "Scroll direction, otherwise empty.",
    },
    milliseconds: {
      type: "number",
      description: "Wait duration for wait, otherwise 0.",
    },
  },
  required: [
    "action",
    "reason",
    "url",
    "elementId",
    "text",
    "key",
    "direction",
    "milliseconds",
  ],
};

export class AIActionPlanner {
  #client;

  constructor({ client = new OpenAIClient() } = {}) {
    this.#client = client;
  }

  async nextAction({ task, observation, history }) {
    return this.#client.createJsonResponse({
      instructions: buildInstructions(),
      input: JSON.stringify({
        task: {
          prompt: task.prompt,
          safetyMode: task.safetyMode,
        },
        observation: compactObservation(observation),
        recentHistory: history.slice(-8),
      }),
      schema: ACTION_SCHEMA,
    });
  }
}

function buildInstructions() {
  return [
    "You are Penut Operator, a local browser-control agent.",
    "Choose exactly one next browser action as JSON.",
    "Use only the provided observed element ids. Do not invent element ids.",
    "Prefer visible on-page controls over guessing.",
    "If the page is not the right site, use open_url.",
    "Do not call open_url for the current page or a URL already opened in recentHistory. If the page is already correct, interact with it.",
    "If a page needs time to update, use wait.",
    "Do not use wait more than twice in a row; if nothing changes, choose a different action or fail.",
    "Do not type drafted messages into search boxes, global search fields, browser navigation fields, or site navigation fields.",
    "When a recipient/name autocomplete appears, choose the matching suggestion before typing a message body.",
    "Do not use a global navigation link, such as Messaging/Inbox, as a substitute for a page-specific Message/Compose control unless the task explicitly asks to open the inbox.",
    "If you click an element and the page does not change, choose a different element, scroll, or fail. Do not repeat the same click.",
    "Only use pause_for_user after the requested draft is visibly placed in a plausible composer/editor, or when a final sensitive click is needed.",
    "Never click a final Send, Post, Reply, Comment, Publish, or Submit action unless the safety mode explicitly allows final sending.",
    "For prepare_only or step approval, fill drafts but use pause_for_user before final send/post.",
    "When the requested safe end state is reached, use complete.",
    "When blocked, use fail with a concise human-readable reason.",
    "",
    "Allowed actions:",
    ...BrowserActionDescriptions,
  ].join("\n");
}

function compactObservation(observation) {
  return {
    url: observation.url,
    title: observation.title,
    visibleText: observation.visibleText?.slice(0, 2500) || "",
    elements: (observation.elements || []).slice(0, 60).map((element) => ({
      id: element.id,
      tag: element.tag,
      role: element.role,
      label: element.label,
      href: element.href,
      editable: element.editable,
      clickable: element.clickable,
      searchLike: element.searchLike,
    })),
  };
}
