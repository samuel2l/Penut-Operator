const status = document.querySelector("#status");
document.querySelector("#poll").addEventListener("click", () => {
  status.textContent = "Checking...";
  chrome.runtime.sendMessage({ type: "PENUT_OPERATOR_POLL_NOW" }, (response) => {
    status.textContent = response?.ok
      ? "Checked local operator shell."
      : response?.error || "Unable to check.";
  });
});
