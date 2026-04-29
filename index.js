'use strict';
const express = require('express');
const app = express();
const PORT = Number(process.env.PORT) || 3000;

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const APP_URL = process.env.APP_URL || '';

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'OAuth Helper' }));

app.get('/oauth/start', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets'
  ].join(' ');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${APP_URL}/oauth/callback&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent`;
  res.redirect(url);
});

app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('No code provided');
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: `${APP_URL}/oauth/callback`, grant_type: 'authorization_code' })
    });
    const d = await r.json();
    const token = d.refresh_token || 'NO_REFRESH_TOKEN — try again';
    res.send(`<h2>✅ Успешно!</h2><p>Скопируй <strong>GOOGLE_OAUTH_REFRESH_TOKEN</strong>:</p><textarea style="width:100%;height:80px">${token}</textarea><br><br><p>Полный ответ:</p><textarea style="width:100%;height:120px">${JSON.stringify(d,null,2)}</textarea>`);
  } catch (e) { res.send('Error: ' + e.message); }
});

app.listen(PORT, () => console.log(`✅ OAuth Helper on port ${PORT}`));
