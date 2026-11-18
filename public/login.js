const form = document.getElementById('form'), err = document.getElementById('error'), btn = document.getElementById('go');
const params = new URLSearchParams(location.search);
const product = params.get('product') === 'talent' || params.get('next') === '/talent.html' ? 'talent' : 'crm';
const nextPage = product === 'talent' ? '/talent.html' : '/index.html';
const emailInput = document.getElementById('email');
document.getElementById('loginTitle').textContent = product === 'talent' ? 'Talent Acquisition' : 'Right Head CRM';
document.getElementById('loginDescription').textContent = product === 'talent'
  ? 'Sign in with your Right Head talent account.'
  : 'Sign in with your Right Head CRM account.';
document.title = `${product === 'talent' ? 'Talent Acquisition' : 'CRM'} sign in - Right Head HR Consultants`;
fetch('/api/auth/session').then(r => r.json()).then(session => {
  if (!emailInput.value) emailInput.value = session.loginEmails?.[product] || '';
  if (session.authenticated && session.product === product) location.replace(nextPage);
}).catch(() => { err.textContent = 'Could not check the current sign-in session.'; });
form.addEventListener('submit', async e => {
  e.preventDefault(); err.textContent = ''; btn.disabled = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product, email: emailInput.value, password: document.getElementById('password').value })
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return location.replace(nextPage);
    err.textContent = d.error || 'Could not sign in.';
  } catch (error) { err.textContent = error.message || 'Could not reach the server.'; }
  btn.disabled = false;
});
