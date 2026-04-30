'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
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
const MEMORY_FILE = '/tmp/felix-memory.json';

app.use((req, res, next) => {
  req.rawBody = '';
  req.on('data', chunk => { req.rawBody += chunk.toString(); });
  req.on('end', () => {
    try { req.body = req.rawBody ? JSON.parse(req.rawBody) : {}; }
    catch { req.body = {}; }
    next();
  });
});

// ââ Persistent Memory âââââââââââââââââââââââââââââââââââââââââ
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    }
  } catch (e) { console.error('Memory load error:', e.message); }
  return { conversations: {}, actions: [], sheets: {}, partners: [] };
}

function saveMemory(memory) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (e) { console.error('Memory save error:', e.message); }
}

let memory = loadMemory();
console.log('Memory loaded â conversations:', Object.keys(memory.conversations).length);

// ââ OAuth Token âââââââââââââââââââââââââââââââââââââââââââââââ
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

// ââ Gmail API âââââââââââââââââââââââââââââââââââââââââââââââââ
async function sendEmail(to, subject, body) {
  const token = await getOAuthToken();
  const emailLines = [
    `From: Felix @ SBL IT Platforms <${GMAIL_USER}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body
  ];
  const raw = Buffer.from(emailLines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Gmail error: ' + JSON.stringify(d));
  return d;
}

async function readEmails(query, maxResults = 5) {
  const token = await getOAuthToken();
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await r.json();
  if (!d.messages) return [];
  const messages = await Promise.all(d.messages.slice(0, 5).map(async msg => {
    const mr = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject,From,Date`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const md = await mr.json();
    const headers = md.payload?.headers || [];
    return {
      subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
      from: headers.find(h => h.name === 'From')?.value || '',
      date: headers.find(h => h.name === 'Date')?.value || '',
      snippet: md.snippet || ''
    };
  }));
  return messages;
}

// ââ Google Drive & Sheets âââââââââââââââââââââââââââââââââââââ
async function createSheet(title, headers) {
  const token = await getOAuthToken();
  const metadata = { name: title, mimeType: 'application/vnd.google-apps.spreadsheet' };
  if (DRIVE_FOLDER_ID) metadata.parents = [DRIVE_FOLDER_ID];
  const r = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  });
  const d = await r.json();
  if (!d.id) throw new Error('Failed to create: ' + JSON.stringify(d));
  if (headers && headers.length > 0) await appendSheet(d.id, 'Sheet1', [headers]);
  memory.sheets[title] = d.id;
  saveMemory(memory);
  return d.id;
}

async function deleteSheet(fileId) {
  const token = await getOAuthToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.ok;
}

async function shareSheet(fileId, email, role = 'writer') {
  const token = await getOAuthToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, type: 'user', emailAddress: email })
  });
  return r.json();
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

async function updateSheet(id, range, values) {
  const token = await getOAuthToken();
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values })
    }
  );
}

async function clearSheet(id, range) {
  const token = await getOAuthToken();
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  );
}

