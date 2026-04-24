const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Strip whitespace from env vars to avoid line-break issues
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/\s+/g, '').trim();
const SLACK_TOKEN = (process.env.SLACK_BOT_TOKEN || '').replace(/\s+/g, '').trim();

app.use((req, res, next) => {
  req.rawBody = '';
  req.on('data', chunk => { req.rawBody += chunk.toString(); });
  req.on('end', () => {
    try { req.body = req.rawBody ? JSON.parse(req.rawBody) : {}; }
    catch { req.body = {}; }
    next();
  });
});

// ── FELIX SYSTEM PROMPT ───────────────────────────────────────
const FELIX_SYSTEM = `You are Felix, the B2B Sales AI Agent for SBL IT Platforms Co., Ltd. — a Thai distributor of healthy foods and beverages.
COMPANY: SBL IT PLATFORMS CO., LTD. | www.sblplat.co.th | www.sblplat.store
TARGETS: Revenue ฿250,000/month | New B2B Clients: 10-20/month
PRODUCTS:
- SBL Water 0.5L Glass: ฿54(500+)/฿58(40-499)/฿60(credit)/฿65(retail)
- SBL Water 0.5L PET: ฿44(500+)/฿48(40-499)/฿50(credit)/฿55(retail)
- FitnesShock Brownies (Cookie Cream/Banana Choc/Hot Choc/Coconut Pie) 50g: ฿75/pc
- SHOCKS! Bars (Pistachio/Peanut) 50g: ฿65/pc
- FitnesShock Dessert Bars (Banana/Pistachio) 60g: ฿75/pc — 20g protein!
- NEW Glazed Bars (Caramel-Coconut/Choc-Coconut) 35g: ฿60/pc
TASKS: Lead generation, bilingual outreach (English+Thai), proposals, follow-ups, pipeline tracking, closing.
FORMAT: Slack markdown *bold*, • bullets, emojis. Concise. Always end with next step.
LANGUAGE: English default, switch to Thai if user writes Thai.`;

// ── ALEXEY SYSTEM PROMPT ──────────────────────────────────────
const ALEXEY_SYSTEM = `Ты Алексей — AI-агент по партнёрству компании SBL IT Platforms Co., Ltd. Ты общаешься ТОЛЬКО на русском языке.

О КОМПАНИИ SBL IT PLATFORMS:
- Полное название: SBL IT PLATFORMS CO., LTD.
- Роль: Дистрибьютор на рынках Таиланда, ЮВА и Китая
- Сайты: www.sblplat.co.th | www.sblplat.store
- Текущий портфель: SBL Mineral Water with SI, FitnesShock (протеиновые батончики и брауни)

ЧТО МЫ ПРЕДЛАГАЕМ РОССИЙСКИМ ПАРТНЁРАМ:
- Выход на рынок Таиланда (67 млн потребителей)
- Выход на рынки ЮВА (Вьетнам, Малайзия, Сингапур, Индонезия и др.)
- Выход на рынок Китая
- Полный цикл дистрибуции: импорт, таможня, склад, продажи, маркетинг
- Доступ к каналам: Tops, Villa Market, Big C, аптеки, фитнес-клубы, HoReCa, Lazada, Shopee
- Юридическое сопровождение и соответствие местным стандартам (FDA Таиланда и др.)

КАТЕГОРИИ ТОВАРОВ:
1. Продукты питания и напитки (здоровое питание, органика, функциональные продукты)
2. Спортивное питание и БАДы (протеин, витамины, суперфуды)
3. Косметика и уход (натуральная, органическая, профессиональная)
4. Любая качественная продукция российского производства

ЗАДАЧИ:
1. ПОИСК ПАРТНЁРОВ: Квалифицируй российских экспортёров. Вопросы: категория товара, объёмы, сертификаты, опыт экспорта, бюджет, целевые рынки.
2. ОНБОРДИНГ: Объясняй процесс входа на азиатский рынок. Требования FDA Таиланда, таможня, маркировка, сертификация.
3. КОММУНИКАЦИИ: Составляй деловые письма на русском языке для партнёров.
4. ОТСЛЕЖИВАНИЕ: Помогай структурировать информацию о партнёрах и статусе переговоров.
5. МОНИТОРИНГ: KPI партнёров, объёмы поставок, выполнение планов.
6. ВОЗМОЖНОСТИ: Анализируй потенциал роста, новые категории, расширение географии.

КВАЛИФИКАЦИЯ ПАРТНЁРА:
- 🔥 Горячий: сертификаты есть, объём >10 тонн/мес, бюджет есть, готов работать
- ⚡ Тёплый: потенциал есть, но нужна доработка
- ❄️ Холодный: маленький объём, нет сертификатов, нет бюджета

СТИЛЬ: Всегда на русском. Профессионально и дружелюбно. Конкретные следующие шаги. Slack-форматирование: *жирный*, • маркеры.`;

// ── CHANNEL → AGENT MAPPING ───────────────────────────────────
// Maps Slack channel IDs or name patterns to agent configs
const AGENTS = {
  felix: {
    system: FELIX_SYSTEM,
    name: 'Felix',
    greeting: `*สวัสดีครับ!* 👋 I'm *Felix*, Sales Agent for SBL IT Platforms!\n\n• \`@Felix generate leads\`\n• \`@Felix write outreach email\`\n• \`@Felix create sales proposal\`\n• \`@Felix how to hit ฿250k this month\``
  },
  alexey: {
    system: ALEXEY_SYSTEM,
    name: 'Alexey',
    greeting: `*Добрый день!* 👋 Я *Алексей*, агент по партнёрству SBL IT Platforms.\n\nПомогаю российским производителям выйти на рынки Таиланда, ЮВА и Китая.\n\n• \`@Alexey найди партнёров в категории спортпит\`\n• \`@Alexey квалифицируй партнёра\`\n• \`@Alexey составь письмо партнёру\`\n• \`@Alexey отчёт по партнёрам\``
  }
};

