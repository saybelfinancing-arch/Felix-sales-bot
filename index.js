'use strict';

// ── Twilio (global) ──────────────────────────────────────────────────────────
const TWILIO_SID   = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_TOKEN = (process.env.TWILIO_AUTH_TOKEN  || '').trim();
const TWILIO_FROM  = (process.env.TWILIO_FROM_NUMBER || '+13365158698').split('=')[0].trim();

const express = require('express');
const fs = require('fs');
const path = require('path');

// ── Obsidian Memory ───────────────────────────────────────────────────────────
async function saveToObsidian(agentName, fileName, entry) {
  const token = process.env.GITHUB_TOKEN || '';
  const repo  = process.env.MEMORY_REPO  || 'saybelfinancing-arch/sbl-agent-memory';
  if (!token) return;
  try {
    const path = `${agentName}/${fileName}.md`;
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
    let sha = null, existing = '';
    try { const r = await fetch(apiUrl,{headers}); const d = await r.json(); if(d.sha){sha=d.sha;existing=Buffer.from(d.content,'base64').toString('utf-8');} } catch(e){}
    const ts = new Date().toISOString().replace('T',' ').substring(0,16);
    const updated = existing + `\n---\n**${ts}**\n${entry}\n`;
    const body = { message: `${agentName}: memory`, content: Buffer.from(updated).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    console.log(`Memory saved: ${path}`);
  } catch(e) { console.error('Memory error:', e.message); }
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const SLACK_TOKEN = (process.env.SLACK_BOT_TOKEN || '').trim();
const HERMES_USER_ID  = 'U0BAF5QQF5Y'; // SBL Personal Assistant — Hermes
const FELIX_CHANNEL   = 'C0B53EXNKL1'; // #sales-russian-products-in-thailand
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
  const cmds = ['CREATE_SHEET','ADD_SHEET_TAB','READ_SHEET','APPEND_SHEET','UPDATE_SHEET','CLEAR_SHEET','DELETE_SHEET','SHARE_SHEET','LIST_FILES','READ_EMAIL','ADD_CHART','FORMAT_SHEET','UPLOAD_EXCEL','EXPORT_SHEET','FETCH_URL','SEARCH_COMPANY','SAVE_PROSPECT','LOG_CONTACT','CALL_PHONE','MAKE_CALL','GET_CALL_STATS','SAVE_PARTNER'];
  for (const cmd of cmds) {
    const m = text.match(new RegExp(`\\[${cmd}\\]([\\s\\S]*?)\\[\\/${cmd}\\]`));
    if (m) {
      const block = m[1];
      const result = { action: cmd, raw: m[0] };
      ['ID','RANGE','TITLE','QUERY','ROW','EMAIL','ROLE','VALUES','TO','PHONE','NAME','COMPANY','CONTACT','NOTE','NUMBER'].forEach(f => {
        const val = block.match(new RegExp(`${f}:\\s*(.+)`))?.[1]?.trim();
        if (val) result[f.toLowerCase()] = val;
      });
      return result;
    }
  }
  return null;
}

// ── Felix System Prompt ───────────────────────────────────────
const FELIX_SYSTEM = `
LANGUAGE WITH HERMES:
- When message is from Hermes (SBL Personal Assistant) — respond ONLY in English
- Start response with mention: @SBL personal assistant  
- Be concise and direct in replies to Hermes

You are Felix, autonomous B2B Sales AI Agent for SBL IT Platforms Co., Ltd.
You ARE the one making calls via Twilio — you are NOT a human, you are an AI bot with Twilio integration.
You specialize in the THAI MARKET — Thai companies, distributors, gyms, pharmacies, supermarkets.

CRITICAL BEHAVIOR RULES:
- When asked to make calls or do a call campaign — DO IT IMMEDIATELY using [CALL_PHONE] commands
- NEVER say you cannot make calls — you CAN and MUST make them
- NEVER ask for confirmation before calling — just call
- NEVER explain plans — execute and report results
- After each call: report status (initiated/failed) with SID
- You communicate in Thai with Thai companies, English with others

CALL COMMAND FORMAT (use exactly):
[CALL_PHONE][PHONE]+66xxxxxxxxx[/PHONE][/CALL_PHONE]

For call campaigns, call each company one by one using [CALL_PHONE] for each number.
If you see a list of companies with phones — call ALL of them in sequence.

KEY THAI PHRASES FOR CALLS:
- สวัสดีครับ/ค่ะ ผม/ดิฉัน ชื่อ เฟลิกซ์ จาก SBL IT Platforms (Hello, my name is Felix from SBL)
- เราจำหน่ายสินค้าพรีเมียมจากรัสเซีย (We distribute premium products from Russia)
- น้ำแร่ SBL และ FitnesShock โปรตีนบาร์ (SBL Mineral Water and FitnesShock Protein Bars)
- ขอนัดประชุมได้ไหมครับ/ค่ะ? (Can we schedule a meeting?)

PRODUCTS: SBL Mineral Water 🇷🇺 (from Russia), FitnesShock Protein Bars 💪
You have FULL access to Gmail, Google Drive and Google Sheets — you can CREATE, READ, EDIT, DELETE and SHARE sheets.
You also have persistent memory of all previous conversations and actions.

PHONE CALL COMMANDS — use EXACTLY this format:
[CALL_PHONE][PHONE]+66xxxxxxxxx[/PHONE][/CALL_PHONE]
or: [CALL_PHONE][TO]+66xxxxxxxxx[/TO][/CALL_PHONE]
DO NOT use [MAKE_CALL] — it will not work.
After initiating a call, report the result to the user.

CRITICAL RULES FOR LEAD GENERATION TASKS:
- When asked to find/search for leads or companies — write your analysis and findings as PLAIN TEXT, NOT as [SEARCH_COMPANY] commands
- [SEARCH_COMPANY] is ONLY for looking up a SPECIFIC named company (e.g. [SEARCH_COMPANY][NAME]Tesco Lotus[/NAME][/SEARCH_COMPANY])
- [SAVE_PROSPECT] requires a specific company name — NEVER use it without [NAME]...[/NAME]
- For lead generation tasks: research and present your findings as a formatted text list, then use [SAVE_PROSPECT] for each individual company found
- When Hermes gives you a weekly task — acknowledge, execute the research, and report results directly

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

CREATING DOCUMENTS — when tabular data or report is needed:
[EXCEL_TABLE]
{
  "title": "Report Title",
  "subtitle": "SBL IT Platforms | Date",
  "filename": "report_name.xlsx",
  "sheetName": "Data",
  "headers": [
    {"label": "Column 1", "width": 25},
    {"label": "Column 2", "width": 15}
  ],
  "rows": [
    ["Value 1", "Value 2"],
    ["Value 3", "Value 4"]
  ],
  "summaryRows": [["TOTAL", "100"]]
}
[/EXCEL_TABLE]

Use [EXCEL_TABLE] for: tables, reports, price lists, pipeline data, analytics.
The file is auto-created and uploaded to Slack as attachment.

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

// ── Twilio call function ──────────────────────────────────────────────────────
async function twilioCall(phone, product) {
  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  // Use Felix's own TwiML endpoint for Thai voice script
  const twimlUrl = 'https://web-production-6afcd.up.railway.app/twiml/' + (product || 'chickpea');
  const body = new URLSearchParams({
    To:   phone,
    From: TWILIO_FROM,
    Url:  twimlUrl
  });
  const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_SID + '/Calls.json', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  return await r.json();
}

// ── Read contacts from Google Sheet ──────────────────────────────────────────
async function readContactsFromSheet(sheetConfig, limit) {
  try {
    const tok  = await getOAuthToken();
    const url  = `https://sheets.googleapis.com/v4/spreadsheets/${sheetConfig.id}/values/${encodeURIComponent(sheetConfig.tab)}!A:M`;
    const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
    const data = await resp.json();
    const rows = (data.values || []).slice(1);
    return rows.slice(0, limit || 50).map((row, i) => ({
      num:      row[0] || (i + 1),
      company:  row[1] || '',
      type:     row[2] || '',
      city:     row[3] || '',
      website:  row[4] || '',
      email:    row[5] || '',
      phone:    (row[6] || '').replace(/\s+/g, ''),
      whatsapp: (row[7] || '').replace(/\s+/g, ''),
      lpr_name: row[8] || '',
      lpr_pos:  row[9] || '',
      priority: row[11] || '',
      product:  sheetConfig.product || '',
    })).filter(r => r.company);
  } catch(e) {
    console.error('readContactsFromSheet error:', e.message);
    return [];
  }
}

