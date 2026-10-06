(() => {
  const key = "cravelens.theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let choice = "system";
  try {
    choice = localStorage.getItem(key) || "system";
  } catch {}
  const valid = (value) =>
    ["system", "light", "dark"].includes(value) ? value : "system";
  function apply(value) {
    choice = valid(value);
    const theme =
      choice === "system" ? (media.matches ? "dark" : "light") : choice;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelectorAll("[data-theme-choice]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.themeChoice === choice),
      );
    });
    document.dispatchEvent(
      new CustomEvent("cravelens:theme", { detail: { theme, choice } }),
    );
  }
  apply(choice);
  document.addEventListener("DOMContentLoaded", () => {
    apply(choice);
    const icons = {
      system: "M3 4h18v13H3z M8 21h8 M12 17v4",
      light:
        "M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5 M16 12a4 4 0 1 1-8 0a4 4 0 1 1 8 0",
      dark: "M20.9 13.4A9 9 0 0 1 10.6 3.1A9 9 0 1 0 20.9 13.4Z",
    };
    document.querySelectorAll("[data-theme-switcher]").forEach((group) => {
      group.className = "theme-control";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Color theme");
      for (const mode of ["system", "light", "dark"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.themeChoice = mode;
        button.title = `${mode[0].toUpperCase() + mode.slice(1)} theme`;
        button.setAttribute("aria-label", button.title);
        const icon = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        icon.classList.add("theme-icon");
        icon.setAttribute("aria-hidden", "true");
        icon.setAttribute("viewBox", "0 0 24 24");
        const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        path.setAttribute("d", icons[mode]);
        icon.append(path);
        const label = document.createElement("span");
        label.className = "theme-label";
        label.textContent = mode[0].toUpperCase() + mode.slice(1);
        button.append(icon, label);
        button.addEventListener("click", () => {
          try {
            localStorage.setItem(key, mode);
          } catch {}
          apply(mode);
        });
        group.append(button);
      }
    });
    apply(choice);
  });
  media.addEventListener("change", () => {
    if (choice === "system") apply(choice);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === key) apply(event.newValue || "system");
  });
})();
