'use strict';
const express = require('express');
const app = express();
const PORT = Number(process.env.PORT) || 3000;

const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const SLACK_TOKEN = (process.env.SLACK_BOT_TOKEN || '').trim();
const GMAIL_USER = process.env.GMAIL_USER || 'saybelfinancing@gmail.com';
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
const OAUTH_REFRESH_TOKEN = (process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '').trim();
const OAUTH_CLIENT_ID = (process.env.GMAIL_CLIENT_ID || '').trim();
const OAUTH_CLIENT_SECRET = (process.env.GMAIL_CLIENT_SECRET || '').trim();
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';

app.use((req, res, next) => {
  req.rawBody = '';
  req.on('data', chunk => { req.rawBody += chunk.toString(); });
  req.on('end', () => {
    try { req.body = req.rawBody ? JSON.parse(req.rawBody) : {}; }
    catch { req.body = {}; }
    next();
  });
});

// ── Gmail ─────────────────────────────────────────────────────
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

// ── OAuth Token ───────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getOAuthToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('OAuth failed: ' + JSON.stringify(d));
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + 3500000;
  return cachedToken;
}

// ── Google Sheets via OAuth ───────────────────────────────────
async function createSheet(title) {
  const token = await getOAuthToken();
  const metadata = { name: title, mimeType: 'application/vnd.google-apps.spreadsheet' };
  if (DRIVE_FOLDER_ID) metadata.parents = [DRIVE_FOLDER_ID];
  const r = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  });
  const d = await r.json();
  if (!d.id) throw new Error('Failed to create sheet: ' + JSON.stringify(d));
  return d.id;
}

async function readSheet(id, range) {
  const token = await getOAuthToken();
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range || 'Sheet1')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return (await r.json()).values || [];
}

async function appendSheet(id, range, values) {
  const token = await getOAuthToken();
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values })
    }
  );
}

async function listDriveFiles(query) {
  const token = await getOAuthToken();
  const q = query ? `name contains '${query}'` : '';
  const url = `https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name,mimeType)${q ? '&q=' + encodeURIComponent(q) : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()).files || [];
}

// ── File Processing ───────────────────────────────────────────
async function downloadFile(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
  if (!r.ok) throw new Error(`Cannot download: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function processFile(file) {
  const buf = await downloadFile(file.url_private);
  const mime = file.mimetype || '';
  const name = file.name || '';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    const pdfParse = require('pdf-parse');
    return { type: 'pdf', content: (await pdfParse(buf)).text.substring(0, 10000), name };
  }
  if (mime.includes('spreadsheet') || mime.includes('excel') || name.endsWith('.xlsx')) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    let text = '';
    wb.eachSheet(s => { s.eachRow(r => { text += r.values.slice(1).join('\t') + '\n'; }); });
    return { type: 'excel', content: text.substring(0, 10000), name };
  }
  if (mime.includes('word') || name.endsWith('.docx')) {
    const mammoth = require('mammoth');
    return { type: 'word', content: (await mammoth.extractRawText({ buffer: buf })).value.substring(0, 10000), name };
  }
  if (mime.startsWith('image/')) {
    return { type: 'image', content: buf.toString('base64'), mimetype: mime, name };
  }
  return null;
}

// ── Command Parser ────────────────────────────────────────────
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

function parseGoogleCommand(text) {
  const cmds = ['CREATE_SHEET','READ_SHEET','APPEND_SHEET','LIST_FILES'];
  for (const cmd of cmds) {
    const m = text.match(new RegExp(`\\[${cmd}\\]([\\s\\S]*?)\\[\\/${cmd}\\]`));
    if (m) {
      const block = m[1];
      const result = { action: cmd, raw: m[0] };
      const id = block.match(/ID:\s*(.+)/)?.[1]?.trim();
      const range = block.match(/RANGE:\s*(.+)/)?.[1]?.trim();
      const title = block.match(/TITLE:\s*(.+)/)?.[1]?.trim();
      const query = block.match(/QUERY:\s*(.+)/)?.[1]?.trim();
      const row = block.match(/ROW:\s*(.+)/)?.[1]?.trim();
      if (id) result.id = id;
      if (range) result.range = range;
      if (title) result.title = title;
      if (query) result.query = query;
      if (row) result.row = row;
      return result;
    }
  }
  return null;
}

