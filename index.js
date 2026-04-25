const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/\s+/g, '').trim();
const SLACK_TOKEN = (process.env.SLACK_BOT_TOKEN || '').replace(/\s+/g, '').trim();
const GMAIL_USER = process.env.GMAIL_USER || 'saybelfinancing@gmail.com';
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');

app.use((req, res, next) => {
  req.rawBody = '';
  req.on('data', chunk => { req.rawBody += chunk.toString(); });
  req.on('end', () => {
    try { req.body = req.rawBody ? JSON.parse(req.rawBody) : {}; }
    catch { req.body = {}; }
    next();
  });
});

// ── Send Email via nodemailer ──────────────────────────────────
async function sendEmail(to, subject, body) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  });
  await transporter.sendMail({
    from: `Felix @ SBL IT Platforms <${GMAIL_USER}>`,
    to, subject, text: body
  });
}

// ── Felix System Prompt ───────────────────────────────────────
const FELIX_SYSTEM = `You are Felix, the B2B Sales AI Agent for SBL IT Platforms Co., Ltd.
You can SEND emails directly from ${GMAIL_USER} when asked.

COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store
TARGETS: Revenue ฿250,000/month | New B2B Clients: 10-20/month

PRODUCTS:
- SBL Water 0.5L Glass: ฿54(500+)/฿58(40-499)/฿60(credit)/฿65(retail)
- SBL Water 0.5L PET: ฿44(500+)/฿48(40-499)/฿50(credit)/฿55(retail)
- FitnesShock Brownies (Cookie Cream/Banana Choc/Hot Choc/Coconut Pie) 50g: ฿75/pc
- SHOCKS! Bars (Pistachio/Peanut) 50g: ฿65/pc
- FitnesShock Dessert Bars (Banana/Pistachio) 60g: ฿75/pc — 20g protein!
- NEW Glazed Bars (Caramel-Coconut/Choc-Coconut) 35g: ฿60/pc

EMAIL COMMANDS — use these exact formats:

To DRAFT an email (show before sending):
[DRAFT_EMAIL]
TO: recipient@email.com
SUBJECT: Subject here
BODY:
Email body here
[/DRAFT_EMAIL]

To SEND immediately (only after user confirms):
[SEND_EMAIL]
TO: recipient@email.com
SUBJECT: Subject here
BODY:
Email body here
[/SEND_EMAIL]

RULES:
- Always DRAFT first, show to user, ask "Shall I send this? Reply *yes send* to confirm"
- Only use [SEND_EMAIL] when user says "yes send", "send it", "yes" after seeing draft
- Sign all emails: Felix | Sales Agent | SBL IT Platforms Co., Ltd. | www.sblplat.co.th

SALES TASKS: Lead generation, bilingual outreach (English+Thai), proposals, follow-ups, pipeline tracking, closing, sending emails.
FORMAT: Slack markdown *bold*, • bullets, emojis. Concise. Always end with next step.
LANGUAGE: English default, switch to Thai if user writes Thai. Use ฿ for Baht.`;

const conversations = new Map();
const processed = new Set();
const pendingDrafts = new Map();
let BOT_ID = null;

function parseEmailCommand(text) {
  const sendMatch = text.match(/\[SEND_EMAIL\]([\s\S]*?)\[\/SEND_EMAIL\]/);
  const draftMatch = text.match(/\[DRAFT_EMAIL\]([\s\S]*?)\[\/DRAFT_EMAIL\]/);
  if (sendMatch) {
    const b = sendMatch[1];
    return { action: 'send', to: b.match(/TO:\s*(.+)/)?.[1]?.trim(), subject: b.match(/SUBJECT:\s*(.+)/)?.[1]?.trim(), body: b.match(/BODY:\s*([\s\S]+)/)?.[1]?.trim(), raw: sendMatch[0] };
  }
  if (draftMatch) {
    const b = draftMatch[1];
    return { action: 'draft', to: b.match(/TO:\s*(.+)/)?.[1]?.trim(), subject: b.match(/SUBJECT:\s*(.+)/)?.[1]?.trim(), body: b.match(/BODY:\s*([\s\S]+)/)?.[1]?.trim(), raw: draftMatch[0] };
  }
  return null;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'Felix', gmail: GMAIL_PASS ? 'connected' : 'not configured', company: 'SBL IT Platforms Co., Ltd.' });
});

