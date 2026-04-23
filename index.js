// ============================================================
// FELIX — Sales Agent Slack Bot for SBL IT Platforms Co., Ltd.
// ============================================================
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Store raw body for signature verification ─────────────────
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch (e) { req.body = {}; }
    next();
  });
});

// ── In-memory conversation store ──────────────────────────────
const conversations = new Map();
const processedEvents = new Set();

// ── Felix system prompt ───────────────────────────────────────
const FELIX_SYSTEM = `You are Felix, the B2B Sales AI Agent for SBL IT Platforms Co., Ltd. — a Thai distributor of healthy foods and beverages.

COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store
Price list effective: Thailand - 01/01/2026

MONTHLY TARGETS:
- Revenue: ฿250,000/month
- New B2B Clients: 10–20/month

━━ SBL MINERAL WATER WITH SI ━━
1. SBL Mineral Water 0.5L GLASS
   Big Wholesale 500+: ฿54 | Small Wholesale 40-499: ฿58 | Credit 15 days: ฿60 | Retail: ฿65
   Pack: 20 bottles | Shelf life: 24 months

2. SBL Mineral Water 0.5L PET
   Big Wholesale 500+: ฿44 | Small Wholesale 40-499: ฿48 | Credit 15 days: ฿50 | Retail: ฿55
   Pack: 20 bottles | Shelf life: 24 months

━━ FITNESSHOCK PROTEIN BROWNIES (50g) ━━
3. Cookie Cream Brownie — ฿75/pc | Showbox 12 | P:7.5g F:17g C:10g 233kcal
4. Banana Chocolate Brownie — ฿75/pc | Showbox 10 | P:7.5g F:17g C:10g 233kcal
5. Hot Chocolate Brownie — ฿75/pc | Showbox 12 | P:7.5g F:17g C:10g 233kcal
6. Coconut Pie Brownie — ฿75/pc | Showbox 10 | P:7.5g F:17g C:10g 233kcal

━━ SHOCKS! COATED BARS (50g) ━━
7. SHOCKS! Pistachio Coated Bar — ฿65/pc | Showbox 12 | P:10g F:15g C:5g Fiber:14g
8. SHOCKS! Peanut Coated Bar — ฿65/pc | Showbox 12 | P:10g F:13g C:5g Fiber:14g

━━ FITNESSHOCK DESSERT UNCOATED BARS (60g) ━━
9. Banana Dessert Bar — ฿75/pc | Showbox 12 | P:20g F:4.8g C:4.4g 175kcal
10. Pistachio Dessert Bar — ฿75/pc | Showbox 12 | P:20g F:4.8g C:4g 173kcal

━━ NEW GLAZED BARS (35g) ━━
11. Milk Caramel-Coconut Glazed Bar — ฿60/pc | Showbox 12 | P:2.1g F:10.2g C:2.8g 138kcal
12. Chocolate-Coconut Glazed Bar — ฿60/pc | Showbox 12 | P:2.1g F:10.2g C:2.8g 138kcal

ALL FITNESSHOCK: No added sugar. Great for gyms, health stores, pharmacies, modern trade.

SALES TASKS: Lead generation, outreach emails (English+Thai), sales proposals, follow-ups, lead qualification, pipeline tracking, deal closing, revenue target planning.

SLACK FORMAT: Use *bold*, bullet points, emojis. Keep responses concise and scannable.
LANGUAGE: English default, switch to Thai if user writes Thai. Use ฿ for Baht.
TONE: Warm, professional, consultative — always push toward next step and closing.`;

