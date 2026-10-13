// Cloudflare Worker: serves the site files and handles POST /api/complaint
// Secrets are set in Cloudflare (Settings -> Variables and Secrets), never in index.html.

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const TICKET_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newTicketId() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return 'DC-' + [...a].map(n => TICKET_CHARS[n % TICKET_CHARS.length]).join('');
}
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
  const isAc = category.startsWith('Air conditioning');
  const acIssue = isAc ? clean(body.acIssue, 60) : '';
  const ticket = newTicketId();

  if (phone.replace(/\D/g, '').length < 7 || message.length < 10) {
    return json({ error: 'Missing details' }, 400);
  }

  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const tasks = [];

  if (env.DISCORD_WEBHOOK_URL) {
    const mention = env.DISCORD_MANAGER_ID ? `<@${env.DISCORD_MANAGER_ID}> ` : '';
    const fields = [
      { name: 'Ticket', value: ticket, inline: true },
      { name: 'Status', value: '🟢 ACTIVE', inline: true },
      { name: 'Name', value: name, inline: true },
      { name: 'Phone / WhatsApp', value: phone, inline: true }
    ];
    if (acIssue) fields.push({ name: 'AC issue', value: acIssue, inline: true });
    fields.push({ name: 'Show & Seat', value: seat, inline: false });

    const payload = {
      content: `${mention}🚨 New complaint ${ticket} — ${category}`,
      allowed_mentions: { users: env.DISCORD_MANAGER_ID ? [env.DISCORD_MANAGER_ID] : [] },
      embeds: [{
        title: `${ticket} · ${category}`,
        description: message,
        color: 0xd8ad63,
        fields,
        footer: { text: `Deepa Cinema website • ${when} IST` }
      }]
    };
    // Optional ticket mode: if the webhook belongs to a Discord FORUM channel, each complaint becomes its own post.
    if (env.DISCORD_FORUM === 'true') {
      payload.thread_name = `${ticket} · ${category}`.slice(0, 100);
      if (env.DISCORD_ACTIVE_TAG_ID) payload.applied_tags = [env.DISCORD_ACTIVE_TAG_ID];
    }
    tasks.push(fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(r => { if (!r.ok) throw new Error('discord ' + r.status); }));
  }

  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_WHATSAPP_FROM: from, MANAGER_WHATSAPP_TO: to } = env;
  if (sid && token && from && to) {
    const text = `🚨 Deepa Cinema complaint ${ticket} (${category})${acIssue ? ' - ' + acIssue : ''}\nName: ${name}\nPhone: ${phone}\nShow/Seat: ${seat}\n\n${message}`.slice(0, 1500);
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
  if (results.some(r => r.status === 'fulfilled')) return json({ ok: true, ticket });
  return json({ error: 'Delivery failed' }, 502);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/complaint') return handleComplaint(request, env);
    return env.ASSETS.fetch(request);
  }
};
