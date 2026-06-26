export function createLinkedInDmPlanner(task) {
  const parsed = parseLinkedInDmPrompt(task.prompt);
  const messageDraft = buildDraft(parsed);

  return {
    kind: "linkedin_dm",
    parsed,
    steps: [
      {
        action: "goto",
        target: "https://www.linkedin.com",
        message: "Opening LinkedIn in Chrome.",
      },
      {
        action: "wait_for_page",
        target: "LinkedIn",
        message: "Waiting for LinkedIn to load.",
      },
      {
        action: "search_linkedin",
        target: parsed.recipient,
        message: `Searching LinkedIn for ${parsed.recipient}.`,
      },
      {
        action: "open_best_profile_match",
        target: parsed.recipient,
        message: "Opening the most likely profile match.",
      },
      {
        action: "open_message_composer",
        target: parsed.recipient,
        message: "Opening the LinkedIn message composer.",
      },
      {
        action: "type_message",
        target: messageDraft,
        message: "Typing the DM draft.",
      },
      {
        action: "pause_before_send",
        message: "Pausing before final Send for user review.",
      },
    ],
  };
}

function parseLinkedInDmPrompt(prompt) {
  const normalized = String(prompt || "").replace(/\s+/g, " ").trim();
  const recipient =
    normalized.match(/(?:dm|message)\s+(?:to\s+)?(.+?)\s+(?:about|regarding|on)\s+/i)?.[1] ||
    normalized.match(/(?:dm|message)\s+(?:to\s+)?(.+?)(?:\.|$)/i)?.[1] ||
    "the target person";
  const topic =
    normalized.match(/\b(?:about|regarding|on)\s+(.+?)(?:\.|$)/i)?.[1] ||
    "the requested topic";

  return {
    recipient: recipient.trim(),
    topic: topic.trim(),
  };
}

function buildDraft({ recipient, topic }) {
  const firstName = recipient.split(/\s+/)[0] || "there";
  return `Hey ${firstName}, I wanted to reach out about ${topic}. Would be happy to share more context if useful.`;
}
