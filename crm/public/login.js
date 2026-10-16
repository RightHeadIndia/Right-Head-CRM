const form = document.querySelector('#loginForm');
const errorBox = document.querySelector('#loginError');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  errorBox.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.password.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sign in failed.');
    location.replace('/');
  } catch (error) {
    errorBox.textContent = error.message || 'Could not reach the server.';
    button.disabled = false;
    form.password.focus();
  }
});
