(function(){
  const KEY = 'innvida-theme';
  function apply(theme){
    document.body.classList.toggle('light-theme', theme === 'light');
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = theme === 'light' ? 'Modo oscuro' : 'Modo claro';
    try { localStorage.setItem(KEY, theme); } catch {}
  }
  function init(){
    const saved = (()=>{ try { return localStorage.getItem(KEY); } catch { return null; } })();
    apply(saved === 'light' ? 'light' : 'dark');
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.addEventListener('click', ()=> apply(document.body.classList.contains('light-theme') ? 'dark' : 'light'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