app.post('/slack/events', async (req, res) => {
  const body = req.body;
  if (body && body.type === 'url_verification') return res.status(200).json({ challenge: body.challenge });
  res.status(200).end('OK');

  const event = body && body.event;
  if (!event || event.type !== 'message' || event.subtype || event.bot_id) return;

  const key = event.client_msg_id || event.ts;
  if (processed.has(key)) return;
  processed.add(key);
  setTimeout(() => processed.delete(key), 60000);

  if (!BOT_ID) {
    try {
      const r = await fetch('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
      const d = await r.json();
      BOT_ID = d.user_id;
    } catch (e) { return; }
  }

  const isMentioned = event.text && event.text.includes(`<@${BOT_ID}>`);
  const isDM = event.channel_type === 'im';
  if (!isMentioned && !isDM) return;

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const convKey = isDM ? event.user : `${channel}:${threadTs}`;

  if (!userText) {
    await post(channel, `*สวัสดีครับ!* 👋 I'm *Felix*, Sales Agent for SBL IT Platforms!\n\n📧 I can now *send emails* from ${GMAIL_USER}\n\n• \`@Felix draft outreach email to buyer@shop.com\`\n• \`@Felix generate 5 leads for gyms in Bangkok\`\n• \`@Felix create sales proposal\`\n• \`@Felix how to hit ฿250k this month\``, threadTs);
    return;
  }

  // Check if user is confirming a pending email draft
  const lowerText = userText.toLowerCase();
  const pendingDraft = pendingDrafts.get(convKey);
  if (pendingDraft && (lowerText.includes('yes send') || lowerText === 'yes' || lowerText === 'send' || lowerText === 'send it' || lowerText === 'ส่ง')) {
    try {
      await sendEmail(pendingDraft.to, pendingDraft.subject, pendingDraft.body);
      pendingDrafts.delete(convKey);
      await post(channel, `✅ *Email sent successfully!*\n• *To:* ${pendingDraft.to}\n• *Subject:* ${pendingDraft.subject}\n\nDelivered from ${GMAIL_USER} 📧\n\nNext: Want me to log this in your pipeline or follow up in 3 days?`, threadTs);
      return;
    } catch (e) {
      await post(channel, `⚠️ Failed to send email: ${e.message}`, threadTs);
      return;
    }
  }

  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const hist = conversations.get(convKey);
  hist.push({ role: 'user', content: userText });
  if (hist.length > 20) hist.splice(0, hist.length - 20);

  const typing = await post(channel, '_Felix is thinking... 🤔_', threadTs);

  try {
    const reply = await claude(hist);
    hist.push({ role: 'assistant', content: reply });
    if (typing && typing.ts) await del(channel, typing.ts);

    const emailCmd = parseEmailCommand(reply);
    if (emailCmd) {
      const displayText = reply.replace(emailCmd.raw, '').trim();

      if (emailCmd.action === 'draft') {
        // Store draft and show it
        pendingDrafts.set(convKey, emailCmd);
        const draftDisplay = `${displayText ? displayText + '\n\n' : ''}📧 *Email Draft Ready:*\n• *To:* ${emailCmd.to}\n• *Subject:* ${emailCmd.subject}\n\n*Body:*\n${emailCmd.body}\n\n---\n_Reply *yes send* to send this email, or tell me what to change._`;
        await post(channel, draftDisplay, threadTs);

      } else if (emailCmd.action === 'send') {
        if (displayText) await post(channel, displayText, threadTs);
        try {
          await sendEmail(emailCmd.to, emailCmd.subject, emailCmd.body);
          await post(channel, `✅ *Email sent!*\n• *To:* ${emailCmd.to}\n• *Subject:* ${emailCmd.subject}\n\nDelivered from ${GMAIL_USER} 📧`, threadTs);
        } catch (e) {
          await post(channel, `⚠️ Email error: ${e.message}`, threadTs);
        }
      }
    } else {
      await post(channel, reply, threadTs);
    }
  } catch (e) {
    if (typing && typing.ts) await del(channel, typing.ts);
    await post(channel, `⚠️ Error: ${e.message}`, threadTs);
  }
});

app.post('/slack/commands', async (req, res) => {
  const p = new URLSearchParams(req.rawBody);
  const text = p.get('text') || 'Hello';
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
  } catch (e) { return null; }
}

async function del(channel, ts) {
  try {
    await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify({ channel, ts })
    });
  } catch (e) {}
}

async function claude(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, system: FELIX_SYSTEM, messages })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${d.error?.message || JSON.stringify(d)}`);
  return d.content?.map(b => b.text || '').join('') || 'No response.';
}

app.listen(PORT, () => console.log(`🤖 Felix + Gmail running on port ${PORT}`));
