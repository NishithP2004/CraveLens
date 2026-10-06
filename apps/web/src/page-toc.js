// Shared scroll navigation for guide, privacy and terms.
const toc = document.querySelector(".policy-toc");
if (toc) {
  const items = [...toc.querySelectorAll('a[href^="#"]')]
    .map((link) => ({
      link,
      section: document.getElementById(decodeURIComponent(link.hash.slice(1))),
    }))
    .filter((item) => item.section);
  let current;
  let frame;
  const update = () => {
    frame = undefined;
    const line = Math.min(120, window.innerHeight * 0.2);
    let active;
    for (const item of items) {
      if (item.section.getBoundingClientRect().top <= line) active = item;
    }
    // Short final sections cannot always reach the reading line.
    if (
      window.scrollY + window.innerHeight >=
      document.documentElement.scrollHeight - 2
    ) {
      active = items.at(-1);
    }
    if (current === active) return;
    current?.link.removeAttribute("aria-current");
    active?.link.setAttribute("aria-current", "location");
    current = active;
    if (active && toc.scrollHeight > toc.clientHeight) {
      const bounds = toc.getBoundingClientRect();
      const linkBounds = active.link.getBoundingClientRect();
      if (linkBounds.top < bounds.top + 12)
        toc.scrollTop -= bounds.top + 12 - linkBounds.top;
      else if (linkBounds.bottom > bounds.bottom - 12)
        toc.scrollTop += linkBounds.bottom - bounds.bottom + 12;
    }
  };
  const schedule = () => {
    if (frame === undefined) frame = requestAnimationFrame(update);
  };
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(schedule, {
      threshold: [0, 0.01, 0.25, 0.5, 1],
    });
    items.forEach(({ section }) => observer.observe(section));
  }
  // Covers long sections, scrolling backwards, hash navigation and page-bottom boundaries.
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("hashchange", schedule);
  update();
}
