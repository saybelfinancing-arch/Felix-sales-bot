const express = require('express');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// Capture raw body as string for ALL routes
app.use((req, res, next) => {
  req.rawBody = '';
  req.on('data', chunk => { req.rawBody += chunk.toString(); });
  req.on('end', () => {
    if (req.rawBody) {
      try { req.body = JSON.parse(req.rawBody); } catch { req.body = {}; }
    } else {
      req.body = {};
    }
    next();
  });
});

const FELIX_SYSTEM = `You are Felix, the B2B Sales AI Agent for SBL IT Platforms Co., Ltd. — a Thai distributor of healthy foods and beverages.

COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store

MONTHLY TARGETS: Revenue ฿250,000/month | New B2B Clients: 10-20/month

PRODUCTS & PRICING:
SBL Mineral Water 0.5L GLASS: Big Wholesale 500+: ฿54 | Small 40-499: ฿58 | Credit 15d: ฿60 | Retail: ฿65
SBL Mineral Water 0.5L PET: Big Wholesale 500+: ฿44 | Small 40-499: ฿48 | Credit 15d: ฿50 | Retail: ฿55
FitnesShock Protein Brownies (Cookie Cream, Banana Choc, Hot Choc, Coconut Pie) 50g: ฿75/pc
SHOCKS! Pistachio Coated Bar 50g: ฿65/pc | SHOCKS! Peanut Coated Bar 50g: ฿65/pc
FitnesShock Banana Dessert Bar 60g: ฿75/pc | FitnesShock Pistachio Dessert Bar 60g: ฿75/pc
NEW Glazed Bar Milk Caramel-Coconut 35g: ฿60/pc | NEW Glazed Bar Chocolate-Coconut 35g: ฿60/pc

TASKS: Lead generation, bilingual outreach emails (English+Thai), sales proposals, follow-ups, lead qualification, pipeline tracking, deal closing.
SLACK FORMAT: Use *bold*, bullets, emojis. Keep responses concise.
LANGUAGE: English default, switch to Thai if user writes Thai.`;

const conversations = new Map();
const processed = new Set();
let BOT_ID = null;

function verifySignature(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true;
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return true;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const mine = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${req.rawBody}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig)); } catch { return false; }
}

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: FELIX_SYSTEM, messages })
  });
  const data = await res.json();
  return data.content?.map(b => b.text || '').join('') || 'Sorry, something went wrong.';
}

async function slackPost(channel, text, thread_ts) {
  const body = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function slackDelete(channel, ts) {
  await fetch('https://slack.com/api/chat.delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, ts })
  });
}

async function getBotId() {
  if (BOT_ID) return BOT_ID;
  const res = await fetch('https://slack.com/api/auth.test', { headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
  const d = await res.json();
  BOT_ID = d.user_id;
  return BOT_ID;
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', agent: 'Felix', company: 'SBL IT Platforms Co., Ltd.' }));

// Slack events
app.post('/slack/events', async (req, res) => {
  if (!verifySignature(req)) return res.status(401).send('Unauthorized');

  const body = req.body;

  // URL verification - THIS MUST WORK
  if (body && body.type === 'url_verification') {
    console.log('✅ Challenge received:', body.challenge);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ challenge: body.challenge }));
  }

  res.status(200).send('OK');

  const event = body && body.event;
  if (!event || event.type !== 'message' || event.subtype || event.bot_id) return;

  const key = event.client_msg_id || event.ts;
  if (processed.has(key)) return;
  processed.add(key);
  setTimeout(() => processed.delete(key), 60000);

  const botId = await getBotId();
  const isMentioned = event.text && event.text.includes(`<@${botId}>`);
  const isDM = event.channel_type === 'im';
  if (!isMentioned && !isDM) return;

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!text) {
    await slackPost(channel, `*สวัสดีครับ!* 👋 I'm *Felix*, Sales Agent for SBL IT Platforms!\n\n• \`@Felix generate leads\`\n• \`@Felix write outreach email\`\n• \`@Felix create sales proposal\`\n• \`@Felix hit ฿250k target\``, threadTs);
    return;
  }

  const convKey = isDM ? event.user : `${channel}:${threadTs}`;
  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const hist = conversations.get(convKey);
  hist.push({ role: 'user', content: text });
  if (hist.length > 20) hist.splice(0, hist.length - 20);

  const typing = await slackPost(channel, '_Felix is thinking... 🤔_', threadTs);
  try {
    const reply = await callClaude(hist);
    hist.push({ role: 'assistant', content: reply });
    if (typing && typing.ts) await slackDelete(channel, typing.ts);
    await slackPost(channel, reply, threadTs);
  } catch (err) {
    console.error(err);
    if (typing && typing.ts) await slackDelete(channel, typing.ts);
    await slackPost(channel, '⚠️ Error. Please try again.', threadTs);
  }
});

// Slash command
app.post('/slack/commands', async (req, res) => {
  const params = new URLSearchParams(req.rawBody);
  const text = params.get('text') || 'Hello';
  const channel_id = params.get('channel_id') || '';
  const user_id = params.get('user_id') || '';
  res.json({ response_type: 'in_channel', text: `_Felix is working on it..._` });
  const convKey = `cmd:${user_id}`;
  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const hist = conversations.get(convKey);
  hist.push({ role: 'user', content: text });
  try {
    const reply = await callClaude(hist);
    hist.push({ role: 'assistant', content: reply });
    await slackPost(channel_id, `*Felix:* ${reply}`);
  } catch { await slackPost(channel_id, '⚠️ Error. Please try again.'); }
});

app.listen(PORT, () => console.log(`🤖 Felix running on port ${PORT}`));
