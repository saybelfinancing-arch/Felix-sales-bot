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

// ── Persistent Memory ─────────────────────────────────────────
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
console.log('Memory loaded — conversations:', Object.keys(memory.conversations).length);

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

// ── Gmail API ─────────────────────────────────────────────────
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

// ── Google Drive & Sheets ─────────────────────────────────────
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

// ── Advanced Sheets ──────────────────────────────────────────
async function addSheetTab(spreadsheetId, sheetName) {
  const token = await getOAuthToken();
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] })
  });
  const d = await r.json();
  return d.replies && d.replies[0] && d.replies[0].addSheet && d.replies[0].addSheet.properties && d.replies[0].addSheet.properties.sheetId;
}

async function getSheetId(spreadsheetId, sheetName) {
  const token = await getOAuthToken();
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '?fields=sheets.properties', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const d = await r.json();
  const sheet = (d.sheets || []).find(function(s) { return s.properties.title === sheetName; });
  return sheet && sheet.properties.sheetId || 0;
}

async function addChart(spreadsheetId, sheetId, chartType, title) {
  const token = await getOAuthToken();
  const types = { bar: 'BAR', column: 'COLUMN', line: 'LINE', pie: 'PIE', area: 'AREA' };
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addChart: { chart: {
      spec: { title: title || 'Chart', basicChart: {
        chartType: types[chartType && chartType.toLowerCase()] || 'COLUMN',
        legendPosition: 'BOTTOM_LEGEND',
        series: [{ series: { sourceRange: { sources: [{ sheetId: sheetId, startRowIndex: 0, endRowIndex: 100, startColumnIndex: 1, endColumnIndex: 2 }] } } }],
        domains: [{ domain: { sourceRange: { sources: [{ sheetId: sheetId, startRowIndex: 0, endRowIndex: 100, startColumnIndex: 0, endColumnIndex: 1 }] } } }]
      }},
      position: { overlayPosition: { anchorCell: { sheetId: sheetId, rowIndex: 2, columnIndex: 4 } } }
    }}}]})
  });
  return r.json();
}

async function formatSheet(spreadsheetId, sheetId) {
  const token = await getOAuthToken();
  const requests = [
    { repeatCell: {
      range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: {
        backgroundColor: { red: 0.27, green: 0.45, blue: 0.77 },
        textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
        horizontalAlignment: 'CENTER'
      }},
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
    }},
    { autoResizeDimensions: { dimensions: { sheetId: sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 20 } } },
    { updateSheetProperties: { properties: { sheetId: sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } }
  ];
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests })
  });
  return r.json();
}

// ── Upload file to Slack ──────────────────────────────────────
async function uploadToSlack(channel, filename, fileBuffer, title) {
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SLACK_TOKEN },
    body: JSON.stringify({ filename, length: fileBuffer.length })
  });
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error('Cannot get upload URL: ' + urlData.error);
  await fetch(urlData.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fileBuffer
  });
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SLACK_TOKEN },
    body: JSON.stringify({ files: [{ id: urlData.file_id, title: title || filename }], channel_id: channel })
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error('Upload failed: ' + completeData.error);
  return completeData;
}

async function createExcelFile(title, headers, rows) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title);
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  ws.columns.forEach(function(col) { col.width = 20; });
  if (rows && rows.length > 0) rows.forEach(function(row) { ws.addRow(row); });
  return ws.workbook.xlsx.writeBuffer();
}

