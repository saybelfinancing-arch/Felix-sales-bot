// ============================================================
// FELIX — Sales Agent Slack Bot for SBL IT Platforms Co., Ltd.
// ============================================================
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Raw body needed for Slack signature verification ──────────
app.use('/slack/events', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── In-memory conversation store (per user/channel thread) ────
const conversations = new Map();

// ── Felix's full system prompt ────────────────────────────────
const FELIX_SYSTEM = `You are Felix, the B2B Sales AI Agent for SBL IT Platforms Co., Ltd. — a Thai distributor of healthy foods and beverages.

COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store
Price list effective: Thailand - 01/01/2026

MONTHLY TARGETS:
- Revenue: ฿250,000/month
- New B2B Clients: 10–20/month
- Always keep these targets in mind. Actively help reach them in every interaction.

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

━━ FITNESSHOCK DESSERT UNCOATED BARS (60g) ⭐ HIGH PROTEIN ━━
9. Banana Dessert Bar — ฿75/pc | Showbox 12 | P:20g F:4.8g C:4.4g 175kcal
10. Pistachio Dessert Bar — ฿75/pc | Showbox 12 | P:20g F:4.8g C:4g 173kcal

━━ NEW GLAZED BARS (35g) ━━
11. Milk Caramel-Coconut Glazed Bar — ฿60/pc | Showbox 12 | P:2.1g F:10.2g C:2.8g 138kcal
12. Chocolate-Coconut Glazed Bar — ฿60/pc | Showbox 12 | P:2.1g F:10.2g C:2.8g 138kcal

ALL FITNESSHOCK: No added sugar. Great for gyms, health stores, pharmacies, modern trade.

SALES TASKS YOU PERFORM:
1. LEAD GENERATION: Suggest specific Thai B2B targets (gyms, fitness centers, health stores, pharmacies, 7-Eleven/FamilyMart, Tops/Villa/Big C, hospitals, hotels, offices). For each: business type, location, why good fit, recommended products, estimated order, pricing tier.
2. OUTREACH EMAILS: Professional bilingual (English + Thai) cold outreach. Include product highlights, right pricing tier, clear CTA.
3. SALES PROPOSALS: Client overview, recommended product mix, pricing per tier, MOQ, credit terms, next steps.
4. FOLLOW-UPS: Timely, polite, culturally Thai-appropriate. Re-engage without being pushy.
5. LEAD QUALIFICATION: Ask about volume, business type, current suppliers. Score Hot/Warm/Cold. Recommend best tier + products.
6. PIPELINE TRACKING: Help track New → Contacted → Proposal Sent → Follow Up → Closed Won. Estimate revenue.
7. CLOSING: Use 15-day credit offer, limited new glazed bar SKUs, or volume framing to create urgency.
8. TARGET PLANNING: ฿250k/month = ~5,681 PET bottles at small wholesale OR ~3,334 FitnesShock bars at ฿75.

SLACK FORMATTING RULES:
- Use *bold* for emphasis (Slack markdown, not **)
- Use bullet points with • for lists
- Keep responses concise and scannable for Slack
- Use emojis naturally to make reports readable
- For tables, use simple text alignment or bullet lists (Slack doesn't render markdown tables well)
- Always end with a clear next action or CTA

STYLE: Both reactive AND consultative — always push toward next step and closing.
LANGUAGE: English default. Switch to Thai if user writes Thai. Mix naturally. Use ฿. Be warm, professional, confident.`;

// ── Slack signature verification ──────────────────────────────
function verifySlackSignature(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // skip in dev if not set

  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSignature = req.headers['x-slack-signature'];

  // Reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const body = req.body.toString('utf8');
  const sigBase = `v0:${timestamp}:${body}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBase)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(slackSignature)
  );
}

// ── Call Claude API ───────────────────────────────────────────
async function callClaude(messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
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

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  return data.content?.map(b => b.text || '').join('') || 'Sorry, I could not generate a response.';
}

// ── Post message to Slack ─────────────────────────────────────
async function postToSlack(channel, text, threadTs = null) {
  const body = { channel, text };
  if (threadTs) body.thread_ts = threadTs;

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!data.ok) console.error('Slack post error:', data.error);
  return data;
}

// ── Post "typing" indicator ───────────────────────────────────
async function postTyping(channel, threadTs = null) {
  return postToSlack(channel, '_Felix is thinking..._', threadTs);
}

// ── Delete a message ──────────────────────────────────────────
async function deleteMessage(channel, ts) {
  await fetch('https://slack.com/api/chat.delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ channel, ts })
  });
}

// ── Get bot's own user ID ─────────────────────────────────────
let BOT_USER_ID = null;
async function getBotUserId() {
  if (BOT_USER_ID) return BOT_USER_ID;
  const res = await fetch('https://slack.com/api/auth.test', {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  });
  const data = await res.json();
  BOT_USER_ID = data.user_id;
  return BOT_USER_ID;
}

// ── Deduplicate processed events ──────────────────────────────
const processedEvents = new Set();

// ── Main Slack event handler ──────────────────────────────────
app.post('/slack/events', async (req, res) => {
  // Verify signature
  if (!verifySlackSignature(req)) {
    return res.status(401).send('Unauthorized');
  }

  const body = JSON.parse(req.body.toString('utf8'));

  // Handle Slack URL verification challenge
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // Acknowledge immediately (Slack requires <3s response)
  res.status(200).send('OK');

  const event = body.event;
  if (!event) return;

  // Only handle messages
  if (event.type !== 'message') return;
  if (event.subtype) return; // skip edits, bot messages, etc.
  if (event.bot_id) return;  // ignore other bots

  // Deduplicate
  const eventKey = `${event.client_msg_id || event.ts}`;
  if (processedEvents.has(eventKey)) return;
  processedEvents.add(eventKey);
  setTimeout(() => processedEvents.delete(eventKey), 60000);

  const botId = await getBotUserId();
  const isMentioned = event.text?.includes(`<@${botId}>`);
  const isDM = event.channel_type === 'im';

  // Felix responds when mentioned in a channel OR in a DM
  if (!isMentioned && !isDM) return;

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userText = event.text
    ?.replace(/<@[A-Z0-9]+>/g, '')  // remove @mentions
    ?.trim() || '';

  if (!userText) {
    await postToSlack(channel,
      `*สวัสดีครับ!* 👋 I'm *Felix*, your Sales Agent for SBL IT Platforms.\n\nAsk me anything or use these quick commands:\n• \`generate leads\` — Find new B2B prospects\n• \`outreach email\` — Draft a bilingual outreach email\n• \`sales proposal\` — Create a full B2B proposal\n• \`follow up\` — Write a follow-up message\n• \`pipeline report\` — Get your pipeline status\n• \`hit target\` — Plan to reach ฿250,000 this month`,
      threadTs
    );
    return;
  }

  // Build conversation key (per user in a thread, or per DM)
  const convKey = isDM ? event.user : `${channel}:${threadTs}`;

  // Get or create conversation history
  if (!conversations.has(convKey)) {
    conversations.set(convKey, []);
  }
  const history = conversations.get(convKey);

  // Add user message
  history.push({ role: 'user', content: userText });

  // Keep last 20 messages to manage context
  if (history.length > 20) history.splice(0, history.length - 20);

  // Post typing indicator
  const typingMsg = await postTyping(channel, threadTs);

  try {
    const reply = await callClaude(history);

    // Add assistant reply to history
    history.push({ role: 'assistant', content: reply });

    // Delete typing indicator and post real reply
    if (typingMsg?.ts) await deleteMessage(channel, typingMsg.ts);
    await postToSlack(channel, reply, threadTs);

  } catch (err) {
    console.error('Error calling Claude:', err);
    if (typingMsg?.ts) await deleteMessage(channel, typingMsg.ts);
    await postToSlack(channel,
      '⚠️ Sorry, I hit an error. Please try again in a moment.',
      threadTs
    );
  }
});

// ── Slash command: /felix ─────────────────────────────────────
app.post('/slack/commands', express.urlencoded({ extended: true }), async (req, res) => {
  const { text, channel_id, user_id } = req.body;

  // Respond immediately to avoid timeout
  res.json({
    response_type: 'in_channel',
    text: `_Felix is working on: "${text || 'your request'}"..._`
  });

  const convKey = `cmd:${user_id}`;
  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const history = conversations.get(convKey);

  const prompt = text || 'Hello, introduce yourself and list what you can do';
  history.push({ role: 'user', content: prompt });
  if (history.length > 20) history.splice(0, history.length - 20);

  try {
    const reply = await callClaude(history);
    history.push({ role: 'assistant', content: reply });
    await postToSlack(channel_id, `*Felix:* ${reply}`);
  } catch (err) {
    console.error('Slash command error:', err);
    await postToSlack(channel_id, '⚠️ Felix encountered an error. Please try again.');
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'Felix', company: 'SBL IT Platforms Co., Ltd.' });
});

app.listen(PORT, () => {
  console.log(`🤖 Felix Sales Bot running on port ${PORT}`);
});
