document.addEventListener("DOMContentLoaded", () => {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!("IntersectionObserver" in window)) return;
  const selector =
    ".hero-copy, .hero-visual, .policy-hero, .policy-content > section, .policy-toc, .story-heading, .story-panel, .story-tech, .creator-note, .step-card, .feature-copy, .preference-card, .privacy > *, .faq, main > header:not(.cl-header), .panel, .stats > *, .cl-footer";
  const seen = new WeakSet();
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        if (!motion.matches) entry.target.classList.add("cl-motion-enter");
      });
    },
    { threshold: 0, rootMargin: "0px 0px -24px 0px" },
  );
  const register = () =>
    document.querySelectorAll(selector).forEach((element) => {
      if (seen.has(element)) return;
      seen.add(element);
      // Keep small card groups gently staggered without delaying long articles.
      if (element.matches(".story-panel, .step-card, .stats > *")) {
        const index = [...element.parentElement.children].indexOf(element);
        element.style.setProperty(
          "--cl-motion-delay",
          `${Math.min(index, 3) * 60}ms`,
        );
      }
      element.addEventListener("animationend", (event) => {
        if (event.animationName === "cl-enter")
          element.classList.remove("cl-motion-enter");
      });
      observer.observe(element);
    });
  register();
  // The admin's live metric cards arrive after the initial HTML.
  const stats = document.querySelector(".stats");
  if (stats) new MutationObserver(register).observe(stats, { childList: true });
});
