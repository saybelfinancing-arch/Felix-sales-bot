const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Capture raw body
app.use((req, res, next) => {
  req.rawBody = '';
  req.on('data', chunk => { req.rawBody += chunk.toString(); });
  req.on('end', () => {
    try { req.body = req.rawBody ? JSON.parse(req.rawBody) : {}; }
    catch { req.body = {}; }
    next();
  });
});

const SYSTEM = `You are Felix, the B2B Sales AI Agent for SBL IT Platforms Co., Ltd. — a Thai distributor of healthy foods and beverages.
COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store
MONTHLY TARGETS: Revenue ฿250,000/month | New B2B Clients: 10-20/month
PRODUCTS:
- SBL Water 0.5L Glass: ฿54(500+) / ฿58(40-499) / ฿60(credit) / ฿65(retail)
- SBL Water 0.5L PET: ฿44(500+) / ฿48(40-499) / ฿50(credit) / ฿55(retail)
- FitnesShock Brownies (Cookie Cream/Banana Choc/Hot Choc/Coconut Pie) 50g: ฿75/pc
- SHOCKS! Bars (Pistachio/Peanut) 50g: ฿65/pc
- FitnesShock Dessert Bars (Banana/Pistachio) 60g: ฿75/pc — 20g protein!
- NEW Glazed Bars (Caramel-Coconut/Choc-Coconut) 35g: ฿60/pc
TASKS: Lead generation, bilingual outreach (English+Thai), proposals, follow-ups, qualification, pipeline, closing.
FORMAT: Slack markdown — *bold*, • bullets, emojis. Keep concise. Always end with a next step.
LANGUAGE: English default, switch to Thai if user writes Thai. Use ฿ for Baht.`;

const conversations = new Map();
const processed = new Set();
let BOT_ID = null;

// ── Health ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'Felix', company: 'SBL IT Platforms Co., Ltd.' });
});

// ── Slack Events ──────────────────────────────────────────────
app.post('/slack/events', async (req, res) => {
  const body = req.body;
  console.log('Event received, type:', body && body.type);

  // URL verification challenge
  if (body && body.type === 'url_verification') {
    console.log('Challenge:', body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }

  // Acknowledge immediately
  res.status(200).end('OK');

  const event = body && body.event;
  if (!event || event.type !== 'message' || event.subtype || event.bot_id) return;

  // Deduplicate
  const key = event.client_msg_id || event.ts;
  if (processed.has(key)) return;
  processed.add(key);
  setTimeout(() => processed.delete(key), 60000);

  // Get bot ID
  if (!BOT_ID) {
    try {
      const r = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
      });
      const d = await r.json();
      BOT_ID = d.user_id;
      console.log('Bot ID:', BOT_ID);
    } catch (e) { console.error('auth.test failed:', e); return; }
  }

  const isMentioned = event.text && event.text.includes(`<@${BOT_ID}>`);
  const isDM = event.channel_type === 'im';
  if (!isMentioned && !isDM) return;

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!userText) {
    await post(channel, `*สวัสดีครับ!* 👋 I'm *Felix*, Sales Agent for SBL IT Platforms!\n\n• \`@Felix generate leads\`\n• \`@Felix write outreach email\`\n• \`@Felix create sales proposal\`\n• \`@Felix how to hit ฿250k this month\``, threadTs);
    return;
  }

  const convKey = isDM ? event.user : `${channel}:${threadTs}`;
  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const hist = conversations.get(convKey);
  hist.push({ role: 'user', content: userText });
  if (hist.length > 20) hist.splice(0, hist.length - 20);

  const typing = await post(channel, '_Felix is thinking... 🤔_', threadTs);
  try {
    const reply = await claude(hist);
    hist.push({ role: 'assistant', content: reply });
    if (typing && typing.ts) await del(channel, typing.ts);
    await post(channel, reply, threadTs);
  } catch (e) {
    console.error('Claude error:', e);
    if (typing && typing.ts) await del(channel, typing.ts);
    await post(channel, '⚠️ Error. Please try again.', threadTs);
  }
});

// ── Slash command ─────────────────────────────────────────────
app.post('/slack/commands', async (req, res) => {
  const p = new URLSearchParams(req.rawBody);
  const text = p.get('text') || 'Hello, introduce yourself';
  const channel_id = p.get('channel_id') || '';
  const user_id = p.get('user_id') || '';
  res.status(200).json({ response_type: 'in_channel', text: `_Felix is on it..._` });
  const convKey = `cmd:${user_id}`;
  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const hist = conversations.get(convKey);
  hist.push({ role: 'user', content: text });
  if (hist.length > 20) hist.splice(0, hist.length - 20);
  try {
    const reply = await claude(hist);
    hist.push({ role: 'assistant', content: reply });
    await post(channel_id, `*Felix:* ${reply}`);
  } catch { await post(channel_id, '⚠️ Error. Please try again.'); }
});

// ── Helpers ───────────────────────────────────────────────────
async function post(channel, text, thread_ts) {
  const body = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;
  try {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify(body)
    });
    return r.json();
  } catch (e) { console.error('post error:', e); return null; }
}

async function del(channel, ts) {
  try {
    await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel, ts })
    });
  } catch (e) { console.error('del error:', e); }
}

async function claude(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: SYSTEM, messages })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(d));
  return d.content?.map(b => b.text || '').join('') || 'No response.';
}

app.listen(PORT, () => console.log(`🤖 Felix running on port ${PORT}`));