// Channel name patterns to identify which agent to use
function getAgentFromChannel(channelName) {
  if (!channelName) return 'felix';
  const lower = channelName.toLowerCase();
  if (lower.includes('alexey') || lower.includes('partners') || lower.includes('алексей')) return 'alexey';
  return 'felix'; // default
}

// Store channel names cache
const channelCache = new Map();

async function getChannelName(channelId) {
  if (channelCache.has(channelId)) return channelCache.get(channelId);
  try {
    const r = await fetch(`https://slack.com/api/conversations.info?channel=${channelId}`, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
    });
    const d = await r.json();
    const name = d.channel?.name || '';
    channelCache.set(channelId, name);
    return name;
  } catch { return ''; }
}

const conversations = new Map();
const processed = new Set();
let BOT_ID = null;

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  const keyPreview = ANTHROPIC_KEY ? ANTHROPIC_KEY.substring(0, 20) + '...' : 'MISSING';
  res.json({
    status: 'ok',
    agents: ['Felix (Sales)', 'Alexey (Partners/RU)'],
    company: 'SBL IT Platforms Co., Ltd.',
    key: keyPreview,
    keyLength: ANTHROPIC_KEY.length
  });
});

// ── Slack Events ──────────────────────────────────────────────
app.post('/slack/events', async (req, res) => {
  const body = req.body;
  if (body && body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }
  res.status(200).end('OK');

  const event = body && body.event;
  if (!event || event.type !== 'message' || event.subtype || event.bot_id) return;

  const key = event.client_msg_id || event.ts;
  if (processed.has(key)) return;
  processed.add(key);
  setTimeout(() => processed.delete(key), 60000);

  if (!BOT_ID) {
    try {
      const r = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
      });
      const d = await r.json();
      BOT_ID = d.user_id;
      console.log('Bot ID:', BOT_ID);
    } catch (e) { console.error('auth.test failed:', e); return; }
  }

  const isMentioned = event.text && event.text.includes(`<@${BOT_ID}>`);
  const isDM = event.channel_type === 'im';
  if (!isMentioned && !isDM) return;

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

  // Determine which agent based on channel name
  const channelName = await getChannelName(channel);
  const agentKey = getAgentFromChannel(channelName);
  const agent = AGENTS[agentKey];

  console.log(`Channel: ${channelName} → Agent: ${agent.name}`);

  if (!userText) {
    await post(channel, agent.greeting, threadTs);
    return;
  }

  const convKey = `${agentKey}:${isDM ? event.user : channel + ':' + threadTs}`;
  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const hist = conversations.get(convKey);
  hist.push({ role: 'user', content: userText });
  if (hist.length > 20) hist.splice(0, hist.length - 20);

  const typing = await post(channel, agentKey === 'alexey' ? '_Алексей думает... 🤔_' : '_Felix is thinking... 🤔_', threadTs);

  try {
    const reply = await claude(hist, agent.system);
    hist.push({ role: 'assistant', content: reply });
    if (typing && typing.ts) await del(channel, typing.ts);
    await post(channel, reply, threadTs);
  } catch (e) {
    console.error('Claude error:', e.message);
    if (typing && typing.ts) await del(channel, typing.ts);
    const errMsg = agentKey === 'alexey'
      ? `⚠️ Ошибка: ${e.message}. Попробуйте ещё раз.`
      : `⚠️ Error: ${e.message}. Please try again.`;
    await post(channel, errMsg, threadTs);
  }
});

// ── Slash commands ────────────────────────────────────────────
app.post('/slack/commands', async (req, res) => {
  const p = new URLSearchParams(req.rawBody);
  const text = p.get('text') || 'Представься и расскажи что ты умеешь';
  const channel_id = p.get('channel_id') || '';
  const user_id = p.get('user_id') || '';
  const command = p.get('command') || '/felix';

  const agentKey = command.includes('alexey') ? 'alexey' : 'felix';
  const agent = AGENTS[agentKey];

  res.status(200).json({ response_type: 'in_channel', text: agentKey === 'alexey' ? `_Алексей работает над этим..._` : `_Felix is on it..._` });

  const convKey = `${agentKey}:cmd:${user_id}`;
  if (!conversations.has(convKey)) conversations.set(convKey, []);
  const hist = conversations.get(convKey);
  hist.push({ role: 'user', content: text });
  if (hist.length > 20) hist.splice(0, hist.length - 20);

  try {
    const reply = await claude(hist, agent.system);
    hist.push({ role: 'assistant', content: reply });
    await post(channel_id, `*${agent.name}:* ${reply}`);
  } catch (e) {
    await post(channel_id, `⚠️ Error: ${e.message}`);
  }
});

// ── Helpers ───────────────────────────────────────────────────
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
  } catch (e) { console.error('post error:', e); return null; }
}

async function del(channel, ts) {
  try {
    await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify({ channel, ts })
    });
  } catch (e) { console.error('del error:', e); }
}

async function claude(messages, system) {
  console.log('Calling Claude, key length:', ANTHROPIC_KEY.length);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system,
      messages
    })
  });
  const d = await r.json();
  console.log('Claude status:', r.status, d.type);
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${d.error?.message || JSON.stringify(d)}`);
  return d.content?.map(b => b.text || '').join('') || 'No response.';
}

app.listen(PORT, () => console.log(`🤖 SBL AI Agents running on port ${PORT} — Felix (Sales) + Alexey (Partners/RU)`));
