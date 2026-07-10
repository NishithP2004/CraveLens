const scrollTopButton = document.querySelector('.scroll-top');

if (scrollTopButton) {
  const updateScrollTopVisibility = () => {
    scrollTopButton.classList.toggle('is-visible', window.scrollY > 420);
  };

  updateScrollTopVisibility();
  window.addEventListener('scroll', updateScrollTopVisibility, { passive: true });
}
