/**
 * gambar.js — Generate gambar langsung via API Google (tanpa jalanin agent agy)
 * Memanfaatkan OAuth token Antigravity yang sudah ada + endpoint v1internal:generateContent.
 *
 * Token: baca dari ~/.gemini/antigravity-cli/antigravity-oauth-token (file yang sama
 * yang selalu di-refresh agy). Jika access_token expired, coba refresh_token.
 */
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = '/root/.gemini/antigravity-cli/antigravity-oauth-token';
const ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const MODEL = 'gemini-3.1-flash-image';

// kandidat kredensial OAuth untuk refresh (bisa diisi via env agar aman)
const CLIENT_ID = process.env.AGY_CLIENT_ID || '';
const CLIENT_SECRETS = (process.env.AGY_CLIENT_SECRET || '').split(',').filter(Boolean);

function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}

async function getAccessToken() {
  const d = readToken();
  if (!d) throw new Error('File token OAuth tidak ditemukan. Jalankan /login dulu.');
  const tok = d.token || d;
  // Coba langsung pakai access_token yang ada
  if (tok.access_token) {
    const ok = await probeToken(tok.access_token);
    if (ok) return tok.access_token;
  }
  // expired → coba refresh
  if (tok.refresh_token) {
    for (const secret of CLIENT_SECRETS) {
      try {
        const res = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: secret,
            refresh_token: tok.refresh_token,
            grant_type: 'refresh_token',
          }),
        });
        if (res.ok) {
          const j = await res.json();
          // simpan token baru agar next call lebih cepat
          try {
            const nd = { ...d, token: { ...(d.token || {}), ...j, refresh_token: j.refresh_token || tok.refresh_token } };
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(nd, null, 2));
          } catch {}
          console.log('[gambar] access token refreshed via refresh_token');
          return j.access_token;
        }
      } catch {}
    }
  }
  throw new Error('Token expired & refresh gagal. Kirim prompt biasa dulu di topic (biar agy refresh token), lalu ulangi /gambar.');
}

// probe ringan: apakah token masih valid (cek via endpoint quota user)
async function probeToken(access) {
  try {
    const res = await fetch(`${ENDPOINT}:loadCodeAssist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    return res.status !== 401;
  } catch { return true; } // jika network error, anggap valid (biar tetap dicoba)
}

/**
 * Generate gambar. refs: array path file gambar (maks 3) sebagai referensi edit.
 * Return { ok: true, buffer, mimeType } atau { ok: false, error, resetIn }
 */
async function generateImage(prompt, refs = []) {
  const access = await getAccessToken();
  const parts = [{ text: prompt }];
  for (const r of refs.slice(0, 3)) {
    try {
      const b = fs.readFileSync(r);
      const ext = path.extname(r).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      parts.push({ inlineData: { mimeType: mime, data: b.toString('base64') } });
    } catch {}
  }
  const body = {
    model: MODEL,
    request: { contents: [{ role: 'user', parts }] },
  };
  const res = await fetch(`${ENDPOINT}:generateContent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity-cli/1.0',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = j.error?.message || msg; } catch {}
    const rm = (msg || '').match(/reset after ([\dhmst\s]+?)\.?$/i) || (msg || '').match(/Resets in ([\dhm\s]+?)\.?$/i);
    const err = new Error(msg);
    err.status = res.status;
    err.resetIn = rm ? rm[1].trim() : null;
    throw err;
  }
  // parse respons: candidates[0].content.parts[] → cari inlineData
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Respons bukan JSON valid.'); }
  const cands = j.candidates || j.response?.candidates || [];
  for (const c of cands) {
    const prts = c.content?.parts || [];
    for (const p of prts) {
      const inline = p.inlineData || p.inline_data;
      if (inline?.data) {
        return { ok: true, buffer: Buffer.from(inline.data, 'base64'), mimeType: inline.mimeType || inline.mime_type || 'image/png' };
      }
    }
  }
  // ada teks tapi tanpa gambar → kemungkinan model menolak / prompt tidak jelas
  const txt = cands[0]?.content?.parts?.map(p => p.text).filter(Boolean).join(' ') || '';
  throw new Error(txt ? `Model tidak menghasilkan gambar: ${txt.slice(0, 200)}` : 'Model tidak menghasilkan gambar (respons kosong).');
}

module.exports = { generateImage };