// ── Felix System Prompt ───────────────────────────────────────
const FELIX_SYSTEM = `You are Felix, the B2B Sales AI Agent for SBL IT Platforms Co., Ltd.
You can send emails, read files, and create/read Google Sheets.

COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store
TARGETS: Revenue ฿250,000/month | New B2B Clients: 10-20/month

PRODUCTS:
- SBL Water 0.5L Glass: ฿54(500+)/฿58(40-499)/฿60(credit)/฿65(retail)
- SBL Water 0.5L PET: ฿44(500+)/฿48(40-499)/฿50(credit)/฿55(retail)
- FitnesShock Brownies (4 flavors) 50g: ฿75/pc
- SHOCKS! Bars (Pistachio/Peanut) 50g: ฿65/pc
- FitnesShock Dessert Bars 60g: ฿75/pc — 20g protein!
- NEW Glazed Bars 35g: ฿60/pc

FILE ANALYSIS: When files are attached, analyze them thoroughly:
- Excel: read all data, identify leads, prices, contacts
- PDF: extract key info, summarize findings
- Word: read content and provide insights
- Images: describe and analyze visually

EMAIL COMMANDS:
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

GOOGLE SHEETS COMMANDS:
[CREATE_SHEET]
TITLE: Sheet name
[/CREATE_SHEET]

[READ_SHEET]
ID: spreadsheet_id
RANGE: Sheet1!A1:Z100
[/READ_SHEET]

[APPEND_SHEET]
ID: spreadsheet_id
RANGE: Sheet1
ROW: value1,value2,value3
[/APPEND_SHEET]

[LIST_FILES]
QUERY: search term
[/LIST_FILES]

RULES:
- Always DRAFT emails first, send only after user confirms with "yes send"
- When creating sheets, confirm with link
- Sign emails: Felix | Sales Agent | SBL IT Platforms Co., Ltd.

TASKS: Lead generation, bilingual outreach (EN+TH), proposals, follow-ups, pipeline, file analysis.
FORMAT: Slack *bold*, bullets, emojis. Always end with next step.
LANGUAGE: English default, Thai if user writes Thai.`;

// ── State ─────────────────────────────────────────────────────
const conversations = new Map();
const pendingDrafts = new Map();
const processed = new Set();
let BOT_ID = null;

