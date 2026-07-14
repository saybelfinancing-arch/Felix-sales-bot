import fetch from 'node-fetch';
import express from 'express';
import bodyParser from 'body-parser';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ── Constants ─────────────────────────────────────────────────────────────────
const SLACK_TOKEN    = process.env.SLACK_BOT_TOKEN || '';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || '';
const HERMES_USER_ID = 'U0BAF5QQF5Y'; // SBL Personal Assistant

// Channels
const CH_RU      = 'C0BEMA19FNZ'; // private — Russian only
const CH_TH_EN_1 = 'C0BEM9V6DJR'; // private — EN or TH based on input
const CH_TH_EN_2 = 'C07K4P9KMQW'; // public  — EN or TH based on input

const TOTO_CHANNELS = [CH_RU, CH_TH_EN_1, CH_TH_EN_2];

// ── Memory ────────────────────────────────────────────────────────────────────
let memory = { conversations: {} };
const processed = new Set();

// ── Slack helpers ─────────────────────────────────────────────────────────────
async function postMsg(channel, text, threadTs) {
  const MAX = 3800;
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX) {
    let splitAt = remaining.lastIndexOf('\n', MAX);
    if (splitAt < 0) splitAt = MAX;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }
  chunks.push(remaining);

  for (const chunk of chunks) {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text: chunk, thread_ts: threadTs })
    });
  }
}

async function postTyping(channel, threadTs) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text: '⚖️ Toto is thinking...', thread_ts: threadTs })
  });
  const d = await r.json();
  return d.ts;
}

async function delMsg(channel, ts) {
  await fetch('https://slack.com/api/chat.delete', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, ts })
  });
}

async function uploadFileToSlack(channel, buffer, filename, title, threadTs) {
  const { FormData, Blob } = await import('node-fetch');
  const form = new FormData();
  form.append('token', SLACK_TOKEN);
  form.append('channels', channel);
  form.append('filename', filename);
  form.append('title', title || filename);
  if (threadTs) form.append('thread_ts', threadTs);
  form.append('file', new Blob([buffer]), filename);
  await fetch('https://slack.com/api/files.upload', { method: 'POST', body: form });
}

// ── Web search ────────────────────────────────────────────────────────────────
async function tavilySearch(query) {
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5 })
    });
    const d = await r.json();
    return (d.results || []).map(x => `• ${x.title}\n  ${x.content?.substring(0,300)}`).join('\n\n');
  } catch(e) { return ''; }
}

async function fetchWebPage(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    const html = await r.text();
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return text.substring(0, 4000);
  } catch(e) { return ''; }
}

// ── Language detection ────────────────────────────────────────────────────────
function detectLanguage(text) {
  const thaiRegex = /[\u0E00-\u0E7F]/;
  const ruRegex   = /[а-яёА-ЯЁ]/;
  if (thaiRegex.test(text)) return 'th';
  if (ruRegex.test(text))   return 'ru';
  return 'en';
}

