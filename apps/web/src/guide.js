import "./page-toc.js";

const modal = document.querySelector(".guide-image-modal");
const preview = modal.querySelector(".guide-image-view img");
const view = modal.querySelector(".guide-image-view");
const description = modal.querySelector(".guide-image-description");
const zoom = modal.querySelector(".guide-image-zoom");
let trigger;
let previousOverflow;

document.querySelectorAll(".guide-screenshot > a").forEach((link) => {
  link.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    trigger = link;
    preview.src = link.href;
    preview.alt = link.querySelector("img").alt;
    description.textContent = preview.alt;
    modal.classList.remove("is-zoomed");
    zoom.textContent = "Zoom in";
    zoom.setAttribute("aria-pressed", "false");
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modal.showModal();
    view.scrollTop = view.scrollLeft = 0;
  });
});

zoom.addEventListener("click", () => {
  const zoomed = modal.classList.toggle("is-zoomed");
  zoom.textContent = zoomed ? "Fit image" : "Zoom in";
  zoom.setAttribute("aria-pressed", String(zoomed));
});
modal
  .querySelector(".guide-image-close")
  .addEventListener("click", () => modal.close());
modal.addEventListener("click", (event) => {
  const bounds = modal.getBoundingClientRect();
  if (
    event.target === modal &&
    (event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom)
  )
    modal.close();
});
modal.addEventListener("close", () => {
  document.body.style.overflow = previousOverflow;
  preview.removeAttribute("src");
  trigger?.focus({ preventScroll: true });
});
