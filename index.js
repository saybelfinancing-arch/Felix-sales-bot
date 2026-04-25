const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/\s+/g, '').trim();
const SLACK_TOKEN = (process.env.SLACK_BOT_TOKEN || '').replace(/\s+/g, '').trim();
const GMAIL_USER = process.env.GMAIL_USER || 'saybelfinancing@gmail.com';
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';

app.use((req, res, next) => {
  req.rawBody = '';
  req.on('data', chunk => { req.rawBody += chunk.toString(); });
  req.on('end', () => {
    try { req.body = req.rawBody ? JSON.parse(req.rawBody) : {}; }
    catch { req.body = {}; }
    next();
  });
});

// ── Google Auth ───────────────────────────────────────────────
async function getGoogleToken() {
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');

  const { createSign } = await import('node:crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(credentials.private_key, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Google auth failed: ' + JSON.stringify(d));
  return d.access_token;
}

// ── Google Drive: List files ──────────────────────────────────
async function listDriveFiles(query = '') {
  const token = await getGoogleToken();
  const q = query ? `name contains '${query}'` : '';
  const url = `https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime)${q ? '&q=' + encodeURIComponent(q) : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  return d.files || [];
}

// ── Google Sheets: Read ───────────────────────────────────────
async function readSheet(spreadsheetId, range = 'Sheet1') {
  const token = await getGoogleToken();
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await r.json();
  return d.values || [];
}

// ── Google Sheets: Write ──────────────────────────────────────
async function writeSheet(spreadsheetId, range, values) {
  const token = await getGoogleToken();
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values })
    }
  );
  return r.json();
}

// ── Google Sheets: Append ─────────────────────────────────────
async function appendSheet(spreadsheetId, range, values) {
  const token = await getGoogleToken();
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values })
    }
  );
  return r.json();
}

// ── Google Sheets: Create new spreadsheet ────────────────────
async function createSheet(title) {
  const token = await getGoogleToken();
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { title } })
  });
  return r.json();
}

// ── Send Email ────────────────────────────────────────────────
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
You have FULL access to Gmail and Google Drive/Sheets.

COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store
TARGETS: Revenue ฿250,000/month | New B2B Clients: 10-20/month

PRODUCTS:
- SBL Water 0.5L Glass: ฿54(500+)/฿58(40-499)/฿60(credit)/฿65(retail)
- SBL Water 0.5L PET: ฿44(500+)/฿48(40-499)/฿50(credit)/฿55(retail)
- FitnesShock Brownies (4 flavors) 50g: ฿75/pc
- SHOCKS! Bars (Pistachio/Peanut) 50g: ฿65/pc
- FitnesShock Dessert Bars 60g: ฿75/pc — 20g protein!
- NEW Glazed Bars 35g: ฿60/pc

COMMANDS — use these exact formats when needed:

EMAIL:
[DRAFT_EMAIL]
TO: email@domain.com
SUBJECT: Subject
BODY:
Body text
[/DRAFT_EMAIL]

[SEND_EMAIL]
TO: email@domain.com
SUBJECT: Subject
BODY:
Body text
[/SEND_EMAIL]

GOOGLE DRIVE:
[LIST_FILES]
QUERY: search term (optional)
[/LIST_FILES]

[READ_SHEET]
ID: spreadsheet_id_here
RANGE: Sheet1!A1:Z100
[/READ_SHEET]

[WRITE_SHEET]
ID: spreadsheet_id_here
RANGE: Sheet1!A1
DATA: value1,value2,value3
[/WRITE_SHEET]

[APPEND_SHEET]
ID: spreadsheet_id_here
RANGE: Sheet1
ROW: value1,value2,value3,value4
[/APPEND_SHEET]

[CREATE_SHEET]
TITLE: New Spreadsheet Name
[/CREATE_SHEET]

RULES:
- Always DRAFT emails first, then send only after user confirms with "yes send"
- When reading sheets, summarize data clearly in Slack format
- When writing data, confirm what you wrote
- Sign emails: Felix | Sales Agent | SBL IT Platforms Co., Ltd.

TASKS: Lead gen, proposals, outreach (EN+TH), pipeline tracking, reading/writing Google Sheets, sending emails.
FORMAT: Slack markdown *bold*, • bullets, emojis. Always end with next step.
LANGUAGE: English default, Thai if user writes Thai.`;

const conversations = new Map();
const processed = new Set();
const pendingDrafts = new Map();
let BOT_ID = null;

// ── Parse commands ────────────────────────────────────────────
function parseCommand(text) {
  const commands = ['SEND_EMAIL','DRAFT_EMAIL','LIST_FILES','READ_SHEET','WRITE_SHEET','APPEND_SHEET','CREATE_SHEET'];
  for (const cmd of commands) {
    const match = text.match(new RegExp(`\\[${cmd}\\]([\\s\\S]*?)\\[\\/${cmd}\\]`));
    if (match) {
      const block = match[1];
      const result = { action: cmd.toLowerCase(), raw: match[0] };
      const to = block.match(/TO:\s*(.+)/)?.[1]?.trim();
      const subject = block.match(/SUBJECT:\s*(.+)/)?.[1]?.trim();
      const body = block.match(/BODY:\s*([\s\S]+)/)?.[1]?.trim();
      const id = block.match(/ID:\s*(.+)/)?.[1]?.trim();
      const range = block.match(/RANGE:\s*(.+)/)?.[1]?.trim();
      const query = block.match(/QUERY:\s*(.+)/)?.[1]?.trim();
      const data = block.match(/DATA:\s*(.+)/)?.[1]?.trim();
      const row = block.match(/ROW:\s*(.+)/)?.[1]?.trim();
      const title = block.match(/TITLE:\s*(.+)/)?.[1]?.trim();
      if (to) result.to = to;
      if (subject) result.subject = subject;
      if (body) result.body = body;
      if (id) result.id = id;
      if (range) result.range = range;
      if (query) result.query = query;
      if (data) result.data = data;
      if (row) result.row = row;
      if (title) result.title = title;
      return result;
    }
  }
  return null;
}

// ── Execute command ───────────────────────────────────────────
async function executeCommand(cmd, convKey) {
  switch (cmd.action) {
    case 'draft_email':
      pendingDrafts.set(convKey, cmd);
      return `📧 *Email Draft Ready:*\n• *To:* ${cmd.to}\n• *Subject:* ${cmd.subject}\n\n*Body:*\n${cmd.body}\n\n---\n_Reply *yes send* to send, or tell me what to change._`;

    case 'send_email':
      await sendEmail(cmd.to, cmd.subject, cmd.body);
      return `✅ *Email sent!*\n• *To:* ${cmd.to}\n• *Subject:* ${cmd.subject}\nDelivered from ${GMAIL_USER} 📧`;

    case 'list_files': {
      const files = await listDriveFiles(cmd.query);
      if (!files.length) return `📁 No files found${cmd.query ? ` for "${cmd.query}"` : ''}.`;
      const list = files.map(f => `• *${f.name}* — ${f.mimeType.includes('spreadsheet') ? '📊' : '📄'} \`${f.id}\``).join('\n');
      return `📁 *Google Drive Files:*\n${list}\n\n_Use the ID to read a spreadsheet!_`;
    }

    case 'read_sheet': {
      const rows = await readSheet(cmd.id, cmd.range);
      if (!rows.length) return `📊 Sheet is empty or range not found.`;
      const headers = rows[0];
      const data = rows.slice(1).slice(0, 10); // show first 10 rows
      const table = data.map(row => '• ' + headers.map((h, i) => `*${h}:* ${row[i] || '-'}`).join(' | ')).join('\n');
      return `📊 *Sheet Data* (${rows.length - 1} rows):\n${table}${rows.length > 11 ? `\n_...and ${rows.length - 11} more rows_` : ''}`;
    }

    case 'append_sheet': {
      const values = [cmd.row.split(',').map(v => v.trim())];
      await appendSheet(cmd.id, cmd.range, values);
      return `✅ *Row added to sheet!*\n• Data: ${cmd.row}`;
    }

    case 'write_sheet': {
      const values = [cmd.data.split(',').map(v => v.trim())];
      await writeSheet(cmd.id, cmd.range, values);
      return `✅ *Sheet updated!*\n• Range: ${cmd.range}\n• Data: ${cmd.data}`;
    }

    case 'create_sheet': {
      const sheet = await createSheet(cmd.title);
      return `✅ *New spreadsheet created!*\n• *Title:* ${cmd.title}\n• *ID:* \`${sheet.spreadsheetId}\`\n• Open: https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}`;
    }

    default:
      return '⚠️ Unknown command.';
  }
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok', agent: 'Felix',
    gmail: GMAIL_PASS ? 'connected' : 'not configured',
    googleDrive: GOOGLE_SERVICE_ACCOUNT ? 'connected' : 'not configured',
    company: 'SBL IT Platforms Co., Ltd.'
  });
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
    await post(channel, `*สวัสดีครับ!* 👋 I'm *Felix*, Sales Agent for SBL IT Platforms!\n\n✅ *Gmail* — can send from ${GMAIL_USER}\n✅ *Google Drive* — can read/write your files\n✅ *Google Sheets* — can read, write, create sheets\n\n• \`@Felix list my Drive files\`\n• \`@Felix read my leads sheet\`\n• \`@Felix add lead to Google Sheet\`\n• \`@Felix create a new sales tracking sheet\`\n• \`@Felix draft email to client@gym.com\``, threadTs);
    return;
  }

  // Check for email confirmation
  const lowerText = userText.toLowerCase();
  const pendingDraft = pendingDrafts.get(convKey);
  if (pendingDraft && (lowerText === 'yes send' || lowerText === 'send' || lowerText === 'yes' || lowerText === 'send it')) {
    try {
      await sendEmail(pendingDraft.to, pendingDraft.subject, pendingDraft.body);
      pendingDrafts.delete(convKey);
      await post(channel, `✅ *Email sent!*\n• *To:* ${pendingDraft.to}\n• *Subject:* ${pendingDraft.subject}\nDelivered from ${GMAIL_USER} 📧`, threadTs);
      return;
    } catch (e) {
      await post(channel, `⚠️ Send failed: ${e.message}`, threadTs);
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

    const cmd = parseCommand(reply);
    if (cmd) {
      const displayText = reply.replace(cmd.raw, '').trim();
      if (displayText) await post(channel, displayText, threadTs);
      try {
        const result = await executeCommand(cmd, convKey);
        await post(channel, result, threadTs);
      } catch (e) {
        await post(channel, `⚠️ Error: ${e.message}`, threadTs);
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
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${d.error?.message}`);
  return d.content?.map(b => b.text || '').join('') || 'No response.';
}

app.listen(PORT, () => console.log(`🤖 Felix + Gmail + Google Drive running on port ${PORT}`));