function getChannelLanguageRule(channelId, textLang) {
  if (channelId === CH_RU) return 'ru';                     // always Russian
  if ([CH_TH_EN_1, CH_TH_EN_2].includes(channelId)) {
    return textLang === 'th' ? 'th' : 'en';                 // mirror input language
  }
  return textLang === 'th' ? 'th' : textLang === 'ru' ? 'ru' : 'en';
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function callClaude(messages, fileData, lang, isHermes) {
  const langInstructions = {
    ru: 'Отвечай ТОЛЬКО на русском языке.',
    en: 'Respond ONLY in English.',
    th: 'ตอบเป็นภาษาไทยเท่านั้น (Respond ONLY in Thai.)',
  };

  const systemPrompt = `Ты Toto — AI-юрист компании SBL IT Platforms Co., Ltd.
Ты специализируешься на:
- Тайском законодательстве (бизнес, контракты, корпоративное право, BOI, VAT, трудовое право)
- Российском законодательстве (экспортное право, ВЭД, корпоративное право, таможня)
- Международных договорах и контрактах (B2B, дистрибуция, поставки, NDA, агентские)
- Юридических консультациях по деловым вопросам в ЮВА и РФ
- Составлении и анализе договоров

СТИЛЬ РАБОТЫ:
- Отвечай чётко, структурированно, как опытный юрист
- Давай практичные рекомендации, не только теорию
- При составлении договоров — давай полный текст
- При анализе документов — указывай риски и рекомендации
- Всегда добавляй дисклеймер: "Это информационная консультация. Для юридически значимых действий рекомендуется верификация с практикующим юристом."

ЯЗЫК: ${langInstructions[lang] || langInstructions.en}
${isHermes ? `\n[ВАЖНО: Команда от Hermes (SBL Personal Assistant). Начни ответ с "<@${HERMES_USER_ID}>"]` : ''}

КОМПАНИЯ SBL IT PLATFORMS:
- Зарегистрирована в Таиланде
- Занимается дистрибуцией российских продуктов в ЮВА (Таиланд, Китай)
- Продукты: минеральная вода SBL, протеиновые батончики FitnesShock
- Работает с российскими производителями через экспортные контракты`;

  let msgs = [...messages];
  if (fileData) {
    const last = msgs[msgs.length - 1];
    if (fileData.type === 'image') {
      msgs[msgs.length - 1] = {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: fileData.mediaType, data: fileData.data } },
          { type: 'text', text: last.content }
        ]
      };
    } else if (fileData.type === 'document') {
      msgs[msgs.length - 1] = {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: fileData.mediaType, data: fileData.data } },
          { type: 'text', text: last.content }
        ]
      };
    }
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: msgs
    })
  });
  const d = await r.json();
  if (!d.content) throw new Error(d.error?.message || 'Claude error');
  return d.content[0].text;
}

// ── File handler ──────────────────────────────────────────────────────────────
async function getFileData(file) {
  try {
    const r = await fetch(file.url_private, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
    });
    const buf = await r.buffer();
    const b64 = buf.toString('base64');
    const mime = file.mimetype || 'application/octet-stream';

    if (mime.startsWith('image/')) return { type: 'image', mediaType: mime, data: b64 };
    if (mime === 'application/pdf') return { type: 'document', mediaType: mime, data: b64 };
    // For Word/text files — try to extract text
    const text = buf.toString('utf-8').replace(/[^\x20-\x7E\n\r\u0400-\u04FF\u0E00-\u0E7F]/g, ' ').trim();
    return { type: 'text', text: text.substring(0, 8000) };
  } catch(e) {
    console.error('File read error:', e.message);
    return null;
  }
}

// ── Slack events ──────────────────────────────────────────────────────────────
let BOT_ID = null;

