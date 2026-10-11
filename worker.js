// Cloudflare Worker: serves the site files and handles POST /api/complaint
// Secrets are set in Cloudflare (Settings -> Variables and Secrets), never in index.html.

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function handleComplaint(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (body.website) return json({ ok: true }); // honeypot: pretend success to bots

  const name = clean(body.name, 80) || 'Anonymous';
  const phone = clean(body.phone, 20);
  const category = clean(body.category, 40) || 'Other';
  const seat = clean(body.seat, 80) || '—';
  const message = clean(body.message, 1500);

  if (phone.replace(/\D/g, '').length < 7 || message.length < 10) {
    return json({ error: 'Missing details' }, 400);
  }

  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const tasks = [];

  if (env.DISCORD_WEBHOOK_URL) {
    const mention = env.DISCORD_MANAGER_ID ? `<@${env.DISCORD_MANAGER_ID}> ` : '';
    tasks.push(fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `${mention}🚨 New complaint — ${category}`,
        allowed_mentions: { users: env.DISCORD_MANAGER_ID ? [env.DISCORD_MANAGER_ID] : [] },
        embeds: [{
          title: category,
          description: message,
          color: 0xcda45e,
          fields: [
            { name: 'Name', value: name, inline: true },
            { name: 'Phone / WhatsApp', value: phone, inline: true },
            { name: 'Show & Seat', value: seat, inline: false }
          ],
          footer: { text: `Deepa Cinema website • ${when} IST` }
        }]
      })
    }).then(r => { if (!r.ok) throw new Error('discord ' + r.status); }));
  }

  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_WHATSAPP_FROM: from, MANAGER_WHATSAPP_TO: to } = env;
  if (sid && token && from && to) {
    const text = `🚨 Deepa Cinema complaint (${category})\nName: ${name}\nPhone: ${phone}\nShow/Seat: ${seat}\n\n${message}`.slice(0, 1500);
    tasks.push(fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${sid}:${token}`),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ From: `whatsapp:${from}`, To: `whatsapp:${to}`, Body: text })
    }).then(r => { if (!r.ok) throw new Error('twilio ' + r.status); }));
  }

  if (!tasks.length) return json({ error: 'No alert channel configured' }, 500);
  const results = await Promise.allSettled(tasks);
  if (results.some(r => r.status === 'fulfilled')) return json({ ok: true });
  return json({ error: 'Delivery failed' }, 502);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/complaint') return handleComplaint(request, env);
    return env.ASSETS.fetch(request);
  }
};
