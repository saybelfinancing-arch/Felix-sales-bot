const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Hardcoded keys - Railway env vars have line break issues
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/\s+/g, '').trim();
const SLACK_TOKEN = (process.env.SLACK_BOT_TOKEN || '').replace(/\s+/g, '').trim();

app.use((req, res, next) => {
  req.rawBody = '';
  req.on('data', chunk => { req.rawBody += chunk.toString(); });
  req.on('end', () => {
    try { req.body = req.rawBody ? JSON.parse(req.rawBody) : {}; }
    catch { req.body = {}; }
    next();
  });
});

const SYSTEM = `You are Felix, the B2B Sales AI Agent for SBL IT Platforms Co., Ltd.
COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store
TARGETS: Revenue ฿250,000/month | New B2B Clients: 10-20/month
PRODUCTS:
- SBL Water 0.5L Glass: ฿54(500+)/฿58(40-499)/฿60(credit)/฿65(retail)
- SBL Water 0.5L PET: ฿44(500+)/฿48(40-499)/฿50(credit)/฿55(retail)
- FitnesShock Brownies (4 flavors) 50g: ฿75/pc
- SHOCKS! Bars (Pistachio/Peanut) 50g: ฿65/pc
- FitnesShock Dessert Bars 60g: ฿75/pc (20g protein!)
- NEW Glazed Bars 35g: ฿60/pc
TASKS: Lead generation, bilingual outreach (English+Thai), proposals, follow-ups, pipeline tracking, closing.
FORMAT: Slack markdown *bold*, bullets, emojis. Concise. Always end with next step.
LANGUAGE: English default, Thai if user writes Thai.`;

const conversations = new Map();
const processed = new Set();
let BOT_ID = null;

app.get('/health', (req, res) => {
  const keyPreview = ANTHROPIC_KEY ? ANTHROPIC_KEY.substring(0, 20) + '...' : 'MISSING';
  res.json({ status: 'ok', agent: 'Felix', key: keyPreview, keyLength: ANTHROPIC_KEY.length });
});

app.post('/slack/events', async (req, res) => {
  const body = req.body;
  if (body && body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }
  res.status(200).end('OK');

  const event = body && body.event;
  if (!event || event.type !== 'message' || event.subtype || event.bot_id) return;

  const key = event.client_msg_id || event.ts;
  if (processed.has(key)) return;
  processed.add(key);
  setTimeout(() => processed.delete(key), 60000);

  if (!BOT_ID) {
    try {
      const r = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
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
    await post(channel, `*สวัสดีครับ!* 👋 I'm *Felix*, Sales Agent for SBL IT Platforms! Ask me anything about leads, pricing, proposals, or outreach.`, threadTs);
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
    console.error('Claude error:', JSON.stringify(e));
    if (typing && typing.ts) await del(channel, typing.ts);
    await post(channel, `⚠️ Error: ${e.message}. Please try again.`, threadTs);
  }
});

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
  try {
    const reply = await claude(hist);
    hist.push({ role: 'assistant', content: reply });
    await post(channel_id, `*Felix:* ${reply}`);
  } catch (e) { await post(channel_id, `⚠️ Error: ${e.message}`); }
});

async function post(channel, text, thread_ts) {
  const body = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;
  try {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify(body)
    });
    return r.json();
  } catch (e) { console.error('post error:', e); return null; }
}

async function del(channel, ts) {
  try {
    await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify({ channel, ts })
    });
  } catch (e) { console.error('del error:', e); }
}

async function claude(messages) {
  console.log('Calling Claude, key length:', ANTHROPIC_KEY.length, 'starts with:', ANTHROPIC_KEY.substring(0, 15));
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM,
      messages
    })
  });
  const d = await r.json();
  console.log('Claude response status:', r.status, 'type:', d.type);
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${d.error?.message || JSON.stringify(d)}`);
  return d.content?.map(b => b.text || '').join('') || 'No response.';
}

app.listen(PORT, () => console.log(`🤖 Felix running on port ${PORT}`));
