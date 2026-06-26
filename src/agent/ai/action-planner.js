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
    "Recent history may include rejected actions. Do not repeat rejected actions; choose a different route.",
    "Prefer visible on-page controls over guessing.",
    "If the page is not the right site, use open_url.",
    "For a task addressed to a specific person, prefer opening/searching that person's profile or a direct compose page over opening a generic inbox. A direct search URL is acceptable.",
    "Do not assume the currently selected inbox thread is the intended recipient unless the visible page clearly shows the recipient name.",
    "Do not call open_url for the current page or a URL already opened in recentHistory. If the page is already correct, interact with it.",
    "If a page needs time to update, use wait.",
    "If observation has no useful elements or visible text after navigation, use wait rather than fail.",
    "Do not use wait more than twice in a row; if nothing changes, choose a different action or fail.",
    "Do not type drafted messages into search boxes, global search fields, browser navigation fields, or site navigation fields.",
    "When a recipient/name autocomplete appears, choose the matching suggestion before typing a message body.",
    "Do not use a global navigation link, such as Messaging/Inbox, as a substitute for a page-specific Message/Compose control unless the task explicitly asks to open the inbox.",
    "If you click an element and the page does not change, choose a different element, scroll, or fail. Do not repeat the same click.",
    "Follow the user's instruction literally: if they ask to send/post/reply, complete the final action; if they ask to draft, prepare, review, pause, or not send, use pause_for_user before the final action.",
    "Only use pause_for_user when the user requested review/pause/prepare-only behavior, when the requested draft is visibly placed in a plausible composer/editor, or when you are blocked and need user input.",
    "A Message or Compose button that opens a draft composer is not a final Send action.",
    "After clicking a Message/Compose link, observe or wait for the real composer. Do not invent element ids for composer inputs.",
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
    elements: (observation.elements || []).slice(0, 100).map((element) => ({
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
