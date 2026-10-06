document.addEventListener("DOMContentLoaded", () => {
  const header = document.querySelector(".cl-header");
  if (!header) return;
  const button = header.querySelector(".cl-header-menu");
  const nav = header.querySelector(".cl-header-nav");
  const close = () => {
    button.setAttribute("aria-expanded", "false");
    nav.classList.remove("is-open");
  };
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("is-open", open);
  });
  nav
    .querySelectorAll("a")
    .forEach((link) => link.addEventListener("click", close));
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      button.getAttribute("aria-expanded") === "true"
    ) {
      close();
      button.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!header.contains(event.target)) close();
  });
});
