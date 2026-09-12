(() => {
  const requested = new URLSearchParams(location.search).get('theme');
  const theme = requested === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = theme;
  document.documentElement.dataset.theme = theme;
})();
