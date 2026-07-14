'use strict';

// voice-agent.js — движок голосового агента на Twilio ConversationRelay
//
//   Собеседник ⟷ Twilio (Google STT/TTS) ⟷ WebSocket ⟷ этот файл ⟷ Claude
//
// Подключение в index.js (Felix):
//
//   const http = require('http');
//   const voice = require('./voice-agent');
//   const server = http.createServer(app);
//   voice.attach({ app, server, scenario: 'FELIX', onOutcome: myHandler });
//   server.listen(PORT);      // ВМЕСТО app.listen(PORT)
//
// ENV (Railway):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
//   PUBLIC_HOST        — домен сервиса без схемы, напр. web-production-6afcd.up.railway.app
//   ANTHROPIC_API_KEY

const WebSocket = require('ws');
const SCRIPTS   = require('./voice-script');

const ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const AUTH_TOKEN  = (process.env.TWILIO_AUTH_TOKEN  || '').trim();
const FROM_NUMBER = (process.env.TWILIO_PHONE_NUMBER || '').trim();
const PUBLIC_HOST = (process.env.PUBLIC_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const CLAUDE_KEY  = (process.env.ANTHROPIC_API_KEY || '').trim();

const MODEL = 'claude-sonnet-4-6';

// Живые звонки: callSid → { scenario, history, meta, lang }
const calls = new Map();

let onOutcomeHandler = null;

/* ═══════════════════════  CLAUDE  ═══════════════════════ */

async function askClaude(scenario, history) {
  const cfg = SCRIPTS[scenario];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,           // короткие реплики — это телефон
      system: cfg.systemPrompt,
      messages: history,
      tools: [
        {
          name: 'end_call',
          description: 'Завершить звонок, когда разговор закончен',
          input_schema: {
            type: 'object',
            properties: {
              reason: { type: 'string', description: 'success | refused | voicemail | wrong_number' },
              farewell: { type: 'string', description: 'Прощальная фраза, её произнесут перед отбоем' },
            },
            required: ['reason'],
          },
        },
        {
          name: 'switch_language',
          description: 'Переключить язык разговора, если собеседник не понимает или просит другой язык',
          input_schema: {
            type: 'object',
            properties: { language: { type: 'string', description: 'th-TH или en-US' } },
            required: ['language'],
          },
        },
      ],
    }),
  });

  const d = await r.json();
  if (!r.ok) {
    console.error('❌ Claude error:', d.error?.message || r.status);
    return { text: '', tool: null };
  }

  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
  const tool = (d.content || []).find(b => b.type === 'tool_use') || null;
  return { text, tool, raw: d.content };
}

/* ═══════════════════════  WEBSOCKET  ═══════════════════════ */

function handleSocket(ws) {
  let callSid = null;

  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  const say  = (t) => send({ type: 'text', token: t, last: true });

  ws.on('message', async (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }

    /* — соединение установлено — */
    if (ev.type === 'setup' || ev.type === 'connected') {
      callSid = ev.callSid || ev.callSid;
      const st = calls.get(callSid);
      console.log('📞 WS connected:', callSid, '| scenario:', st?.scenario || '?');
      return;
    }

    /* — собеседник что-то сказал — */
    if (ev.type === 'prompt') {
      const st = calls.get(callSid);
      if (!st) { say('ขอโทษค่ะ'); return; }

      const heard = String(ev.voicePrompt || '').trim();
      if (!heard) return;
      console.log(`🗣️  [${callSid}] Собеседник: ${heard}`);

      // ВАЖНО: речь собеседника — недоверенный ввод. Кладём её как user-сообщение,
      // инструкции живут только в system prompt.
      st.history.push({ role: 'user', content: heard });

      const { text, tool } = await askClaude(st.scenario, st.history);

      if (text) {
        st.history.push({ role: 'assistant', content: text });
        console.log(`🤖 [${callSid}] Агент: ${text}`);
        say(text);
      }

      if (tool?.name === 'switch_language') {
        const cfg = SCRIPTS[st.scenario];
        const lang = tool.input.language === cfg.altLanguage ? cfg.altLanguage : cfg.language;
        const voice = lang === cfg.altLanguage ? cfg.altVoice : cfg.voice;
        st.lang = lang;
        send({ type: 'language', ttsLanguage: lang, transcriptionLanguage: lang, voice });
        console.log(`🌐 [${callSid}] Язык → ${lang}`);
      }

      if (tool?.name === 'end_call') {
        const { reason, farewell } = tool.input;
        if (farewell) say(farewell);
        console.log(`👋 [${callSid}] Завершение: ${reason}`);
        setTimeout(() => send({ type: 'end', reason }), 3500); // дать договорить
        st.endReason = reason;
      }
      return;
    }

    /* — собеседник перебил бота — */
    if (ev.type === 'interrupt') {
      console.log(`✋ [${callSid}] перебил`);
      return;
    }

    if (ev.type === 'error') {
      console.error(`❌ [${callSid}] CR error:`, ev.description);
    }
  });

  ws.on('close', async () => {
    if (!callSid) return;
    const st = calls.get(callSid);
    if (!st) return;
    console.log(`📴 WS closed: ${callSid}`);
    await finishCall(callSid).catch(e => console.error('finishCall:', e.message));
  });
}

