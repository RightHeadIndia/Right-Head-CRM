// One-off live check of the configured Gemini API key.
const fs = require('node:fs');
const path = require('node:path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.log('No Gemini API key was found.');
    process.exitCode = 1;
    return;
  }

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL || 'gemini-3.5-flash',
          messages: [{
            role: 'user',
            content: 'Reply with JSON only: {"skills":["React"]}'
          }],
          response_format: { type: 'json_object' },
          max_tokens: 100
        }),
        signal: AbortSignal.timeout(60000)
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.log(`Gemini returned HTTP ${response.status}.`);
      console.log(JSON.stringify(data).slice(0, 400));
      process.exitCode = 1;
      return;
    }

    const content = data.choices?.[0]?.message?.content || '(no response text)';
    console.log(`Gemini connection succeeded. Model: ${data.model || process.env.AI_MODEL || 'configured model'}`);
    console.log(String(content).slice(0, 300));
  } catch (error) {
    console.log(`Gemini connection failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
