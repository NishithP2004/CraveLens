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

const installDialog = document.querySelector('#installDialog');
const installCommand = 'curl -fsSL https://cravelens.nishithp.page/install.sh | bash';

document.querySelectorAll('.install-trigger').forEach((trigger) => {
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    installDialog.showModal();
  });
});

installDialog.querySelector('.dialog-close').addEventListener('click', () => installDialog.close());
installDialog.addEventListener('click', (event) => {
  if (event.target === installDialog) installDialog.close();
});
installDialog.querySelector('.copy-command').addEventListener('click', async (event) => {
  const copyButton = event.currentTarget;
  const commandOption = copyButton.closest('.command-option');

  await navigator.clipboard.writeText(installCommand);
  copyButton.textContent = 'Copied ✓';
  copyButton.classList.add('copied');
  commandOption.classList.add('copied');

  window.setTimeout(() => {
    copyButton.textContent = 'Copy';
    copyButton.classList.remove('copied');
    commandOption.classList.remove('copied');
  }, 1800);
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