/* ═══════════════════════  ИТОГ ЗВОНКА  ═══════════════════════ */

async function summarize(st) {
  if (!st.history.length) return { outcome: 'no_answer', summary: 'Разговора не было.' };

  const transcript = st.history
    .map(m => (m.role === 'user' ? 'Собеседник: ' : 'Агент: ') + m.content)
    .join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system: 'Ты разбираешь стенограмму холодного B2B-звонка. Верни ТОЛЬКО JSON, без markdown и пояснений.',
      messages: [{
        role: 'user',
        content: `Стенограмма:\n\n${transcript}\n\nВерни JSON:
{
  "outcome": "success | callback | refused | gatekeeper | voicemail | wrong_number",
  "contact_name": "имя или ''",
  "contact_role": "должность или ''",
  "email": "email или ''",
  "phone": "телефон или ''",
  "interest": "что заинтересовало или ''",
  "next_step": "конкретный следующий шаг",
  "summary": "2-3 предложения по-русски"
}`,
      }],
    }),
  });

  const d = await r.json();
  const txt = (d.content || []).map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
  try { return JSON.parse(txt); }
  catch { return { outcome: 'unknown', summary: txt.slice(0, 400) }; }
}

async function finishCall(callSid) {
  const st = calls.get(callSid);
  if (!st || st.done) return;
  st.done = true;

  const result = await summarize(st);
  result.callSid  = callSid;
  result.to       = st.meta.to;
  result.company  = st.meta.company || '';
  result.scenario = st.scenario;
  result.turns    = st.history.length;
  result.transcript = st.history
    .map(m => (m.role === 'user' ? 'Собеседник: ' : 'Агент: ') + m.content).join('\n');

  console.log(`📊 [${callSid}] Итог: ${result.outcome} | ${result.summary}`);

  if (onOutcomeHandler) {
    try { await onOutcomeHandler(result, st.meta); }
    catch (e) { console.error('onOutcome error:', e.message); }
  }

  calls.delete(callSid);
}

/* ═══════════════════════  ИСХОДЯЩИЙ ЗВОНОК  ═══════════════════════ */

/**
 * Позвонить и подключить голосового агента.
 * @param {string} to        номер в E.164 (+66...)
 * @param {string} scenario  'FELIX' | 'ALEXEY'
 * @param {object} meta      { company, channel, threadTs, rowIdx } — вернётся в onOutcome
 */
