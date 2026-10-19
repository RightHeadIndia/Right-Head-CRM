const form = document.getElementById('form'), err = document.getElementById('error'), btn = document.getElementById('go');
// Already signed in? Go straight to the CRM.
fetch('/api/auth/session').then(r => r.json()).then(s => { if (s.authenticated) location.replace('/'); }).catch(() => {});
form.addEventListener('submit', async e => {
  e.preventDefault(); err.textContent = ''; btn.disabled = true;
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('password').value }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return location.replace('/');
    err.textContent = d.error || 'Could not sign in.';
  } catch (_) { err.textContent = 'Could not reach the server.'; }
  btn.disabled = false;
});