async function listDriveFiles(query) {
  const token = await getOAuthToken();
  const q = query ? `name contains '${query}'` : '';
  const url = `https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime)${q ? '&q=' + encodeURIComponent(q) : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()).files || [];
}

// ââ File Processing âââââââââââââââââââââââââââââââââââââââââââ
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

// ââ Command Parser ââââââââââââââââââââââââââââââââââââââââââââ
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
  const cmds = ['CREATE_SHEET','READ_SHEET','APPEND_SHEET','UPDATE_SHEET','CLEAR_SHEET','DELETE_SHEET','SHARE_SHEET','LIST_FILES','READ_EMAIL'];
  for (const cmd of cmds) {
    const m = text.match(new RegExp(`\\[${cmd}\\]([\\s\\S]*?)\\[\\/${cmd}\\]`));
    if (m) {
      const block = m[1];
      const result = { action: cmd, raw: m[0] };
      ['ID','RANGE','TITLE','QUERY','ROW','EMAIL','ROLE','VALUES'].forEach(f => {
        const val = block.match(new RegExp(`${f}:\\s*(.+)`))?.[1]?.trim();
        if (val) result[f.toLowerCase()] = val;
      });
      return result;
    }
  }
  return null;
}

// ââ Felix System Prompt âââââââââââââââââââââââââââââââââââââââ
const FELIX_SYSTEM = `You are Felix, the B2B Sales AI Agent for SBL IT Platforms Co., Ltd.
You have FULL access to Gmail, Google Drive and Google Sheets â you can CREATE, READ, EDIT, DELETE and SHARE sheets.
You also have persistent memory of all previous conversations and actions.

COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store
TARGETS: Revenue à¸¿250,000/month | New B2B Clients: 10-20/month

PRODUCTS:
- SBL Water 0.5L Glass: à¸¿54(500+)/à¸¿58(40-499)/à¸¿60(credit)/à¸¿65(retail)
- SBL Water 0.5L PET: à¸¿44(500+)/à¸¿48(40-499)/à¸¿50(credit)/à¸¿55(retail)
- FitnesShock Brownies (4 flavors) 50g: à¸¿75/pc
- SHOCKS! Bars (Pistachio/Peanut) 50g: à¸¿65/pc
- FitnesShock Dessert Bars 60g: à¸¿75/pc â 20g protein!
- NEW Glazed Bars 35g: à¸¿60/pc

FILE ANALYSIS: When files are sent, analyze thoroughly â read all data, identify opportunities, give actionable insights.

EMAIL COMMANDS:
[DRAFT_EMAIL]
TO: email
SUBJECT: subject
BODY:
body
[/DRAFT_EMAIL]

[SEND_EMAIL]
TO: email
SUBJECT: subject
BODY:
body
[/SEND_EMAIL]

GOOGLE SHEETS â FULL ACCESS:
[CREATE_SHEET]
TITLE: Sheet name
[/CREATE_SHEET]

[READ_SHEET]
ID: sheet_id
RANGE: Sheet1!A1:Z100
[/READ_SHEET]

[APPEND_SHEET]
ID: sheet_id
RANGE: Sheet1
ROW: value1,value2,value3
[/APPEND_SHEET]

[UPDATE_SHEET]
ID: sheet_id
RANGE: Sheet1!A2
VALUES: value1,value2
[/UPDATE_SHEET]

[CLEAR_SHEET]
ID: sheet_id
RANGE: Sheet1!A2:Z1000
[/CLEAR_SHEET]

[DELETE_SHEET]
ID: sheet_id
[/DELETE_SHEET]

[SHARE_SHEET]
ID: sheet_id
EMAIL: user@email.com
ROLE: writer
[/SHARE_SHEET]

[LIST_FILES]
QUERY: search term
[/LIST_FILES]

[READ_EMAIL]
QUERY: from:client@email.com
[/READ_EMAIL]

RULES:
- Always DRAFT emails first, send only after "yes send"
- When creating sheets, add relevant headers automatically
- After EVERY significant action â save to memory
- Always send clickable links to created sheets
- Sign emails: Felix | Sales Agent | SBL IT Platforms

TASKS: Lead gen, proposals, outreach (EN+TH), pipeline, file analysis, email campaigns.
FORMAT: Slack *bold*, bullets, emojis. Always end with next step.
LANGUAGE: English default, Thai if user writes Thai.`;

// ââ State âââââââââââââââââââââââââââââââââââââââââââââââââââââ
const pendingDrafts = new Map();
const processed = new Set();
let BOT_ID = null;

// ââ Claude ââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function claude(messages, fileData, memoryContext) {
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

  // Add memory context to system prompt
  let systemWithMemory = FELIX_SYSTEM;
  if (memoryContext) {
    systemWithMemory += `\n\nMEMORY OF PREVIOUS ACTIONS:\n${memoryContext}`;
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8192, system: systemWithMemory, messages: msgs })
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

// ââ Health ââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/health', (req, res) => {
  res.json({
    status: 'ok', agent: 'Felix',
    gmail: 'oauth connected',
    googleSheets: 'full access â create/read/edit/delete/share',
    fileReading: 'pdf, excel, word, images',
    memory: `${Object.keys(memory.conversations).length} conversations, ${memory.actions.length} actions`
  });
});

// ââ Slack Events ââââââââââââââââââââââââââââââââââââââââââââââ
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
      console.log('Felix Bot ID:', BOT_ID);
    } catch { return; }
  }

  const isMentioned = (event.text || '').includes(`<@${BOT_ID}>`);
  const isDM = event.channel_type === 'im';
  const hasFiles = event.files?.length > 0;
  if (!isMentioned && !isDM) return;

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const convKey = isDM ? event.user : `${channel}:${threadTs}`;

  if (!userText && !hasFiles) {
    const sheetsList = Object.entries(memory.sheets).map(([name, id]) => `â¢ ${name}: https://docs.google.com/spreadsheets/d/${id}`).join('\n');
    await post(channel, `*à¸ªà¸§à¸±à¸ªà¸à¸µà¸à¸£à¸±à¸!* ð I'm *Felix*, Sales Agent for SBL IT Platforms!\n\nâ Gmail â send & read from ${GMAIL_USER}\nâ Google Sheets â create, edit, delete, share\nâ Files â PDF, Excel, Word, Images\nâ Memory â I remember our previous conversations\n\n${sheetsList ? `*My Sheets:*\n${sheetsList}\n\n` : ''}â¢ \`@Felix analyze this Excel file\`\nâ¢ \`@Felix create a leads tracking sheet\`\nâ¢ \`@Felix check my emails for bounces\`\nâ¢ \`@Felix share the leads sheet with manager@company.com\``, threadTs);
    return;
  }

  // Check email confirmation
  const lowerText = userText.toLowerCase();
  const pending = pendingDrafts.get(convKey);
  if (pending && (lowerText === 'yes send' || lowerText === 'send' || lowerText === 'yes' || lowerText === 'send it')) {
    try {
      await sendEmail(pending.to, pending.subject, pending.body);
      pendingDrafts.delete(convKey);
      memory.actions.push({ time: new Date().toISOString(), action: 'email_sent', to: pending.to, subject: pending.subject });
      if (memory.actions.length > 100) memory.actions = memory.actions.slice(-100);
      saveMemory(memory);
      await post(channel, `â *Email sent!*\nâ¢ *To:* ${pending.to}\nâ¢ *Subject:* ${pending.subject}\nDelivered from ${GMAIL_USER} ð§`, threadTs);
      return;
    } catch (e) {
      await post(channel, `â ï¸ Send failed: ${e.message}`, threadTs);
      return;
    }
  }

  // Load conversation history from persistent memory
  if (!memory.conversations[convKey]) memory.conversations[convKey] = [];
  const hist = memory.conversations[convKey];

  // Build memory context for Claude
  const recentActions = memory.actions.slice(-20).map(a => `[${a.time}] ${a.action}: ${JSON.stringify(a)}`).join('\n');
  const knownSheets = Object.entries(memory.sheets).map(([name, id]) => `${name}: ${id}`).join('\n');
  const memoryContext = [
    recentActions ? `Recent actions:\n${recentActions}` : '',
    knownSheets ? `Known sheets:\n${knownSheets}` : ''
  ].filter(Boolean).join('\n\n');

  const prompt = userText || 'Analyze this file and provide sales insights.';
  hist.push({ role: 'user', content: prompt });
  if (hist.length > 40) hist.splice(0, hist.length - 40);

  const typing = await post(channel, '_Felix is thinking... ð¤_', threadTs);

  try {
    let fileData = null;
    if (hasFiles) {
      try {
        fileData = await processFile(event.files[0]);
        if (fileData && fileData.type !== 'image') {
          await post(channel, `ð Reading: *${event.files[0].name}*...`, threadTs);
          memory.actions.push({ time: new Date().toISOString(), action: 'file_read', name: event.files[0].name });
          saveMemory(memory);
        }
      } catch (e) {
        await post(channel, `â ï¸ Could not read file: ${e.message}`, threadTs);
      }
    }

    const reply = await claude(hist, fileData, memoryContext);
    hist.push({ role: 'assistant', content: reply });
    memory.conversations[convKey] = hist;
    saveMemory(memory);

    if (typing?.ts) await del(channel, typing.ts);

    // Handle email commands
    const emailCmd = parseEmailCommand(reply);
    if (emailCmd) {
      const displayText = reply.replace(emailCmd.raw, '').trim();
      if (emailCmd.action === 'draft') {
        pendingDrafts.set(convKey, emailCmd);
        await post(channel, `${displayText ? displayText + '\n\n' : ''}ð§ *Email Draft:*\nâ¢ *To:* ${emailCmd.to}\nâ¢ *Subject:* ${emailCmd.subject}\n\n*Body:*\n${emailCmd.body}\n\n---\n_Reply *yes send* to send_`, threadTs);
      } else if (emailCmd.action === 'send') {
        if (displayText) await post(channel, displayText, threadTs);
        try {
          await sendEmail(emailCmd.to, emailCmd.subject, emailCmd.body);
          memory.actions.push({ time: new Date().toISOString(), action: 'email_sent', to: emailCmd.to, subject: emailCmd.subject });
          saveMemory(memory);
          await post(channel, `â *Email sent!*\nâ¢ *To:* ${emailCmd.to}\nâ¢ *Subject:* ${emailCmd.subject}`, threadTs);
        } catch (e) {
          await post(channel, `â ï¸ Email error: ${e.message}`, threadTs);
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
          const title = gCmd.title || 'New Sheet';
          let headers = [];
          const t = title.toLowerCase();
          if (t.includes('lead') || t.includes('sales') || t.includes('pipeline')) headers = ['Company','Contact','Email','Phone','Products','Status','Value (à¸¿)','Next Follow-up','Notes'];
          else if (t.includes('order') || t.includes('invoice')) headers = ['Order #','Date','Customer','Products','Qty','Amount (à¸¿)','Status','Payment','Notes'];
          else if (t.includes('customer') || t.includes('client')) headers = ['Company','Contact','Email','Phone','Category','Monthly Value (à¸¿)','Since','Status','Notes'];
          else if (t.includes('inventory') || t.includes('stock')) headers = ['Product','SKU','Category','Stock','Unit Price (à¸¿)','Location','Reorder Level','Notes'];
          else if (t.includes('campaign') || t.includes('outreach')) headers = ['Contact','Email','Company','Status','Sent Date','Response','Follow-up Date','Notes'];
          const id = await createSheet(title, headers);
          memory.actions.push({ time: new Date().toISOString(), action: 'sheet_created', title, id });
          saveMemory(memory);
          result = `â *Sheet created!*\nâ¢ *${title}*\n${headers.length ? `â¢ Headers: ${headers.slice(0,4).join(', ')}...\n` : ''}â¢ ð https://docs.google.com/spreadsheets/d/${id}`;

        } else if (gCmd.action === 'READ_SHEET') {
          const rows = await readSheet(gCmd.id, gCmd.range);
          if (!rows.length) result = 'ð Sheet is empty.';
          else {
            const headers = rows[0];
            const data = rows.slice(1, 11);
            result = `ð *Sheet data (${rows.length - 1} rows):*\n` + data.map(row => 'â¢ ' + headers.map((h, i) => `*${h}:* ${row[i] || '-'}`).slice(0, 4).join(' | ')).join('\n');
          }

        } else if (gCmd.action === 'APPEND_SHEET') {
          await appendSheet(gCmd.id, gCmd.range || 'Sheet1', [gCmd.row.split(',').map(v => v.trim())]);
          memory.actions.push({ time: new Date().toISOString(), action: 'row_added', id: gCmd.id });
          saveMemory(memory);
          result = `â Row added to sheet!`;

        } else if (gCmd.action === 'UPDATE_SHEET') {
          await updateSheet(gCmd.id, gCmd.range, [gCmd.values.split(',').map(v => v.trim())]);
          result = `â Sheet updated at ${gCmd.range}`;

        } else if (gCmd.action === 'CLEAR_SHEET') {
          await clearSheet(gCmd.id, gCmd.range || 'Sheet1');
          result = `â Sheet cleared: ${gCmd.range}`;

        } else if (gCmd.action === 'DELETE_SHEET') {
          const deleted = await deleteSheet(gCmd.id);
          if (deleted) {
            const name = Object.entries(memory.sheets).find(([n, id]) => id === gCmd.id)?.[0];
            if (name) delete memory.sheets[name];
            saveMemory(memory);
            result = `â Sheet deleted!`;
          } else result = `â ï¸ Could not delete sheet.`;

        } else if (gCmd.action === 'SHARE_SHEET') {
          await shareSheet(gCmd.id, gCmd.email, gCmd.role || 'writer');
          memory.actions.push({ time: new Date().toISOString(), action: 'sheet_shared', id: gCmd.id, email: gCmd.email });
          saveMemory(memory);
          result = `â Sheet shared with *${gCmd.email}* (${gCmd.role || 'writer'} access)\nâ¢ ð https://docs.google.com/spreadsheets/d/${gCmd.id}`;

        } else if (gCmd.action === 'LIST_FILES') {
          const files = await listDriveFiles(gCmd.query);
          result = files.length ? `ð *Drive files:*\n` + files.map(f => `â¢ *${f.name}* ${f.mimeType?.includes('spreadsheet') ? 'ð' : 'ð'} \`${f.id}\``).join('\n') : 'ð No files found.';

        } else if (gCmd.action === 'READ_EMAIL') {
          const emails = await readEmails(gCmd.query || '');
          if (!emails.length) result = `ð­ No emails found for: "${gCmd.query}"`;
          else result = `ð¬ *Emails (${emails.length}):*\n` + emails.map(e => `â¢ *${e.subject}*\n  From: ${e.from}\n  ${e.snippet}`).join('\n\n');
        }

        if (result) await post(channel, result, threadTs);
      } catch (e) {
        await post(channel, `â ï¸ Error: ${e.message}`, threadTs);
      }
      gCmd = parseGoogleCommand(text);
    }
    if (text) await post(channel, text, threadTs);

  } catch (e) {
    console.error('Error:', e.message);
    if (typing?.ts) await del(channel, typing.ts);
    await post(channel, `â ï¸ Error: ${e.message}`, threadTs);
  }
});

app.post('/slack/commands', async (req, res) => {
  const p = new URLSearchParams(req.rawBody);
  const text = p.get('text') || 'Hello';
  const channel_id = p.get('channel_id') || '';
  const user_id = p.get('user_id') || '';
  res.status(200).json({ response_type: 'in_channel', text: `_Felix is on it..._` });
  const convKey = `cmd:${user_id}`;
  if (!memory.conversations[convKey]) memory.conversations[convKey] = [];
  const hist = memory.conversations[convKey];
  hist.push({ role: 'user', content: text });
  try {
    const reply = await claude(hist, null, null);
    hist.push({ role: 'assistant', content: reply });
    memory.conversations[convKey] = hist;
    saveMemory(memory);
    await post(channel_id, `*Felix:* ${reply}`);
  } catch (e) { await post(channel_id, `â ï¸ Error: ${e.message}`); }
});

app.listen(PORT, () => console.log(`ð¤ Felix running on port ${PORT} â Full Gmail + Sheets + Memory`));
