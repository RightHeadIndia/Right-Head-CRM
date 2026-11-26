'wwzwz// One-off live check of the Gemini key through the OpenAI-compatible endpoint. Delete after use.
require('node:fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach(line => { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; });
(async () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return console.log('NO KEY');
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'Extract skills from this CV text: John Doe, 5 years React developer. Reply with a JSON object with a skills array only.' }],
        response_format: { type: 'json_object' },
        max_tokens: 200
      }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return console.log('HTTP', res.status, JSON.stringify(data).slice(0, 400));
    const msg = data.choices?.[0]?.message || {};
    console.log('GEMINI OK, model:', data.model, 'reply:', msg.content || JSON.stringify(msg).slice(0, 300));
  } catch (e) { console.log('FAILED:', e.message); }
})();
