function initializeInstallDialog() {
  const dialog = document.querySelector("#installDialog");
  if (!dialog) return;

  document.querySelectorAll(".install-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      dialog.showModal();
    });
  });
  dialog
    .querySelector(".dialog-close")
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const outside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;
    if (outside) dialog.close();
  });
}

function initializeCartPreview() {
  const button = document.querySelector("#quickAdd");
  const toast = document.querySelector(".toast");
  if (!button || !toast) return;
  let dismissal;

  button.addEventListener("click", () => {
    const icon = button.querySelector("span");
    icon.textContent = "✓";
    button.replaceChildren("Added ", icon);
    button.classList.add("added");
    toast.classList.add("show");
    clearTimeout(dismissal);
    dismissal = setTimeout(() => toast.classList.remove("show"), 2600);
  });
}

initializeInstallDialog();
initializeCartPreview();