app.post('/slack/events', async (req, res) => {
  const body = req.body;
  if (body?.type === 'url_verification') return res.status(200).json({ challenge: body.challenge });
  res.status(200).end('OK');

  const event = body?.event;
  if (!event || event.type !== 'message') return;
  if (event.subtype && event.subtype !== 'file_share') return;

  // Robust Hermes detection
  const isHermesEvent = (
    event.user === HERMES_USER_ID ||
    (event.username || '').toLowerCase().includes('sbl_personal') ||
    (event.username || '').toLowerCase().includes('hermes') ||
    (event.bot_profile?.name || '').toLowerCase().includes('hermes')
  );

  if (event.bot_id && !isHermesEvent) return;

  // Deduplication
  const key = event.client_msg_id || event.ts;
  if (processed.has(key)) return;
  processed.add(key);
  setTimeout(() => processed.delete(key), 60000);

  // Resolve BOT_ID
  if (!BOT_ID) {
    try {
      const r = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
      });
      BOT_ID = (await r.json()).user_id;
      console.log('Toto Bot ID:', BOT_ID);
    } catch { return; }
  }

  const channel   = event.channel;
  const threadTs  = event.thread_ts || event.ts;
  const isDM      = event.channel_type === 'im';
  const rawText   = event.text || '';
  const rawLower  = rawText.toLowerCase();

  // Check if Toto is mentioned or it's a DM or Hermes
  const isMentioned      = BOT_ID ? rawText.includes(`<@${BOT_ID}>`) : false;
  const isNameMentioned  = rawLower.includes('@toto') || rawText.includes('<@U0TOTO>'); // will update with real ID
  const isFromHermes     = isHermesEvent;
  const isInTotoChannel  = TOTO_CHANNELS.includes(channel);

  console.log(`Toto event: channel=${channel} isDM=${isDM} isMentioned=${isMentioned} isHermes=${isFromHermes}`);

  // Only respond if: DM, in Toto channel, @mentioned, or Hermes
  if (!isDM && !isInTotoChannel && !isMentioned && !isFromHermes) return;
  if (isInTotoChannel && !isMentioned && !isFromHermes && !isDM) return;

  // Language detection
  const textLang    = detectLanguage(rawText);
  const responseLang = isDM ? textLang : getChannelLanguageRule(channel, textLang);

  // Conversation key
  const userText  = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();
  const convKey   = isDM ? (event.user || 'dm') : `${channel}:${threadTs}`;

  if (!memory.conversations[convKey]) memory.conversations[convKey] = [];
  const hist = memory.conversations[convKey];

  // Handle file attachments
  let fileData = null;
  if (event.files?.length > 0) {
    const file = event.files[0];
    fileData = await getFileData(file);
    if (fileData?.type === 'text') {
      // Inject text content into prompt
      const enrichedText = userText + `\n\n[Содержимое документа "${file.name}":\n${fileData.text}]`;
      hist.push({ role: 'user', content: enrichedText });
      fileData = null;
    } else {
      hist.push({ role: 'user', content: userText || 'Проанализируй этот документ.' });
    }
  } else {
    if (!userText) return;
    hist.push({ role: 'user', content: userText });
  }

  // Typing indicator
  const typingTs = await postTyping(channel, threadTs).catch(() => null);

  try {
    // Auto-search for legal questions
    let enrichedPrompt = hist[hist.length - 1].content;
    const isLegalSearch = /закон|статья|кодекс|law|act|regulation|thai|thailand|таиланд|налог|tax|contract|договор|регистра|company|нарушение|штраф/i.test(userText);

    if (isLegalSearch && userText.length > 20) {
      const searchQuery = `${userText} legal law Thailand Russia`;
      const searchResults = await tavilySearch(searchQuery);
      if (searchResults) {
        enrichedPrompt += `\n\n[Актуальная правовая информация из поиска:\n${searchResults}]`;
        hist[hist.length - 1] = { role: 'user', content: enrichedPrompt };
      }
    }

    // Check for URLs in message
    const urlMatch = userText.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const pageContent = await fetchWebPage(urlMatch[0]);
      if (pageContent) {
        enrichedPrompt += `\n\n[Содержимое страницы ${urlMatch[0]}:\n${pageContent}]`;
        hist[hist.length - 1] = { role: 'user', content: enrichedPrompt };
      }
    }

    const reply = await callClaude(hist, fileData, responseLang, isFromHermes);

    if (typingTs) await delMsg(channel, typingTs);

    hist.push({ role: 'assistant', content: reply });
    if (hist.length > 20) hist.splice(0, hist.length - 20);
    memory.conversations[convKey] = hist;

    // Add @Hermes prefix if needed
    const finalReply = isFromHermes ? `<@${HERMES_USER_ID}> ${reply}` : reply;
    await postMsg(channel, finalReply, threadTs);

  } catch(e) {
    if (typingTs) await delMsg(channel, typingTs);
    console.error('Toto error:', e.message);
    const errMsg = responseLang === 'ru'
      ? `⚠️ Ошибка: ${e.message}`
      : responseLang === 'th'
      ? `⚠️ ข้อผิดพลาด: ${e.message}`
      : `⚠️ Error: ${e.message}`;
    await postMsg(channel, errMsg, threadTs);
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.send('⚖️ Toto Lawyer v1.0 — SBL IT Platforms'));

app.listen(PORT, () => {
  console.log(`⚖️ Toto Lawyer running on port ${PORT}`);
  console.log(`Channels: RU=${CH_RU} | TH/EN=${CH_TH_EN_1},${CH_TH_EN_2}`);
});