async function listDriveFiles(query) {
  const token = await getOAuthToken();
  const q = query ? `name contains '${query}'` : '';
  const url = `https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime)${q ? '&q=' + encodeURIComponent(q) : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()).files || [];
}


// ── Firecrawl API ─────────────────────────────────────────────
const FIRECRAWL_KEY = 'fc-a63e13f90ffa48e8b0070881835b0050';

async function firecrawlScrape(url) {
  try {
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + FIRECRAWL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: AbortSignal.timeout(30000)
    });
    const d = await r.json();
    if (d.success && d.data) return { success: true, text: (d.data.markdown || '').substring(0, 15000), url };
    return { success: false, error: JSON.stringify(d), url };
  } catch(e) { return { success: false, error: e.message, url }; }
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
  const cmds = ['CREATE_SHEET','ADD_SHEET_TAB','READ_SHEET','APPEND_SHEET','UPDATE_SHEET','CLEAR_SHEET','DELETE_SHEET','SHARE_SHEET','LIST_FILES','READ_EMAIL','ADD_CHART','FORMAT_SHEET','UPLOAD_EXCEL','EXPORT_SHEET','FETCH_URL','SEARCH_COMPANY','SAVE_PROSPECT','LOG_CONTACT'];
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

// ── Felix System Prompt ───────────────────────────────────────
const FELIX_SYSTEM = `You are Felix, the B2B Sales AI Agent for SBL IT Platforms Co., Ltd.
You have FULL access to Gmail, Google Drive and Google Sheets — you can CREATE, READ, EDIT, DELETE and SHARE sheets.
You also have persistent memory of all previous conversations and actions.

COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store
TARGETS: Revenue ฿250,000/month | New B2B Clients: 10-20/month

PRODUCTS:
- SBL Water 0.5L Glass: ฿54(500+)/฿58(40-499)/฿60(credit)/฿65(retail)
- SBL Water 0.5L PET: ฿44(500+)/฿48(40-499)/฿50(credit)/฿55(retail)
- FitnesShock Brownies (4 flavors) 50g: ฿75/pc
- SHOCKS! Bars (Pistachio/Peanut) 50g: ฿65/pc
- FitnesShock Dessert Bars 60g: ฿75/pc — 20g protein!
- NEW Glazed Bars 35g: ฿60/pc

FILE ANALYSIS: When files are sent, analyze thoroughly — read all data, identify opportunities, give actionable insights.

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

GOOGLE SHEETS — FULL ACCESS:
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

[ADD_SHEET_TAB]
ID: sheet_id
NAME: tab name
HEADERS: Col1,Col2,Col3
[/ADD_SHEET_TAB]

[ADD_CHART]
ID: sheet_id
SHEET: Sheet1
TYPE: column/bar/line/pie
TITLE: Chart Title
[/ADD_CHART]

[FORMAT_SHEET]
ID: sheet_id
SHEET: Sheet1
[/FORMAT_SHEET]

[UPLOAD_EXCEL]
TITLE: filename
HEADERS: Col1,Col2,Col3
[/UPLOAD_EXCEL]

[EXPORT_SHEET]
ID: sheet_id
TITLE: filename
[/EXPORT_SHEET]

[READ_EMAIL]
QUERY: from:client@email.com
[/READ_EMAIL]

WEB SCRAPING — when a website URL is shared:
[FETCH_URL]
URL: https://example.com
[/FETCH_URL]
IMPORTANT: After getting content from FETCH_URL — IMMEDIATELY analyze it in the same response. NEVER write "loading..." without actual content.

SEARCH FOR COMPANY INFO:
[SEARCH_COMPANY]
COMPANY: Company name
QUERY: optional search query
[/SEARCH_COMPANY]

SAVE PROSPECT TO PIPELINE:
[SAVE_PROSPECT]
COMPANY: Company name
CATEGORY: hotel/restaurant/shop/distributor/gym
LOCATION: Bangkok/Phuket/etc
CONTACT: name and contact info
STAGE: Prospect/Qualify/Pitch/Negotiate/Closed
VALUE: estimated monthly THB
NEXT: next action
[/SAVE_PROSPECT]

LOG CONTACT ACTION:
[LOG_CONTACT]
COMPANY: Company name
TYPE: call/email/visit/follow-up/sample-drop
NOTE: what happened, outcome, next step
[/LOG_CONTACT]

CRITICAL ANALYSIS RULES:
1. When [Website content for analysis] is in the message — THIS IS THE PRIMARY SOURCE. Use ONLY real data from it.
2. FORBIDDEN to write about a company what is not in the website content received.
3. ALWAYS list specific real products from the content (names, formats, prices if available).
4. NEVER write "waiting for data" if website content is already in the message — that is an error.
5. STRICT analysis structure:
   a) Real products from website (names, SKUs, prices in THB estimation)
   b) Which specific products fit Thailand market and WHY
   c) Real barriers found (shelf life? certifications mentioned?)
   d) Specific Thai sales channels for THIS category
   e) Financial model based on REAL product prices
   f) Personalized pitch with specific product names
