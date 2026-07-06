const menuButton = document.querySelector('.menu-button');
const nav = document.querySelector('#nav');

menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!open));
  nav.classList.toggle('open', !open);
});

nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  nav.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
}));

document.querySelectorAll('details').forEach((detail) => {
  detail.addEventListener('toggle', () => {
    if (!detail.open) return;
    document.querySelectorAll('details').forEach((other) => {
      if (other !== detail) other.open = false;
    });
  });
});

const quickAdd = document.querySelector('#quickAdd');
const toast = document.querySelector('.toast');
quickAdd.addEventListener('click', () => {
  quickAdd.innerHTML = 'Added <span>✓</span>';
  quickAdd.classList.add('added');
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2600);
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) entry.target.classList.add('visible');
  });
}, { threshold: 0.14 });

document.querySelectorAll('.step-card, .feature-copy, .preference-card, .privacy > *, .faq').forEach((el) => {
  el.classList.add('reveal');
  observer.observe(el);
});
