/* Theme: dark / light. Loaded in <head> so the page never flashes the wrong theme. */
(function () {
  var KEY = 'ipvss_theme', t = null;
  try { t = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
  if (t !== 'dark' && t !== 'light') t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  window.__theme = {
    get: function () { return document.documentElement.getAttribute('data-theme'); },
    set: function (n) { document.documentElement.setAttribute('data-theme', n); try { localStorage.setItem(KEY, n); } catch (e) { /* ignore */ } },
  };
})();
