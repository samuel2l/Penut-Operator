export const BrowserActions = Object.freeze({
  OpenUrl: "open_url",
  ClickElement: "click_element",
  TypeText: "type_text",
  PressKey: "press_key",
  Scroll: "scroll",
  Wait: "wait",
  PauseForUser: "pause_for_user",
  Complete: "complete",
  Fail: "fail",
});

export const BrowserActionDescriptions = [
  "open_url: Navigate Chrome to a URL.",
  "click_element: Click a visible observed element by elementId.",
  "type_text: Type text into a visible observed input/editor by elementId.",
  "press_key: Press a keyboard key such as Enter, Escape, Tab.",
  "scroll: Scroll the current page up or down.",
  "wait: Wait briefly for the page to update.",
  "pause_for_user: Stop before a sensitive final action or when human review is needed.",
  "complete: Mark the task complete after the requested safe end state is reached.",
  "fail: Stop with a human-readable reason when the task cannot continue safely.",
];