6. If website failed to load — say so honestly, do not fake analysis.

RULES:
- Always DRAFT emails first, send only after "yes send"
- NEVER write "I'm analyzing..." without actual analysis — do it immediately
- After EVERY significant action — save to memory
- Always send clickable links to created sheets
- Sign emails: Felix | Sales Agent | SBL IT Platforms
- When prospect is mentioned — ALWAYS end with concrete next step + date

TASKS: B2B lead gen in Thailand, proposals, outreach (EN+TH), pipeline tracking, sample drops, follow-ups, file analysis, email campaigns.
FORMAT: Slack *bold*, bullets, emojis. Always end with next step + date.
LANGUAGE: English default, Thai if client writes Thai.`;

// ── State ─────────────────────────────────────────────────────
const pendingDrafts = new Map();
const processed = new Set();
let BOT_ID = null;

// ── Claude ────────────────────────────────────────────────────
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
  if (!text) return null;
  const MAX = 3800;
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX) {
    let splitAt = remaining.lastIndexOf('\n', MAX);
    if (splitAt < MAX / 2) splitAt = MAX;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);

  let lastResult = null;
  for (const chunk of chunks) {
    const body = { channel, text: chunk };
    if (thread_ts) body.thread_ts = thread_ts;
    try {
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
        body: JSON.stringify(body)
      });
      lastResult = await r.json();
    } catch { return null; }
  }
  return lastResult;
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
    gmail: 'oauth connected',
    googleSheets: 'full access — create/read/edit/delete/share',
    fileReading: 'pdf, excel, word, images',
    memory: `${Object.keys(memory.conversations).length} conversations, ${memory.actions.length} actions`
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
    const sheetsList = Object.entries(memory.sheets).map(([name, id]) => `• ${name}: https://docs.google.com/spreadsheets/d/${id}`).join('\n');
    await post(channel, `*สวัสดีครับ!* 👋 I'm *Felix*, Sales Agent for SBL IT Platforms!\n\n✅ Gmail — send & read from ${GMAIL_USER}\n✅ Google Sheets — create, edit, delete, share\n✅ Files — PDF, Excel, Word, Images\n✅ Memory — I remember our previous conversations\n\n${sheetsList ? `*My Sheets:*\n${sheetsList}\n\n` : ''}• \`@Felix analyze this Excel file\`\n• \`@Felix create a leads tracking sheet\`\n• \`@Felix check my emails for bounces\`\n• \`@Felix share the leads sheet with manager@company.com\``, threadTs);
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
      await post(channel, `✅ *Email sent!*\n• *To:* ${pending.to}\n• *Subject:* ${pending.subject}\nDelivered from ${GMAIL_USER} 📧`, threadTs);
      return;
    } catch (e) {
      await post(channel, `⚠️ Send failed: ${e.message}`, threadTs);
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

  let prompt = userText || 'Analyze this file and provide sales insights.';

  // ── Auto-detect URLs and fetch content before Claude call ──────────────
  const urlRegex = /https?:\/\/[^\s<>"]+/gi;
  const detectedUrls = [...new Set((userText || '').match(urlRegex) || [])];

  if (detectedUrls.length > 0) {
    let webContent = '';
    for (const wu of detectedUrls) {
      const direct = await fetchWebPage(wu);
      if (direct.success && direct.text) webContent += '[' + wu + ']:\n' + direct.text + '\n\n';
    }
    if (webContent) {
      prompt += '\n\n[Website content for analysis — use THIS DATA, do not make up info:]:\n' + webContent.substring(0, 8000);
    } else {
      prompt += '\n\n[IMPORTANT: Website ' + detectedUrls[0] + ' could not be loaded. Analyze based on available info only.]';
    }
  }

  hist.push({ role: 'user', content: prompt });
  if (hist.length > 40) hist.splice(0, hist.length - 40);

  const typing = await post(channel, '_Felix is thinking... 🤔_', threadTs);

  try {
    let fileData = null;
    if (hasFiles) {
      try {
        fileData = await processFile(event.files[0]);
        if (fileData && fileData.type !== 'image') {
          await post(channel, `📎 Reading: *${event.files[0].name}*...`, threadTs);
          memory.actions.push({ time: new Date().toISOString(), action: 'file_read', name: event.files[0].name });
          saveMemory(memory);
        }
      } catch (e) {
        await post(channel, `⚠️ Could not read file: ${e.message}`, threadTs);
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
        await post(channel, `${displayText ? displayText + '\n\n' : ''}📧 *Email Draft:*\n• *To:* ${emailCmd.to}\n• *Subject:* ${emailCmd.subject}\n\n*Body:*\n${emailCmd.body}\n\n---\n_Reply *yes send* to send_`, threadTs);
      } else if (emailCmd.action === 'send') {
        if (displayText) await post(channel, displayText, threadTs);
        try {
          await sendEmail(emailCmd.to, emailCmd.subject, emailCmd.body);
          memory.actions.push({ time: new Date().toISOString(), action: 'email_sent', to: emailCmd.to, subject: emailCmd.subject });
          saveMemory(memory);
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
          const title = gCmd.title || 'New Sheet';
          let headers = [];
          const t = title.toLowerCase();
          if (t.includes('lead') || t.includes('sales') || t.includes('pipeline')) headers = ['Company','Contact','Email','Phone','Products','Status','Value (฿)','Next Follow-up','Notes'];
          else if (t.includes('order') || t.includes('invoice')) headers = ['Order #','Date','Customer','Products','Qty','Amount (฿)','Status','Payment','Notes'];
          else if (t.includes('customer') || t.includes('client')) headers = ['Company','Contact','Email','Phone','Category','Monthly Value (฿)','Since','Status','Notes'];
          else if (t.includes('inventory') || t.includes('stock')) headers = ['Product','SKU','Category','Stock','Unit Price (฿)','Location','Reorder Level','Notes'];
          else if (t.includes('campaign') || t.includes('outreach')) headers = ['Contact','Email','Company','Status','Sent Date','Response','Follow-up Date','Notes'];
          const id = await createSheet(title, headers);
          memory.actions.push({ time: new Date().toISOString(), action: 'sheet_created', title, id });
          saveMemory(memory);
          result = `✅ *Sheet created!*\n• *${title}*\n${headers.length ? `• Headers: ${headers.slice(0,4).join(', ')}...\n` : ''}• 📊 https://docs.google.com/spreadsheets/d/${id}`;

        } else if (gCmd.action === 'READ_SHEET') {
          const rows = await readSheet(gCmd.id, gCmd.range);
          if (!rows.length) result = '📊 Sheet is empty.';
          else {
            const headers = rows[0];
            const data = rows.slice(1, 11);
            result = `📊 *Sheet data (${rows.length - 1} rows):*\n` + data.map(row => '• ' + headers.map((h, i) => `*${h}:* ${row[i] || '-'}`).slice(0, 4).join(' | ')).join('\n');
          }

        } else if (gCmd.action === 'APPEND_SHEET') {
          await appendSheet(gCmd.id, gCmd.range || 'Sheet1', [gCmd.row.split(',').map(v => v.trim())]);
          memory.actions.push({ time: new Date().toISOString(), action: 'row_added', id: gCmd.id });
          saveMemory(memory);
          result = `✅ Row added to sheet!`;

        } else if (gCmd.action === 'UPDATE_SHEET') {
          await updateSheet(gCmd.id, gCmd.range, [gCmd.values.split(',').map(v => v.trim())]);
          result = `✅ Sheet updated at ${gCmd.range}`;

        } else if (gCmd.action === 'CLEAR_SHEET') {
          await clearSheet(gCmd.id, gCmd.range || 'Sheet1');
          result = `✅ Sheet cleared: ${gCmd.range}`;

        } else if (gCmd.action === 'DELETE_SHEET') {
          const deleted = await deleteSheet(gCmd.id);
          if (deleted) {
            const name = Object.entries(memory.sheets).find(([n, id]) => id === gCmd.id)?.[0];
            if (name) delete memory.sheets[name];
            saveMemory(memory);
            result = `✅ Sheet deleted!`;
          } else result = `⚠️ Could not delete sheet.`;

        } else if (gCmd.action === 'SHARE_SHEET') {
          await shareSheet(gCmd.id, gCmd.email, gCmd.role || 'writer');
          memory.actions.push({ time: new Date().toISOString(), action: 'sheet_shared', id: gCmd.id, email: gCmd.email });
          saveMemory(memory);
          result = `✅ Sheet shared with *${gCmd.email}* (${gCmd.role || 'writer'} access)\n• 📊 https://docs.google.com/spreadsheets/d/${gCmd.id}`;

        } else if (gCmd.action === 'ADD_SHEET_TAB') {
          const tabName = gCmd.name || gCmd.title || 'New Sheet';
          await addSheetTab(gCmd.id, tabName);
          if (gCmd.headers) await appendSheet(gCmd.id, tabName, [gCmd.headers.split(',').map(function(h) { return h.trim(); })]);
          result = '✅ *Sheet tab added!*\n• *' + tabName + '*\n• 📊 https://docs.google.com/spreadsheets/d/' + gCmd.id;

        } else if (gCmd.action === 'ADD_CHART') {
          const sheetId = await getSheetId(gCmd.id, gCmd.sheet || 'Sheet1');
          await addChart(gCmd.id, sheetId, gCmd.type || 'column', gCmd.title || 'Chart');
          result = '✅ *Chart added!*\n• Type: ' + (gCmd.type || 'column') + '\n• 📊 https://docs.google.com/spreadsheets/d/' + gCmd.id;

        } else if (gCmd.action === 'FORMAT_SHEET') {
          const sheetId = await getSheetId(gCmd.id, gCmd.sheet || 'Sheet1');
          await formatSheet(gCmd.id, sheetId);
          result = '✅ *Sheet formatted!*\n• Blue headers, auto-resize, frozen row\n• 📊 https://docs.google.com/spreadsheets/d/' + gCmd.id;

        } else if (gCmd.action === 'UPLOAD_EXCEL') {
          const title = gCmd.title || 'Report';
          const headers = gCmd.headers ? gCmd.headers.split(',').map(function(h) { return h.trim(); }) : ['Column 1','Column 2','Column 3'];
          const buffer = await createExcelFile(title, headers, []);
          await uploadToSlack(channel, title + '.xlsx', Buffer.from(buffer), title);
          result = '✅ *Excel file uploaded to Slack!*\n• *' + title + '.xlsx*';

        } else if (gCmd.action === 'EXPORT_SHEET') {
          const token = await getOAuthToken();
          const exportUrl = 'https://docs.google.com/spreadsheets/d/' + gCmd.id + '/export?format=xlsx';
          const r = await fetch(exportUrl, { headers: { Authorization: 'Bearer ' + token } });
          if (!r.ok) throw new Error('Cannot export sheet');
          const buffer = Buffer.from(await r.arrayBuffer());
          const title = gCmd.title || 'Sheet';
          await uploadToSlack(channel, title + '.xlsx', buffer, title);
          result = '✅ *Sheet exported to Slack!*\n• *' + title + '.xlsx*';

        } else if (gCmd.action === 'LIST_FILES') {
          const files = await listDriveFiles(gCmd.query);
          result = files.length ? `📁 *Drive files:*\n` + files.map(f => `• *${f.name}* ${f.mimeType?.includes('spreadsheet') ? '📊' : '📄'} \`${f.id}\``).join('\n') : '📁 No files found.';

        } else if (gCmd.action === 'READ_EMAIL') {
          const emails = await readEmails(gCmd.query || '');
          if (!emails.length) result = `📭 No emails found for: "${gCmd.query}"`;
          else result = `📬 *Emails (${emails.length}):*\n` + emails.map(e => `• *${e.subject}*\n  From: ${e.from}\n  ${e.snippet}`).join('\n\n');

        } else if (gCmd.action === 'FETCH_URL') {
          const url = gCmd.url || gCmd.сайт || '';
          if (!url) { result = '⚠️ Please provide a URL.'; }
          else {
            await post(channel, `🌐 Fetching: ${url}...`, threadTs);
            let content = '';
            const direct = await fetchWebPage(url);
            if (direct.success && direct.text) content = direct.text;
            if (!content) result = `⚠️ Could not load: ${url}. Please provide company info manually.`;
            else result = `✅ *Website loaded:* ${url}\n\n*Content:*\n${content.substring(0, 6000)}`;
          }

        } else if (gCmd.action === 'SEARCH_COMPANY') {
          const company = gCmd.company || gCmd.name || '';
          if (!company) { result = '⚠️ Please provide a company name.'; }
          else {
            await post(channel, `🔍 Searching: ${company}...`, threadTs);
            const info = await searchCompanyInfo(company, gCmd.query);
            result = `🔎 *Search results for ${company}:*\n${info}`;
          }

        } else if (gCmd.action === 'SAVE_PROSPECT') {
          // Save a new prospect to Felix pipeline sheet
          const company = gCmd.company || gCmd.name || '';
          const stage = gCmd.stage || 'Prospect';
          const next = gCmd.next || '';
          const today = new Date().toISOString().split('T')[0];
          if (!company) { result = '⚠️ Company name required.'; }
          else if (FELIX_PIPELINE_SHEET_ID) {
            await appendSheet(FELIX_PIPELINE_SHEET_ID, 'Sheet1', [[
              company, gCmd.category || '', gCmd.location || '', gCmd.contact || '',
              stage, gCmd.value || '', today, next, ''
            ]]);
            memory.actions.push({ time: new Date().toISOString(), action: 'prospect_saved', company });
            saveMemory(memory);
            result = `✅ *Prospect saved:* ${company}\n• Stage: ${stage}\n• Next: ${next}\n📊 https://docs.google.com/spreadsheets/d/${FELIX_PIPELINE_SHEET_ID}`;
          } else {
            result = `⚠️ Pipeline sheet not configured. Set FELIX_PIPELINE_SHEET_ID env var.`;
          }

        } else if (gCmd.action === 'LOG_CONTACT') {
          // Log a contact action (call/email/visit/follow-up)
          const company = gCmd.company || gCmd.name || '';
          const type = gCmd.type || 'contact';
          const note = gCmd.note || '';
          const today = new Date().toISOString().split('T')[0];
          if (!company) { result = '⚠️ Company name required.'; }
          else {
            memory.actions.push({ time: new Date().toISOString(), action: type, company, note });
            saveMemory(memory);
            result = `✅ *${type} logged — ${company}*\n_${today}: ${note}_`;
          }

        }

        if (result) await post(channel, result, threadTs);
      } catch (e) {
        await post(channel, `⚠️ Error: ${e.message}`, threadTs);
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
  if (!memory.conversations[convKey]) memory.conversations[convKey] = [];
  const hist = memory.conversations[convKey];
  hist.push({ role: 'user', content: text });
  try {
    const reply = await claude(hist, null, null);
    hist.push({ role: 'assistant', content: reply });
    memory.conversations[convKey] = hist;
    saveMemory(memory);
    await post(channel_id, `*Felix:* ${reply}`);
  } catch (e) { await post(channel_id, `⚠️ Error: ${e.message}`); }
});



// ── Tavily API (professional web search) ─────────────────────────────────
const TAVILY_KEY = process.env.TAVILY_API_KEY || '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';

async function tavilySearch(query, maxResults = 5) {
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        search_depth: 'advanced',
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(15000)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || 'Tavily error');
    const answer  = d.answer || '';
    const sources = (d.results || []).map(s =>
      `• ${s.title} (${s.url})\n  ${(s.content || '').substring(0, 250)}`
    ).join('\n\n');
    return { answer, sources, results: d.results || [] };
  } catch(e) {
    console.error('Tavily error:', e.message);
    return { answer: '', sources: '', results: [] };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FELIX — Web scraping, LPR search, Pipeline tracking, Lead-gen
// ════════════════════════════════════════════════════════════════════════════

// Felix's pipeline sheet
const FELIX_PIPELINE_SHEET_ID = process.env.FELIX_PIPELINE_SHEET_ID || '';
const FELIX_CHANNEL = process.env.FELIX_SLACK_CHANNEL || '';
const SALES_REPORT_CHANNELS_FELIX = [FELIX_CHANNEL, 'C098GG4D802']; // Felix channel + #company-general-reports-results

// ── Web page fetcher (direct) ─────────────────────────────────────────────
async function fetchWebPage(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(12000)
    });
    const html = await r.text();
    // Strip HTML tags and collapse whitespace
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { success: true, text: text.substring(0, 8000) };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ── Search for company/LPR info ───────────────────────────────────────────
async function searchCompanyInfo(companyName, query) {
  const results = [];
  const searches = [
    query || `${companyName} Thailand contact email`,
    `${companyName} ผู้จัดการ ติดต่อ`,
  ];
  for (const q of searches.slice(0, 2)) {
    try {
      const tav = await tavilySearch(q, 3);
      if (tav.answer) results.push(tav.answer.substring(0, 500));
      tav.results.slice(0, 2).forEach(r => {
        if (r.url) results.push('URL: ' + r.url);
        if (r.content) results.push(r.content.substring(0, 300));
      });
    } catch(e) {}
  }
  return results.join('\n') || 'No results found via search.';
}

// ── Analysis checklist for Thai B2B prospects ─────────────────────────────
function buildFelixChecklist(company, category) {
  const cat = (category || '').toLowerCase();
  let channels = 'Lazada, Shopee, 7-Eleven';
  if (cat.includes('hotel') || cat.includes('resort')) channels = 'Direct hotel procurement, HoReCa distributors';
  if (cat.includes('fitness') || cat.includes('gym')) channels = 'Fitness First, Virgin Active, direct B2B';
  if (cat.includes('restaurant')) channels = 'Direct B2B, food service distributors, HoReCa';
  if (cat.includes('distributor') || cat.includes('retail')) channels = 'Direct wholesale, Tops Market, Villa Market';

  return `📋 *Checklist — ${company}*

*1. Company Profile*
☐ Business type (hotel/restaurant/shop/distributor/gym)
☐ Number of locations / branches
☐ Current suppliers for similar products
☐ Monthly volume / purchasing frequency
☐ Decision maker name + contact

*2. Product Fit Assessment*
☐ Do they buy mineral water already? (brand, price, volume)
☐ Do they stock protein bars / healthy snacks?
☐ Interest in raw chickpeas (wholesale)?
☐ Price sensitivity vs quality preference

*3. Thai Market Context*
☐ Location (Bangkok / Phuket / Pattaya / other)
☐ Customer profile (Thai locals / expats / tourists)
☐ Relevant channels: ${channels}
☐ Competitor products currently on shelves

*4. SBL Product Match*
☐ SBL Water (glass ฿54-65 / PET ฿44-55) — fit?
☐ FitnesShock Brownies ฿75/pc — fit?
☐ SHOCKS! Bars ฿65/pc — fit?
☐ Chickpeas wholesale — volume + price needed?

*5. Contact Strategy*
☐ Find buyer / purchasing manager name
☐ Preferred contact: LINE / WhatsApp / email / call
☐ Best time to call / visit
☐ Sample drop-off possible?

*6. Action*
☐ Recommendation: PITCH NOW / QUALIFY MORE / PASS
☐ Estimated monthly order value (THB)
☐ Next step with date`;
}

// ── Weekly sales report for Felix ─────────────────────────────────────────
async function sendFelixWeeklyReport() {
  console.log('📊 Generating Felix weekly sales report...');
  try {
    if (!FELIX_PIPELINE_SHEET_ID) {
      console.log('No Felix pipeline sheet configured, skipping report');
      return;
    }
    const rows = await readSheet(FELIX_PIPELINE_SHEET_ID, 'Sheet1');
    if (!rows?.length) return;

    const data = rows.slice(1).filter(r => r[0]); // skip header

    // Count by stage
    const stages = {};
    data.forEach(r => {
      const stage = r[4] || 'Prospect';
      stages[stage] = (stages[stage] || 0) + 1;
    });

    const total = data.length;
    const stageBlock = Object.entries(stages)
      .map(([s, n]) => `• *${s}:* ${n}`)
      .join('\n');

    // Overdue: next step set but no recent update
    const overdue = data.filter(r => r[7] && !['Closed', 'Pass'].includes(r[4]));

    let report = `📊 *Felix Weekly Sales Report*\n`;
    report += `_${new Date().toLocaleDateString('en-TH', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}_\n\n`;
    report += `*Total Active Accounts:* ${total}\n\n`;
    report += `*Pipeline by Stage:*\n${stageBlock}\n`;

    if (overdue.length > 0) {
      report += `\n*⏰ Needs Follow-up (${Math.min(overdue.length, 5)}):*\n`;
      overdue.slice(0, 5).forEach(r => {
        report += `• *${r[0]}* [${r[4] || 'Prospect'}]${r[7] ? ` — ${r[7]}` : ''}\n`;
      });
    }

    if (FELIX_PIPELINE_SHEET_ID) {
      report += `\n📊 https://docs.google.com/spreadsheets/d/${FELIX_PIPELINE_SHEET_ID}`;
    }

    for (const chId of SALES_REPORT_CHANNELS_FELIX.filter(Boolean)) {
      try { 
        const r = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
          body: JSON.stringify({ channel: chId, text: report })
        });
      } catch(e) { console.error('Felix report failed for', chId, e.message); }
    }
    console.log('✅ Felix weekly report sent.');
  } catch(e) {
    console.error('❌ Felix weekly report error:', e.message);
  }
}

// ── Friday 19:00 Bangkok scheduler ────────────────────────────────────────
function startFelixScheduler() {
  setInterval(() => {
    const bkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
    if (bkk.getUTCDay() === 5 && bkk.getUTCHours() === 19 && bkk.getUTCMinutes() === 0) {
      sendFelixWeeklyReport();
    }
  }, 60000);
  console.log('✅ Felix weekly report scheduler started (Fridays 19:00 Bangkok)');
}

startFelixScheduler();

app.listen(PORT, () => console.log(`🤖 Felix running on port ${PORT} — Full Gmail + Sheets + Memory`));