// ── Claude ────────────────────────────────────────────────────
async function claude(messages, fileData) {
  let msgs = [...messages];
  if (fileData) {
    const last = msgs[msgs.length - 1];
    if (fileData.type === 'image') {
      msgs[msgs.length - 1] = {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: fileData.mimetype, data: fileData.content } },
          { type: 'text', text: last.content + `\n\n[Image: ${fileData.name}]` }
        ]
      };
    } else {
      msgs[msgs.length - 1] = {
        role: 'user',
        content: `${last.content}\n\n[File: ${fileData.name} (${fileData.type.toUpperCase()})]\n${fileData.content}`
      };
    }
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8192, system: FELIX_SYSTEM, messages: msgs })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Claude ${r.status}: ${d.error?.message}`);
  return d.content?.map(b => b.text || '').join('') || 'No response.';
}

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
  } catch { return null; }
}

async function del(channel, ts) {
  try {
    await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify({ channel, ts })
    });
  } catch {}
}

// ── Health ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok', agent: 'Felix',
    gmail: GMAIL_PASS ? 'configured' : 'missing',
    googleDrive: OAUTH_REFRESH_TOKEN ? 'oauth connected' : 'not configured',
    fileReading: 'pdf, excel, word, images'
  });
});

// ── Slack Events ──────────────────────────────────────────────
app.post('/slack/events', async (req, res) => {
  const body = req.body;
  if (body?.type === 'url_verification') return res.status(200).json({ challenge: body.challenge });
  res.status(200).end('OK');

  const event = body?.event;
  if (!event || event.type !== 'message' || event.bot_id) return;
  if (event.subtype && event.subtype !== 'file_share') return;

  const key = event.client_msg_id || event.ts;
  if (processed.has(key)) return;
  processed.add(key);
  setTimeout(() => processed.delete(key), 60000);

  if (!BOT_ID) {
    try {
      const r = await fetch('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
      BOT_ID = (await r.json()).user_id;
    } catch { return; }
  }

  const isMentioned = (event.text || '').includes(`<@${BOT_ID}>`);
  const isDM = event.channel_type === 'im';
  if (!isMentioned && !isDM) return;

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const hasFiles = event.files?.length > 0;
  const convKey = isDM ? event.user : `${channel}:${threadTs}`;

  if (!userText && !hasFiles) {
    await post(channel, `*สวัสดีครับ!* 👋 I'm *Felix*, Sales Agent for SBL IT Platforms!\n\n✅ Gmail — send from ${GMAIL_USER}\n✅ Google Drive — create/read sheets\n✅ Files — PDF, Excel, Word, Images\n\n• \`@Felix analyze this Excel file\`\n• \`@Felix create a sales tracking sheet\`\n• \`@Felix draft outreach email to gym@example.com\`\n• \`@Felix generate leads for Bangkok gyms\``, threadTs);
    return;
  }

  // Check email confirmation
  const lowerText = userText.toLowerCase();
  const pending = pendingDrafts.get(convKey);
  if (pending && (lowerText === 'yes send' || lowerText === 'send' || lowerText === 'yes' || lowerText === 'send it')) {
    try {
      await sendEmail(pending.to, pending.subject, pending.body);
      pendingDrafts.delete(convKey);
      await post(channel, `✅ *Email sent!*\n• *To:* ${pending.to}\n• *Subject:* ${pending.subject}\n\nDelivered from ${GMAIL_USER} 📧`, threadTs);
      return;
    } catch (e) {
      await post(channel, `⚠️ Send failed: ${e.message}`, threadTs);
      return;
    }
  }

  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const hist = conversations.get(convKey);
  const prompt = userText || 'Analyze this file and provide sales insights.';
  hist.push({ role: 'user', content: prompt });
  if (hist.length > 20) hist.splice(0, 2);

  const typing = await post(channel, '_Felix is thinking... 🤔_', threadTs);

  try {
    let fileData = null;
    if (hasFiles) {
      try {
        fileData = await processFile(event.files[0]);
        if (fileData && fileData.type !== 'image') {
          await post(channel, `📎 Reading: *${event.files[0].name}*...`, threadTs);
        }
      } catch (e) {
        await post(channel, `⚠️ Could not read file: ${e.message}`, threadTs);
      }
    }

    const reply = await claude(hist, fileData);
    hist.push({ role: 'assistant', content: reply });
    if (typing?.ts) await del(channel, typing.ts);

    // Handle email commands
    const emailCmd = parseEmailCommand(reply);
    if (emailCmd) {
      const displayText = reply.replace(emailCmd.raw, '').trim();
      if (emailCmd.action === 'draft') {
        pendingDrafts.set(convKey, emailCmd);
        const msg = `${displayText ? displayText + '\n\n' : ''}📧 *Email Draft:*\n• *To:* ${emailCmd.to}\n• *Subject:* ${emailCmd.subject}\n\n*Body:*\n${emailCmd.body}\n\n---\n_Reply *yes send* to send_`;
        await post(channel, msg, threadTs);
      } else if (emailCmd.action === 'send') {
        if (displayText) await post(channel, displayText, threadTs);
        try {
          await sendEmail(emailCmd.to, emailCmd.subject, emailCmd.body);
          await post(channel, `✅ *Email sent!*\n• *To:* ${emailCmd.to}\n• *Subject:* ${emailCmd.subject}`, threadTs);
        } catch (e) {
          await post(channel, `⚠️ Email error: ${e.message}`, threadTs);
        }
      }
      return;
    }

    // Handle Google commands
    let text = reply;
    let gCmd = parseGoogleCommand(text);
    while (gCmd) {
      text = text.replace(gCmd.raw, '').trim();
      try {
        let result = '';
        if (gCmd.action === 'CREATE_SHEET') {
          const id = await createSheet(gCmd.title || 'New Sheet');
          result = `✅ *Sheet created in your Drive!*\n• *${gCmd.title}*\n• 📊 https://docs.google.com/spreadsheets/d/${id}`;
        } else if (gCmd.action === 'READ_SHEET') {
          const rows = await readSheet(gCmd.id, gCmd.range);
          if (!rows.length) { result = '📊 Sheet is empty.'; }
          else {
            const headers = rows[0];
            const data = rows.slice(1, 11);
            result = `📊 *Sheet data (${rows.length - 1} rows):*\n` + data.map(row => '• ' + headers.map((h, i) => `*${h}:* ${row[i] || '-'}`).slice(0, 5).join(' | ')).join('\n');
          }
        } else if (gCmd.action === 'APPEND_SHEET') {
          await appendSheet(gCmd.id, gCmd.range || 'Sheet1', [gCmd.row.split(',').map(v => v.trim())]);
          result = `✅ Row added to sheet!`;
        } else if (gCmd.action === 'LIST_FILES') {
          const files = await listDriveFiles(gCmd.query);
          result = files.length ? `📁 *Drive files:*\n` + files.map(f => `• *${f.name}* ${f.mimeType?.includes('spreadsheet') ? '📊' : '📄'} \`${f.id}\``).join('\n') : '📁 No files found.';
        }
        if (result) await post(channel, result, threadTs);
      } catch (e) {
        await post(channel, `⚠️ Google error: ${e.message}`, threadTs);
      }
      gCmd = parseGoogleCommand(text);
    }
    if (text) await post(channel, text, threadTs);

  } catch (e) {
    console.error('Error:', e.message);
    if (typing?.ts) await del(channel, typing.ts);
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
    const reply = await claude(hist, null);
    hist.push({ role: 'assistant', content: reply });
    await post(channel_id, `*Felix:* ${reply}`);
  } catch (e) { await post(channel_id, `⚠️ Error: ${e.message}`); }
});

app.listen(PORT, () => console.log(`🤖 Felix running on port ${PORT} — Gmail + Drive + Files`));