// ── Verify Slack signature ────────────────────────────────────
function verifySignature(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true;
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return true;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${req.rawBody}`;
  const mine = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig)); }
  catch { return false; }
}

// ── Call Claude API ───────────────────────────────────────────
async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: FELIX_SYSTEM,
      messages
    })
  });
  const data = await res.json();
  return data.content?.map(b => b.text || '').join('') || 'Sorry, I could not generate a response.';
}

// ── Post to Slack ─────────────────────────────────────────────
async function postToSlack(channel, text, threadTs = null) {
  const body = { channel, text };
  if (threadTs) body.thread_ts = threadTs;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

// ── Delete a Slack message ────────────────────────────────────
async function deleteSlackMsg(channel, ts) {
  await fetch('https://slack.com/api/chat.delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ channel, ts })
  });
}

// ── Get bot user ID ───────────────────────────────────────────
let BOT_ID = null;
async function getBotId() {
  if (BOT_ID) return BOT_ID;
  const res = await fetch('https://slack.com/api/auth.test', {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  });
  const data = await res.json();
  BOT_ID = data.user_id;
  return BOT_ID;
}

// ── Slack Events endpoint ─────────────────────────────────────
app.post('/slack/events', async (req, res) => {
  if (!verifySignature(req)) return res.status(401).send('Unauthorized');

  const body = req.body;

  // ✅ URL verification challenge — respond immediately
  if (body.type === 'url_verification') {
    console.log('Challenge received:', body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }

  // Acknowledge immediately
  res.status(200).send('OK');

  const event = body.event;
  if (!event || event.type !== 'message' || event.subtype || event.bot_id) return;

  // Deduplicate
  const key = event.client_msg_id || event.ts;
  if (processedEvents.has(key)) return;
  processedEvents.add(key);
  setTimeout(() => processedEvents.delete(key), 60000);

  const botId = await getBotId();
  const isMentioned = event.text?.includes(`<@${botId}>`);
  const isDM = event.channel_type === 'im';
  if (!isMentioned && !isDM) return;

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userText = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim() || '';

  if (!userText) {
    await postToSlack(channel,
      `*สวัสดีครับ!* 👋 I'm *Felix*, Sales Agent for SBL IT Platforms.\n\nTry:\n• \`@Felix generate leads\`\n• \`@Felix write outreach email\`\n• \`@Felix create sales proposal\`\n• \`@Felix how to hit ฿250k this month\``,
      threadTs);
    return;
  }

  const convKey = isDM ? event.user : `${channel}:${threadTs}`;
  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const history = conversations.get(convKey);
  history.push({ role: 'user', content: userText });
  if (history.length > 20) history.splice(0, history.length - 20);

  const typing = await postToSlack(channel, '_Felix is thinking... 🤔_', threadTs);

  try {
    const reply = await callClaude(history);
    history.push({ role: 'assistant', content: reply });
    if (typing?.ts) await deleteSlackMsg(channel, typing.ts);
    await postToSlack(channel, reply, threadTs);
  } catch (err) {
    console.error('Claude error:', err);
    if (typing?.ts) await deleteSlackMsg(channel, typing.ts);
    await postToSlack(channel, '⚠️ Something went wrong. Please try again.', threadTs);
  }
});

// ── Slash command /felix ──────────────────────────────────────
app.post('/slack/commands', async (req, res) => {
  const params = new URLSearchParams(req.rawBody);
  const text = params.get('text') || '';
  const channel_id = params.get('channel_id') || '';
  const user_id = params.get('user_id') || '';

  res.json({ response_type: 'in_channel', text: `_Felix is on it: "${text || 'hello'}"..._` });

  const convKey = `cmd:${user_id}`;
  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const history = conversations.get(convKey);
  history.push({ role: 'user', content: text || 'Hello, introduce yourself' });
  if (history.length > 20) history.splice(0, history.length - 20);

  try {
    const reply = await callClaude(history);
    history.push({ role: 'assistant', content: reply });
    await postToSlack(channel_id, `*Felix:* ${reply}`);
  } catch (err) {
    await postToSlack(channel_id, '⚠️ Felix error. Please try again.');
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'Felix', company: 'SBL IT Platforms Co., Ltd.' });
});

app.listen(PORT, () => console.log(`🤖 Felix running on port ${PORT}`));