// ── Find phone online via Tavily ──────────────────────────────────────────────
async function findPhoneOnline(company, website) {
  try {
    const query = website
      ? `site:${website} phone contact number Thailand`
      : `"${company}" Thailand phone contact number`;
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: TAVILY_KEY, query, max_results: 3 })
    });
    const data = await resp.json();
    const text = (data.results || []).map(r => r.content).join(' ');
    const phones = text.match(/(?:\+66|0)\s?[\d\s\-]{8,12}/g) || [];
    const clean = phones.map(p => p.replace(/\s+/g, '').replace(/^0/, '+66')).filter(p => p.length >= 10);
    return clean[0] || null;
  } catch(e) { return null; }
}

// ── Auto call campaign ────────────────────────────────────────────────────────
async function runCallCampaign(contacts, channel, threadTs, postFn) {
  const results = [];
  for (const c of contacts) {
    let phone = c.phone || c.whatsapp;
    if (phone) phone = phone.replace(/[\s\-\(\)]/g, '');
    if (phone && !phone.startsWith('+')) phone = '+' + phone.replace(/^0/, '66');
    if (!phone || phone.length < 10) {
      await postFn(channel, `🔍 *${c.company}* — no phone, searching online...`, threadTs);
      phone = await findPhoneOnline(c.company, c.website);
    }
    if (!phone) {
      results.push({ company: c.company, status: 'no_phone' });
      await postFn(channel, `⚠️ *${c.company}* — phone not found, skipping`, threadTs);
      continue;
    }
    await postFn(channel, `📞 Calling *${c.company}* at ${phone}...`, threadTs);
    try {
      const cr = await twilioCall(phone);
      if (cr.sid) {
        results.push({ company: c.company, phone, status: 'initiated', sid: cr.sid });
        await postFn(channel, `✅ *${c.company}* — SID: ${cr.sid}`, threadTs);
        saveToObsidian('Felix', 'conversations', `**Call** | ${c.company} | ${phone} | ${cr.sid}`).catch(()=>{});
      } else {
        results.push({ company: c.company, phone, status: 'failed', error: cr.message });
        await postFn(channel, `❌ *${c.company}* — ${cr.message || JSON.stringify(cr).substring(0,80)}`, threadTs);
      }
    } catch(e) {
      results.push({ company: c.company, phone, status: 'error', error: e.message });
      await postFn(channel, `❌ *${c.company}* — error: ${e.message}`, threadTs);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return results;
}


app.post('/slack/events', async (req, res) => {
  const body = req.body;
  if (body?.type === 'url_verification') return res.status(200).json({ challenge: body.challenge });
  res.status(200).end('OK');

  const event = body?.event;
  if (!event || event.type !== 'message') return;
  if (event.subtype && event.subtype !== 'file_share') return;

  // Robust Hermes detection: check user ID, username, and bot name
  const isHermesEvent = (
    event.user === 'U0BAF5QQF5Y' ||
    (event.bot_profile?.app_id && event.username === 'sbl_personal_assistant') ||
    (event.bot_profile?.name || '').toLowerCase().includes('hermes') ||
    (event.username || '').toLowerCase().includes('sbl_personal') ||
    (event.username || '').toLowerCase().includes('hermes')
  );
  console.log('Felix event from:', event.user, '| bot_id:', event.bot_id, '| username:', event.username, '| isHermes:', isHermesEvent);
  // If bot message targets Felix explicitly — allow it through even if not Hermes
  const textForCheck = (event.text || '').toLowerCase();
  const isTargetingFelix = textForCheck.includes('@felix') || 
                           (event.text || '').includes('<@U0AM5RPU9S9>') ||
                           (event.text || '').includes(`<@${BOT_ID}>`);
  
  if (event.bot_id && !isHermesEvent && !isTargetingFelix) return;
  
  // Re-check isHermesEvent including if it targets Felix
  const isEffectivelyHermes = isHermesEvent || (event.bot_id && isTargetingFelix);

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

    const rawMsg = (event.text || '').toLowerCase();
  const isDM = event.channel_type === 'im';
  const isMentioned = BOT_ID ? (event.text || '').includes(`<@${BOT_ID}>`) : false;
  const isNameMentioned = rawMsg.includes('@felix') || (event.text||'').includes('<@U0AM5RPU9S9>');
  const isFromHermes = isEffectivelyHermes || isHermesEvent;
  console.log('Felix trigger: isDM='+isDM+' isMentioned='+isMentioned+' isName='+isNameMentioned+' isHermes='+isFromHermes+' text='+(event.text||'').substring(0,80));
  // Respond only if: DM, bot tag @mention, name/ID explicitly mentioned, OR Hermes command
  if (!isDM && !isMentioned && !isNameMentioned && !isFromHermes) return;
  const hermesMode = isFromHermes;
  const felixHermesMode = hermesMode;
  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const hasFiles = event.files?.length > 0;
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


  // Add Hermes language context to prompt
  if (isFromHermes) {
    prompt += '\n\n[IMPORTANT: This command is from Hermes (SBL Personal Assistant). Respond ONLY in English. Start with "<@U0BAF5QQF5Y>". Be concise and direct.]';
  }
  hist.push({ role: 'user', content: prompt });
  if (hist.length > 40) hist.splice(0, hist.length - 40);

    // ── Direct call command (bypasses Claude) ──────────────────────
    const _callMatch = userText.match(/(?:^|\n)\s*(?:call:|call|звони:|звони|позвони)\s+(<tel:[^>]+>|\+[\d][\d\s\-]{7,})/i);
    if (_callMatch) {
      const _raw = _callMatch[1];
      const _telM = _raw.match(/<tel:([^|>]+)/);
      const _rawPhone = _telM ? _telM[1] : _raw.replace(/[^+0-9]/g, '');
      const _phone = _rawPhone.startsWith('+') ? _rawPhone : '+' + _rawPhone;
      console.log('Felix direct call to:', _phone);
      try {
        const _cr = await twilioCall(_phone);
        if (_cr.sid) {
          await post(channel, '\u2705 *Call initiated!*\n\u2022 Phone: ' + _phone + '\n\u2022 SID: ' + _cr.sid + '\n\u2022 Status: ' + _cr.status + '\n\n\uD83C\uDDF9\uD83C\uDDED Felix will speak Thai with them.', threadTs);
          memory.actions.push({ time: new Date().toISOString(), action: 'call', phone: _phone, sid: _cr.sid });
          saveMemory(memory);
          saveToObsidian('Felix', 'conversations', '**Call** | ' + _phone + ' | SID: ' + _cr.sid).catch(()=>{});
        } else {
          await post(channel, '\u26a0\ufe0f *Call failed*\n\u2022 Phone: ' + _phone + '\n\u2022 Error: ' + (_cr.message || JSON.stringify(_cr).substring(0,100)), threadTs);
        }
      } catch(_e) { await post(channel, '\u26a0\ufe0f Call error: ' + _e.message, threadTs); }
      return;
    }

    // ── Auto-detect phones in message → run campaign ──────────────────────
    // Match any international phone: +66xxx, +7xxx, <tel:+xxx|+xxx>
    const _rawPhones = [
      ...(userText.match(/<tel:(\+[\d]+)[^>]*>/g)||[]).map(m => m.match(/<tel:(\+[\d]+)/)?.[1]),
      ...(userText.match(/\+\d{1,3}[\d\s\-]{7,14}/g)||[]),
    ].filter(Boolean);
    const _autoPhones = [...new Set(_rawPhones.map(p=>p.replace(/[\s\-]/g,'')))].filter(p=>p.length>=10);
    const _hasCallWord = /(?:call|звони|обзвони|позвони|обзвон)/i.test(userText);
    const _startsWithCall = /^(?:call:|звони:|call:)/i.test(userText.trim());
    if (_autoPhones.length >= 1 && (_hasCallWord || _startsWithCall)) {
      await post(channel, `📞 *Felix: Auto-calling ${_autoPhones.length} numbers...*`, threadTs);
      for (const _ph of _autoPhones) {
        await post(channel, `📞 Calling ${_ph}...`, threadTs);
        try {
          const _cr = await twilioCall(_ph);
          if (_cr.sid) {
            await post(channel, `✅ ${_ph} — SID: ${_cr.sid} | Status: ${_cr.status}`, threadTs);
            saveToObsidian('Felix','conversations',`**Call** | ${_ph} | ${_cr.sid}`).catch(()=>{});
          } else {
            await post(channel, `❌ ${_ph} — ${_cr.message||JSON.stringify(_cr).substring(0,60)}`, threadTs);
          }
        } catch(_e) { await post(channel, `❌ ${_ph} — error: ${_e.message}`, threadTs); }
        await new Promise(_r=>setTimeout(_r,2000));
      }
      await post(channel, `✅ *Done: ${_autoPhones.length} calls initiated*`, threadTs);
      return;
    }


    // ── READ CONTACTS command ──────────────────────────────────────────────
    const readContactsMatch = /(?:read|load|get|show|список|контакт|прочитай)\s+(?:contacts?|лид|таблиц)/i.test(userText);
    if (readContactsMatch) {
      await post(channel, '📋 *Felix: Reading contacts from Google Sheet...*', threadTs);
      const contacts = await readContactsFromSheet(CONTACTS_SHEETS[0], 30);
      if (!contacts.length) { await post(channel, '⚠️ No contacts found in sheet', threadTs); return; }
      const withPhone = contacts.filter(c => c.phone || c.whatsapp);
      const noPhone   = contacts.filter(c => !c.phone && !c.whatsapp);
      const summary = contacts.slice(0, 10).map(c =>
        `• #${c.num} *${c.company}* (${c.city}) — ${c.phone || c.whatsapp || '❌ no phone'} | ${c.lpr_name || '-'}`
      ).join('\n');
      await post(channel,
        `📋 *Contacts loaded: ${contacts.length} companies*\n` +
        `• With phone: ${withPhone.length}\n• No phone (will search online): ${noPhone.length}\n\n` +
        summary + (contacts.length > 10 ? `\n_...and ${contacts.length - 10} more_` : ''),
        threadTs
      );
      return;
    }

    // ── CALL CAMPAIGN command ─────────────────────────────────────────────────
    // Only trigger sheet campaign if NO actual phone numbers in message
    const _hasPhones = (_autoPhones && _autoPhones.length > 0);
    const campaignMatch = !_hasPhones && userText.match(/(?:call campaign|обзвон|start calls?|начни звон|позвони всем|call all|call list)/i);
    const limitMatch    = userText.match(/(\d+)\s*(?:компани|compan|contact|lead)/i);
    if (campaignMatch) {
      const limit = limitMatch ? parseInt(limitMatch[1]) : 5;
      await post(channel, `📞 *Felix: Starting call campaign (${limit} contacts)...*`, threadTs);
      const allContacts = await readContactsFromSheet(CONTACTS_SHEETS[0], 50);
      // Filter HOT/WARM priority first, skip those already with — in phone
      const prioritized = [
        ...allContacts.filter(c => c.priority === 'HOT'),
        ...allContacts.filter(c => c.priority === 'WARM' && !allContacts.find(x => x === c && x.priority === 'HOT')),
        ...allContacts.filter(c => !['HOT','WARM'].includes(c.priority)),
      ].slice(0, limit);
      const results = await runCallCampaign(prioritized, channel, threadTs, post);
      const succeeded = results.filter(r => r.status === 'initiated').length;
      const failed    = results.filter(r => ['failed','error','no_phone'].includes(r.status)).length;
      await post(channel,
        `✅ *Campaign complete*\n• Called: ${succeeded}/${results.length}\n• Failed/No phone: ${failed}\n\n` +
        `_Results saved to Obsidian memory_`,
        threadTs
      );
      return;
    }

    // ── FIND PHONE command ────────────────────────────────────────────────────
    const findPhoneMatch = userText.match(/(?:find phone|найди номер|поиск номер)\s+(.+)/i);
    if (findPhoneMatch) {
      const company = findPhoneMatch[1].trim();
      await post(channel, `🔍 *Felix: Searching phone for ${company}...*`, threadTs);
      const phone = await findPhoneOnline(company, null);
      await post(channel, phone
        ? `✅ Found: *${phone}* for ${company}`
        : `⚠️ Could not find phone for ${company} online`,
        threadTs
      );
      return;
    }

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

    // ── Auto Excel generation from [EXCEL_TABLE] blocks ─────────────────
    const excelMatch = (reply || '').match(/\[EXCEL_TABLE\]([\s\S]+?)\[\/EXCEL_TABLE\]/i);
    if (excelMatch) {
      try {
        const tableData = JSON.parse(excelMatch[1].trim());
        const xlsxPath  = await createProfessionalExcel(tableData);
        const xlsxBuf   = fs_bot.readFileSync(xlsxPath);
        await uploadToSlack(channel, tableData.filename || 'report.xlsx', xlsxBuf,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          tableData.title || 'Report');
        fs_bot.unlinkSync(xlsxPath);
      } catch(e) { console.error('Felix Excel gen error:', e.message); }
    }

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
    // Save significant interactions to Obsidian
    if (userText && userText.length > 20 && text && text.length > 20) {
      const topic = userText.substring(0, 60).replace(/\n/g, ' ');
      saveToObsidian('Felix', 'conversations', `**Topic:** ${topic}\n**Response summary:** ${text.substring(0,200)}`).catch(()=>{});
    }
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


        } else if (gCmd.action === 'CALL_PHONE' || gCmd.action === 'MAKE_CALL') {
          // Parse phone from TO: field (MAKE_CALL format) or PHONE: field
          if (!gCmd.phone && gCmd.to) gCmd.phone = gCmd.to;
          const phone = gCmd.phone || gCmd.number || '';
          if (!phone) { result = '⚠️ Please provide a phone number.'; }
          else {
            const callResult = await twilioCall(phone);
            if (callResult.sid) {
              memory.actions.push({ time: new Date().toISOString(), action: 'call', phone, sid: callResult.sid });
              saveMemory(memory);
              result = `✅ *Call initiated!*\n• Phone: ${phone}\n• SID: ${callResult.sid}\n• Status: ${callResult.status}`;
            } else {
              result = `⚠️ Call failed: ${callResult.message || JSON.stringify(callResult)}`;
            }
          }

        } else if (gCmd.action === 'GET_CALL_STATS') {
          if (!TWILIO_SID) { result = '⚠️ Twilio not configured. Add TWILIO_ACCOUNT_SID to Railway.'; }
          else {
            const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
            const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json?PageSize=20`, { headers: { Authorization: 'Basic ' + auth } });
            const d = await r.json();
            const calls = (d.calls || []).slice(0, 10);
            result = `📊 *Recent Calls (${calls.length}):*\n${calls.map(c => `• ${c.to} | ${c.status} | ${(c.start_time||'').substring(0,10)}`).join('\n') || 'No calls found'}`;
          }

        } else if (gCmd.action === 'SAVE_PARTNER') {
          const name    = gCmd.name || gCmd.company || '';
          const contact = gCmd.contact || gCmd.lpr || '';
          const phone   = gCmd.phone || '';
          const email   = gCmd.email || '';
          const notes   = gCmd.note || gCmd.notes || '';
          if (!name) { result = '⚠️ Please provide company name.'; }
          else {
            memory.actions.push({ time: new Date().toISOString(), action: 'partner_saved', name, contact, phone });
            saveMemory(memory);
            saveToObsidian('Felix', 'partners', `**${name}** | ${contact} | ${phone} | ${email} | ${notes} | ${new Date().toISOString().split('T')[0]}`).catch(()=>{});
            result = `✅ *Partner saved:* ${name}\n• Contact: ${contact}\n• Phone: ${phone}\n• Email: ${email}`;
          }

        }

        if (result) await post(channel, result, threadTs);
      } catch (e) {
        await post(channel, `⚠️ Error: ${e.message}`, threadTs);
      }
      gCmd = parseGoogleCommand(text);
    }
    if (text) {
      const finalText_fel = felixHermesMode ? `<@${HERMES_USER_ID}> ${text}` : text;
      await post(channel, finalText_fel, threadTs);
    }

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
const TAVILY_KEY    = process.env.TAVILY_API_KEY || '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';

// ── Thai Contacts Sheets ──────────────────────────────────────────────────────
const CONTACTS_SHEETS = [
  { id: '1QW2rJoYMWR68t1K9ZAEEOQseIr5DUCm6RwfpfyRGzPY', tab: 'Chickpea Buyers', product: 'Chickpeas' },
];
// Column mapping (0-based): B=1(Company), E=4(Website), F=5(Email), G=6(Phone), H=7(WhatsApp), I=8(LPR Name), J=9(LPR Position), L=11(Priority)
const COL_COMPANY  = 1;
const COL_TYPE     = 2;
const COL_CITY     = 3;
const COL_WEBSITE  = 4;
const COL_EMAIL    = 5;
const COL_PHONE    = 6;
const COL_WA       = 7;
const COL_LPR_NAME = 8;
const COL_LPR_POS  = 9;
const COL_PRIORITY = 11;
  // Twilio credentials from global scope

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
// FELIX_CHANNEL defined above
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


// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT GENERATION — Professional Excel/PDF/Word
// ════════════════════════════════════════════════════════════════════════════
const ExcelJS_bot = require('exceljs');
const path_bot    = require('path');
const os_bot      = require('os');
const fs_bot      = require('fs');

const BRAND_COLORS = {
  navy:  'FF1A3A6B', gold: 'FFC8960C', teal: 'FF1E6B45',
  white: 'FFFFFFFF', lgrey: 'FFF4F7FC', mgrey: 'FFDDE3EE',
};

async function createProfessionalExcel(opts) {
  const wb = new ExcelJS_bot.Workbook();
  wb.creator = 'SBL IT Platforms Agent';
  wb.created = new Date();
  const ws = wb.addWorksheet(opts.sheetName || 'Report', { views: [{ showGridLines: false }] });

  // Title
  ws.mergeCells(1, 1, 1, opts.headers.length);
  const tc = ws.getCell('A1');
  tc.value = opts.title || 'SBL Report';
  tc.font  = { bold: true, size: 16, color: { argb: BRAND_COLORS.white }, name: 'Arial' };
  tc.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_COLORS.navy } };
  tc.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(1).height = 36;

  let headerRow = 2;
  if (opts.subtitle) {
    ws.mergeCells(2, 1, 2, opts.headers.length);
    const sc = ws.getCell('A2');
    sc.value = opts.subtitle;
    sc.font  = { italic: true, size: 10, color: { argb: 'FF666666' }, name: 'Arial' };
    sc.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_COLORS.lgrey } };
    sc.alignment = { horizontal: 'left', vertical: 'middle' };
    ws.getRow(2).height = 20;
    headerRow = 3;
  }

  // Headers
  opts.headers.forEach((h, i) => {
    const c = ws.getCell(headerRow, i + 1);
    c.value = typeof h === 'string' ? h : h.label;
    c.font  = { bold: true, size: 10, color: { argb: BRAND_COLORS.white }, name: 'Arial' };
    c.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_COLORS.teal } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'medium', color: { argb: BRAND_COLORS.gold } } };
  });
  ws.getRow(headerRow).height = 28;

  // Data rows
  (opts.rows || []).forEach((row, ri) => {
    const rn = headerRow + 1 + ri;
    const bg = ri % 2 === 0 ? BRAND_COLORS.white : BRAND_COLORS.lgrey;
    row.forEach((val, ci) => {
      const c = ws.getCell(rn, ci + 1);
      c.value = val;
      c.font  = { size: 9, name: 'Arial' };
      c.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      c.alignment = { vertical: 'top', wrapText: true };
      c.border = {
        bottom: { style: 'thin', color: { argb: BRAND_COLORS.mgrey } },
        right:  { style: 'thin', color: { argb: BRAND_COLORS.mgrey } }
      };
    });
    ws.getRow(rn).height = 36;
  });

  // Summary rows
  if (opts.summaryRows?.length) {
    const ss = headerRow + 1 + (opts.rows?.length || 0) + 1;
    opts.summaryRows.forEach((srow, sri) => {
      const rn = ss + sri;
      srow.forEach((val, ci) => {
        const c = ws.getCell(rn, ci + 1);
        c.value = val;
        c.font  = { bold: true, size: 9, name: 'Arial', color: { argb: BRAND_COLORS.navy } };
        c.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_COLORS.mgrey } };
        c.alignment = { vertical: 'middle' };
      });
      ws.getRow(rn).height = 24;
    });
  }

  // Column widths
  opts.headers.forEach((h, i) => {
    ws.getColumn(i + 1).width = (typeof h === 'object' && h.width) ? h.width : 20;
  });

  // Footer
  const lr = ws.lastRow.number + 2;
  ws.mergeCells(lr, 1, lr, opts.headers.length);
  const fc = ws.getCell(lr, 1);
  fc.value = `SBL IT Platforms Co., Ltd. | Generated: ${new Date().toLocaleString('en-TH', { timeZone: 'Asia/Bangkok' })} (Bangkok)`;
  fc.font  = { italic: true, size: 8, color: { argb: 'FF999999' }, name: 'Arial' };
  fc.alignment = { horizontal: 'right' };

  const tmpPath = path_bot.join(os_bot.tmpdir(), opts.filename || 'report.xlsx');
  await wb.xlsx.writeFile(tmpPath);
  return tmpPath;
}


// ── Hermes reply helper ───────────────────────────────────────────────────
function hermesReply(text, isHermes) {
  if (!isHermes) return text;
  return `<@U0BAF5QQF5Y> ${text}`;
}


// ── Thai Voice Scripts ────────────────────────────────────────────────────────
const SCRIPTS = {
  chickpea: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say language="th-TH">สวัสดีครับ ผมชื่อ เฟลิกซ์ จาก บริษัท เอสบีแอล ไอที แพลตฟอร์มส์ ครับ</Say>
  <Pause length="1"/>
  <Say language="th-TH">เราเป็นผู้นำเข้าและจัดจำหน่าย ถั่วลูกไก่ คุณภาพพรีเมียม จากรัสเซีย ขนาด 8 มิลลิเมตรขึ้นไปครับ</Say>
  <Pause length="1"/>
  <Say language="th-TH">ผมอยากนัดประชุมออนไลน์ สั้นๆ กับท่าน เพื่อนำเสนอราคาและตัวอย่างสินค้าครับ</Say>
  <Pause length="1"/>
  <Say language="th-TH">กรุณาโทรกลับที่เบอร์ 0815162435 หรือ ส่งอีเมลมาที่ info@sblplat.co.th ครับ ขอบคุณมากครับ</Say>
</Response>`,
  water: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say language="th-TH">สวัสดีครับ ผมชื่อ เฟลิกซ์ จาก บริษัท เอสบีแอล ไอที แพลตฟอร์มส์ ครับ</Say>
  <Pause length="1"/>
  <Say language="th-TH">เราเป็นผู้นำเข้าและจัดจำหน่าย น้ำแร่ เอสบีแอล คุณภาพพรีเมียม จากรัสเซียครับ</Say>
  <Pause length="1"/>
  <Say language="th-TH">กรุณาโทรกลับที่เบอร์ 0815162435 ครับ ขอบคุณมากครับ</Say>
</Response>`,
};

// ── TwiML Routes ──────────────────────────────────────────────────────────────
app.get('/twiml/:product', (req, res) => {
  res.type('text/xml');
  res.send(SCRIPTS[req.params.product] || SCRIPTS.chickpea);
});
app.post('/twiml/:product', (req, res) => {
  res.type('text/xml');
  res.send(SCRIPTS[req.params.product] || SCRIPTS.chickpea);
});

// ── Twilio Status Callback ────────────────────────────────────────────────────
app.post('/twilio/callback', async (req, res) => {
  res.status(200).send('OK');
  try {
    const sid      = req.body.CallSid;
    const status   = req.body.CallStatus;
    const duration = req.body.CallDuration;
    const to       = req.body.To;
    const recUrl   = req.body.RecordingUrl;
    const emoji    = { completed:'✅', busy:'📵', 'no-answer':'📵', failed:'❌', canceled:'⚠️' }[status] || '❓';
    const dur      = duration ? `${Math.floor(duration/60)}m ${duration%60}s` : '—';
    let msg = `${emoji} *Call Report: ${to}*\n• Status: ${status}\n• Duration: ${dur}`;
    if (recUrl) msg += `\n• 🎙️ Recording: ${recUrl}.mp3`;
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C0B53EXNKL1', text: msg })
    });
    saveToObsidian('Felix', 'call_reports', `${to} | ${status} | ${dur}`).catch(()=>{});
  } catch(e) { console.error('Callback error:', e.message); }
});

app.listen(PORT, () => console.log(`🤖 Felix running on port ${PORT} — Full Gmail + Sheets + Memory`));