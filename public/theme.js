(() => {
  const storageKey = 'crm-theme';
  const root = document.documentElement;

  function readTheme() {
    try {
      return localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light';
    } catch (_) {
      return 'light';
    }
  }

  function applyTheme(theme) {
    const selected = theme === 'dark' ? 'dark' : 'light';
    root.dataset.theme = selected;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = selected === 'dark' ? '#091a27' : '#f4f8fb';

    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const target = selected === 'dark' ? 'light' : 'dark';
      button.textContent = `${target === 'dark' ? 'Dark' : 'Light'} mode`;
      button.setAttribute('aria-label', `Switch to ${target} mode`);
      button.setAttribute('aria-pressed', String(selected === 'dark'));
      button.title = `Switch to ${target} mode`;
    });
  }

  function setupThemeToggles() {
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.addEventListener('click', () => {
        const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        applyTheme(nextTheme);
        try {
          localStorage.setItem(storageKey, nextTheme);
        } catch (_) {}
      });
    });
    applyTheme(readTheme());
  }

  applyTheme(readTheme());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupThemeToggles, { once: true });
  } else {
    setupThemeToggles();
  }
  window.addEventListener('storage', event => {
    if (event.key === storageKey) applyTheme(event.newValue);
  });
  window.addEventListener('pageshow', () => applyTheme(readTheme()));
})();