async function placeCall(to, scenario = 'FELIX', meta = {}) {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) throw new Error('Twilio ENV не заданы');
  if (!PUBLIC_HOST) throw new Error('PUBLIC_HOST не задан');
  if (!SCRIPTS[scenario]) throw new Error('Неизвестный сценарий: ' + scenario);

  const body = new URLSearchParams({
    To: to,
    From: FROM_NUMBER,
    Url: `https://${PUBLIC_HOST}/voice/twiml?scenario=${scenario}`,
    Method: 'POST',
    StatusCallback: `https://${PUBLIC_HOST}/voice/status`,
    StatusCallbackMethod: 'POST',
    // Отсекаем автоответчики — агент не будет разговаривать с голосовой почтой
    MachineDetection: 'Enable',
    AsyncAmd: 'true',
    AsyncAmdStatusCallback: `https://${PUBLIC_HOST}/voice/amd`,
  });

  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }
  );

  const d = await r.json();
  if (!r.ok) {
    console.error('❌ Twilio call failed:', d.message || r.status, '| to:', to);
    throw new Error(d.message || 'Twilio error ' + r.status);
  }

  calls.set(d.sid, {
    scenario,
    history: [],
    meta: { ...meta, to },
    lang: SCRIPTS[scenario].language,
    done: false,
  });

  console.log(`☎️  Звоним ${to} | SID: ${d.sid} | сценарий: ${scenario}`);
  return { sid: d.sid, status: d.status };
}

/* ═══════════════════════  ПОДКЛЮЧЕНИЕ К EXPRESS  ═══════════════════════ */

function attach({ app, server, onOutcome }) {
  onOutcomeHandler = onOutcome || null;

  // Twilio дёргает это, когда сняли трубку → отдаём TwiML
  app.post('/voice/twiml', (req, res) => {
    const scenario = req.query.scenario || 'FELIX';
    const cfg = SCRIPTS[scenario] || SCRIPTS.FELIX;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="wss://${PUBLIC_HOST}/voice/ws"
      welcomeGreeting="${escapeXml(cfg.greeting)}"
      language="${cfg.language}"
      ttsLanguage="${cfg.language}"
      transcriptionLanguage="${cfg.language}"
      voice="${cfg.voice}"
      transcriptionProvider="${cfg.transcriptionProvider}"
      speechModel="${cfg.speechModel}"
      interruptible="true" />
  </Connect>
</Response>`;

    res.type('text/xml').send(xml);
  });

  // Автоответчик → кладём трубку, не тратим минуты
  app.post('/voice/amd', async (req, res) => {
    res.status(200).end();
    const { CallSid, AnsweredBy } = req.body || {};
    if (!CallSid) return;
    console.log(`🔎 AMD [${CallSid}]: ${AnsweredBy}`);

    if (AnsweredBy && AnsweredBy.startsWith('machine')) {
      const st = calls.get(CallSid);
      if (st) st.endReason = 'voicemail';
      await hangup(CallSid).catch(() => {});
    }
  });

  // Статусы звонка
  app.post('/voice/status', async (req, res) => {
    res.status(200).end();
    const { CallSid, CallStatus, CallDuration } = req.body || {};
    if (!CallSid) return;
    console.log(`📈 [${CallSid}] ${CallStatus}${CallDuration ? ' | ' + CallDuration + 's' : ''}`);

    if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
      const st = calls.get(CallSid);
      if (st) {
        st.meta.callStatus = CallStatus;
        st.meta.duration = CallDuration;
        // Не дозвонились — разговора нет, сразу отдаём итог
        if (!st.history.length) {
          st.done = true;
          if (onOutcomeHandler) {
            await onOutcomeHandler({
              callSid: CallSid, to: st.meta.to, scenario: st.scenario,
              outcome: CallStatus === 'completed' ? 'voicemail' : CallStatus.replace('-', '_'),
              summary: 'Не дозвонились: ' + CallStatus,
              transcript: '',
            }, st.meta).catch(() => {});
          }
          calls.delete(CallSid);
        } else {
          await finishCall(CallSid).catch(() => {});
        }
      }
    }
  });

  // WebSocket на том же HTTP-сервере
  const wss = new WebSocket.Server({ server, path: '/voice/ws' });
  wss.on('connection', handleSocket);

  console.log('✅ Voice agent готов: /voice/twiml, /voice/ws, /voice/status, /voice/amd');
}

async function hangup(callSid) {
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${callSid}.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ Status: 'completed' }),
  });
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = { attach, placeCall, hangup };
