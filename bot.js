/**
 * AGYBot — Jembatan Telegram <-> Antigravity CLI
 * Grup Topic = Folder = Sesi AI
 *
 * Struktur folder per topic:
 *   sessions/<slug>/
 *     AGENT.md       <- otomatis dibuat
 *     project/       <- tempat upload file/zip
 *     state.json     <- conversation_id + model
 */
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { execFile, spawnSync, spawn } = require('child_process');
const { mdToTelegramHtml, splitMessage, escapeHtml } = require('./mdconv');
const { generateImage } = require('./gambar');

const BOT_TOKEN = process.env.BOT_TOKEN || fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim();
const ALLOWED_CHAT = process.env.ALLOWED_CHAT; // optional: chat id grup
const BASE = path.join(__dirname, 'sessions');
const AGY = '/root/.local/bin/agy';
const TOKEN_FILE = '/root/.gemini/antigravity-cli/antigravity-oauth-token';
const TOKEN_BAK = path.join(__dirname, 'auth-backup', 'antigravity-oauth-token.bak');

// ---------- auth helpers ----------
function whoamiEmail() {
  try {
    const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return d.id_token_email || '(email tidak diketahui)';
  } catch { return null; }
}

// state sesi login aktif (hanya 1 pada satu waktu)
let loginState = null; // { proc, poll, timeout, chatId, threadId, msgId, hadOld }

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function extractLoginUrl(buf) {
  const clean = stripAnsi(buf.toString('utf8'));
  const m = clean.match(/https:\/\/accounts\.google\.com\S*/);
  return m ? m[0].trim() : null;
}

function loginCleanup(restoreOld) {
  if (!loginState) return;
  try { clearInterval(loginState.poll); } catch {}
  try { clearTimeout(loginState.timeout); } catch {}
  try { loginState.proc.kill('SIGKILL'); } catch {}
  if (restoreOld && loginState.hadOld && fs.existsSync(TOKEN_BAK)) {
    fs.copyFileSync(TOKEN_BAK, TOKEN_FILE);
  }
  loginState = null;
}

fs.mkdirSync(BASE, { recursive: true });

// ---------- util ----------
const slugify = (s) => (s || 'sesi')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sesi';

function topicDir(slug) {
  const d = path.join(BASE, slug);
  fs.mkdirSync(path.join(d, 'project'), { recursive: true });
  const agentMd = path.join(d, 'AGENT.md');
  if (!fs.existsSync(agentMd)) {
    fs.writeFileSync(agentMd, `# AGENT — ${slug}\n\nKamu adalah agent coding di folder proyek "${slug}".\nSemua file yang di-upload user ada di folder ./project/.\nKerjakan tugas di dalam folder ini. Tulis catatan penting ke AGENT.md ini.\nFormat Tabel & Respon:\n
- Jika user meminta perbandingan, jadwal, daftar harga, spesifikasi, atau data terstruktur, selalu sajikan dalam format Markdown Table standar dengan header dan pemisah kolom.\n- Berikan respon yang ramah, ringkas, solutif, dan profesional\n\nDibuat otomatis: ${new Date().toLocaleString('id-ID')}\n`);
  }
  return d;
}

// Pastikan folder topic ada sebelum baca/tulis state
function ensureState(slug, st) {
  topicDir(slug);
  writeState(slug, st);
}

function readState(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(BASE, slug, 'state.json'), 'utf8')); } catch { return {}; }
}
function writeState(slug, st) {
  fs.mkdirSync(path.join(BASE, slug), { recursive: true });
  fs.writeFileSync(path.join(BASE, slug, 'state.json'), JSON.stringify(st, null, 2));
}

function listTopics() {
  return fs.readdirSync(BASE).filter(f => fs.statSync(path.join(BASE, f)).isDirectory()).sort();
}

// Jalankan agy -p (print mode) dengan cwd folder topic — versi ASYNC (bot tetap responsif saat proses jalan)
function agyPrompt(cwd, text, model, conversationId) {
  return new Promise((resolve) => {
    const args = ['-p', text, '--output-format', 'json', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    if (conversationId) args.push('--conversation', conversationId);
    const proc = spawn(AGY, args, { cwd, env: { ...process.env, PATH: `/root/.local/bin:${process.env.PATH}` } });
    let out = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 10 * 60 * 1000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: 'ERROR', response: String(e.message || e), error: String(e) });
    });
    proc.on('close', () => {
      clearTimeout(timer);
      const lim = detectLimit(out);
      const m = out.match(/\{[\s\S]*\}/);
      if (m) { try { const j = JSON.parse(m[0]); j.limitDetected = lim; j.raw_output = out; resolve(j); return; } catch {} }
      resolve({ status: 'ERROR', response: (out.trim() || '(tidak ada output)'), error: 'parse', limitDetected: lim, raw_output: out });
    });
  });
}

// ---------- auto-kirim file hasil agy ke topic (gambar/video/audio/dokumen) ----------
const TELEGRAM_MAX_FILE = 49 * 1024 * 1024;
const brainDirOf = (cid) => cid ? `/root/.gemini/antigravity-cli/brain/${cid}` : null;
function snapshotFiles(roots) {
  const map = new Map();
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name === 'node_modules' || it.name === '.git') continue;
      if (it.name.startsWith('.') || it.name === 'state.json') continue; // skip file sistem/log internal agy & bot
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { try { const s = fs.statSync(p); map.set(p, `${s.size}:${Math.floor(s.mtimeMs / 1000)}`); } catch {} }
    }
  };
  for (const r of roots) if (r && fs.existsSync(r)) walk(r);
  return map;
}
function fileKind(f) {
  const e = path.extname(f).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(e)) return 'photo';
  if (['.mp4', '.mov', '.webm'].includes(e)) return 'video';
  if (['.mp3', '.ogg', '.wav', '.m4a'].includes(e)) return 'audio';
  return 'doc';
}
const crypto = require('crypto');
function md5OfFile(f) {
  try { return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'); } catch { return null; }
}
async function deliverNewFiles(ctx, threadId, before, after) {
  let fresh = [...after.keys()].filter((p) => after.get(p) !== before.get(p));
  if (!fresh.length) return 0;
  // terbaru dulu, maks 5 file per prompt
  fresh.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; } });
  // dedupe konten: agy sering nyimpen salinan identik di folder sesi & folder brain -> kirim cukup 1x
  const seenHash = new Set();
  fresh = fresh.filter((f) => {
    const h = md5OfFile(f);
    if (!h) return true;
    if (seenHash.has(h)) { console.log('[file] skip duplikat konten:', f); return false; }
    seenHash.add(h);
    return true;
  });
  if (!fresh.length) return 0;
  let sent = 0;
  for (const f of fresh) {
    if (sent >= 5) break;
    let s0; try { s0 = fs.statSync(f); } catch { continue; }
    if (s0.size === 0 || s0.size > TELEGRAM_MAX_FILE) continue;
    const cap = `📎 ${path.basename(f)} (${(s0.size / 1024).toFixed(1)} KB)`;
    const extra = { caption: cap, message_thread_id: threadId };
    try {
      const k = fileKind(f);
      if (k === 'photo') await ctx.telegram.sendPhoto(ctx.chat.id, { source: f }, extra);
      else if (k === 'video') await ctx.telegram.sendVideo(ctx.chat.id, { source: f }, extra);
      else if (k === 'audio') await ctx.telegram.sendAudio(ctx.chat.id, { source: f }, extra);
      else await ctx.telegram.sendDocument(ctx.chat.id, { source: f }, extra);
      sent++;
    } catch (e) { console.log('[file] gagal kirim', f, e.message); }
  }
  return sent;
}

// ---------- antrian proses (maks 2 proses agy paralel global, antre per topic) ----------
const MAX_PARALLEL = 2;
let running = 0;
const queues = {}; // slug -> [{ fn, resolve }, ...]

function pump() {
  while (running < MAX_PARALLEL) {
    let next = null;
    for (const slug of Object.keys(queues)) {
      if (queues[slug].length) { next = { slug, job: queues[slug].shift() }; break; }
    }
    if (!next) return;
    running++;
    Promise.resolve().then(next.job.fn)
      .then((r) => next.job.resolve(r))
      .catch((e) => next.job.resolve({ status: 'ERROR', response: String(e.message || e) }))
      .finally(() => { running--; pump(); });
  }
}

function runQueued(slug, fn) {
  return new Promise((resolve) => {
    queues[slug] = queues[slug] || [];
    queues[slug].push({ fn, resolve });
    pump();
  });
}

// Ambil list model dari CLI
function listModels() {
  const r = spawnSync(AGY, ['models'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: `/root/.local/bin:${process.env.PATH}` } });
  return (r.stdout || '').split('\n').filter(l => l.includes('\t')).map(l => {
    const [id, ...rest] = l.split('\t');
    return { id, label: rest.join(' ').trim() };
  });
}

async function sendLong(ctx, html, extra = {}) {
  for (const part of splitMessage(html)) {
    await ctx.telegram.sendMessage(ctx.chat.id, part, { parse_mode: 'HTML', disable_web_page_preview: true, message_thread_id: ctx.message?.message_thread_id, ...extra });
  }
}

// ---------- whitelist akses ----------
const WL_FILE = path.join(__dirname, 'whitelist.json');
let whitelist = { admins: [], users: [] };
try { whitelist = { admins: [], users: [], ...JSON.parse(fs.readFileSync(WL_FILE, 'utf8')) }; } catch {}
const saveWhitelist = () => { try { fs.writeFileSync(WL_FILE, JSON.stringify(whitelist, null, 2)); } catch {} };

// ---------- bot ----------
const bot = new Telegraf(BOT_TOKEN);

async function isWhitelisted(ctx) {
  // terbuka penuh kalau whitelist masih kosong (backward compatible)
  if (!whitelist.users.length && !whitelist.admins.length) return true;
  const uid = ctx.from?.id;
  if (!uid) return false;
  if (whitelist.users.includes(uid) || whitelist.admins.includes(uid)) return true;
  // admin/creator grup otomatis boleh
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, uid);
    if (['administrator', 'creator'].includes(m.status)) return true;
  } catch {}
  return false;
}

bot.use(async (ctx, next) => {
  if (ALLOWED_CHAT && String(ctx.chat?.id) !== String(ALLOWED_CHAT)) return;
  if (!(await isWhitelisted(ctx))) {
    if (ctx.chat && ctx.message) {
      ctx.reply('⛔ Kamu belum di-whitelist untuk pakai bot ini.\nMinta admin: /whitelist add <user_id>').catch(() => {});
    }
    return;
  }
  return next();
});

bot.start((ctx) => ctx.reply('🤖 AGYBot aktif. Buat/reply di topic grup ini, atau kirim /new <nama> untuk sesi baru.'));
bot.help((ctx) => ctx.reply([
  '📚 *Perintah AGYBot*',
  '',
  '🗂️ *Sesi*',
  '/new <nama> — buat sesi/topic baru',
  '/topics — daftar semua sesi',
  '/reset — mulai percakapan baru di topic ini',
  '/files — lihat isi folder project',
  '',
  '🎨 *Gambar (hemat kuota, instan)*',
  '/gambar <deskripsi> — generate gambar AI',
  '/gambar <instruksi> (reply foto) — edit foto',
  '',
  '📊 *Kuota & Status*',
  '/status — kondisi server & proses bot',
  '/model — ganti model AI untuk topic ini',
  '/quota — sisa kuota asli (mingguan & 5 jam)',
  '/usage — estimasi pemakaian',
  '',
  '🔐 *Akun & Akses (admin)*',
  '/whoami — akun agy yang aktif',
  '/login — login ulang akun',
  '/logout — keluar akun',
  '/whitelist add|del|list — atur siapa yg boleh pakai',
  '',
  '💬 Chat biasa di topic = prompt ke Antigravity.',
  '📎 Kirim file/zip di topic = masuk ke folder project/',
].join('\n')));

// /new <nama> — buat topic + folder
bot.command('new', async (ctx) => {
  const nama = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!nama) return ctx.reply('Pakai: /new <nama-sesi>');
  const slug = slugify(nama);
  topicDir(slug);
  const title = `${nama}`;
  try {
    if (ctx.chat.type === 'supergroup') {
      const t = await ctx.createForumTopic(title);
      await ctx.telegram.sendMessage(ctx.chat.id, `📁 Sesi "${nama}" siap di folder sessions/${slug}/ (AGENT.md + project/ dibuat)`, { message_thread_id: t.message_thread_id });
      return;
    }
  } catch (e) { console.error('create topic:', e.message); }
  ctx.reply(`📁 Sesi "${nama}" siap di folder sessions/${slug}/`);
});

bot.command('topics', (ctx) => {
  const t = listTopics();
  ctx.reply(t.length ? `📂 Sesi:\n${t.map(x => `• ${x}`).join('\n')}` : 'Belum ada sesi. /new <nama>');
});

bot.command('files', (ctx) => {
  const slug = slugify(ctx.message.forum_topic_created?.name || ctx.chat.title || '');
  const d = path.join(BASE, slug, 'project');
  const files = fs.existsSync(d) ? fs.readdirSync(d) : [];
  ctx.reply(files.length ? `📦 project/ (${slug}):\n${files.map(f => `• ${f}`).join('\n')}` : 'Folder project kosong.');
});

bot.command('reset', (ctx) => {
  const slug = activeTopicOf(ctx);
  const st = readState(slug);
  delete st.conversation_id;
  writeState(slug, st);
  ctx.reply(`🔄 Sesi "${slug}" direset — percakapan baru.`);
});

// /model — inline keyboard
bot.command('model', async (ctx) => {
  const models = listModels();
  const slug = activeTopicOf(ctx);
  const cur = readState(slug).model;
  const kb = models.map(m => [Markup.button.callback(`${m.id === cur ? '✅ ' : ''}${m.label}`, `setmodel:${m.id}`)]);
  await ctx.reply('🧠 Pilih model:', Markup.inlineKeyboard(kb));
});

bot.action(/^setmodel:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const slug = activeTopicOf(ctx);
  topicDir(slug);
  const st = readState(slug); st.model = id;
  // reset conversation agar model baru berlaku bersih
  delete st.conversation_id; writeState(slug, st);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`✅ Model topic ini: <b>${id}</b>`, { parse_mode: 'HTML' });
});

// ---------- /gambar — generate gambar instan via API image (tanpa agent) ----------
bot.command('gambar', async (ctx) => {
  const q = (ctx.message.text || '').replace(/^\/gambar(@\w+)?\s*/i, '').trim();
  const msg = ctx.message;
  if (!q) {
    return ctx.reply('🎨 Cara pakai: <code>/gambar kucing astronot naik sepeda</code>\n\nAtau reply pesan ini ke foto di topic untuk edit gambar (maks 3 foto referensi).', { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
  }
  const started = Date.now();
  const wait = await ctx.telegram.sendMessage(ctx.chat.id, '🎨 Menggambar…', { message_thread_id: msg.message_thread_id });
  try {
    const r = await generateImage(q);
    const ext = r.mimeType.includes('jpeg') ? 'jpg' : r.mimeType.includes('webp') ? 'webp' : 'png';
    const slug = activeTopicOf(ctx);
    const fname = `gambar_${Date.now()}.${ext}`;
    const outDir = path.join(BASE, slug, 'project');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, fname);
    fs.writeFileSync(outPath, r.buffer);
    const dur = Math.round((Date.now() - started) / 1000);
    await ctx.telegram.sendPhoto(ctx.chat.id, { source: outPath }, { caption: `🎨 <b>${escapeHtml(q).slice(0, 150)}</b>\n⚡ ${dur}s · ${MODEL}`, parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
  } catch (e) {
    const resetLine = e.resetIn ? `\n♻️ Reset kuota dalam: <b>${e.resetIn}</b>` : '';
    await ctx.telegram.editMessageText(ctx.chat.id, wait.chat.id, wait.message_id,
      `❌ Gagal generate gambar:\n<code>${escapeHtml(String(e.message || e)).slice(0, 300)}</code>${resetLine}\n\n💡 Alternatif: kirim prompt biasa "bikin gambar ..." di topic (via agent, pakai kuota agent).`,
      { parse_mode: 'HTML' }).catch(async () => {
      await ctx.telegram.sendMessage(ctx.chat.id, `❌ ${String(e.message || e).slice(0, 300)}`, { message_thread_id: msg.message_thread_id });
    });
  }
});

// /gambar sebagai reply ke foto → edit gambar referensi
bot.on('photo', async (ctx, next) => {
  const msg = ctx.message;
  if (msg.caption && /^\/gambar/i.test(msg.caption)) {
    const q = msg.caption.replace(/^\/gambar(@\w+)?\s*/i, '').trim() || 'perbaiki dan pertajam gambar ini';
    const started2 = Date.now();
    const wait = await ctx.telegram.sendMessage(ctx.chat.id, '🎨 Mengedit foto…', { message_thread_id: msg.message_thread_id });
    try {
      const photos = msg.photo || [];
      const best = photos[photos.length - 1];
      const link = await ctx.telegram.getFileLink(best.file_id);
      const tmp = path.join('/tmp', `ref_${msg.message_id}.jpg`);
      const buf = Buffer.from(await (await fetch(link)).arrayBuffer());
      fs.writeFileSync(tmp, buf);
      const r = await generateImage(q, [tmp]);
      const ext = r.mimeType.includes('jpeg') ? 'jpg' : r.mimeType.includes('webp') ? 'webp' : 'png';
      const slug = activeTopicOf(ctx);
      const fname = `edit_${Date.now()}.${ext}`;
      const outDir = path.join(BASE, slug, 'project');
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, fname);
      fs.writeFileSync(outPath, r.buffer);
      const dur = Math.round((Date.now() - started2) / 1000);
      await ctx.telegram.sendPhoto(ctx.chat.id, { source: outPath }, { caption: `🎨 Edit selesai\n⚡ ${dur}s`, message_thread_id: msg.message_thread_id });
      await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
      fs.unlinkSync(tmp);
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, wait.chat.id, wait.message_id, `❌ ${String(e.message || e).slice(0, 300)}`).catch(() => {});
    }
    return;
  }
  return next?.();
});

// Deteksi topic aktif dari pesan (reply di thread)
function activeTopicOf(ctx) {
  const tid = ctx.message?.message_thread_id;
  if (tid && ctx.chat.is_forum) {
    // pakai nama topic dari cache sederhana
    return ctx.topicSlug || slugify(ctx.topicTitle || '');
  }
  return slugify(ctx.chat.title || 'default');
}

// cache judul topic dari update
bot.on('message', async (ctx, next) => {
  if (ctx.chat.is_forum && ctx.message.message_thread_id) {
    try {
      // ambil nama topic via API getForumTopicIconStickers tidak ada; pakai chat.fullInfo tidak tersedia di telegraf core.
      // Simpan mapping thread->slug saat topic dibuat / first message via getMessageInfo:
    } catch {}
  }
  return next();
});

// --- pemetaan thread_id -> nama topic (dari Bot API getChat? gunakan method getForumTopicByThread jika ada) ---
async function topicTitle(ctx, threadId) {
  if (!threadId) return null;
  try {
    const res = await ctx.telegram.callApi('getForumTopicsByIDs', { chat_id: ctx.chat.id, message_thread_ids: [threadId] });
    const t = res?.topics?.[0];
    return t?.title || null;
  } catch { return null; }
}

// pemetaan thread_id -> judul topic (disimpan persisten)
const MAP_FILE = path.join(BASE, 'map.json');
let topicMap = {};
try { topicMap = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch {}
const saveMap = () => { try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(MAP_FILE, JSON.stringify(topicMap, null, 2)); } catch {} };

async function topicTitle(ctx, threadId) {
  if (!threadId) return null;
  // 1) dari pesan forum_topic_created yang menempel di update ini
  const ftc = ctx.message?.forum_topic_created;
  if (ftc?.name) return ftc.name;
  // 2) dari cache persisten
  if (topicMap[String(threadId)]) return topicMap[String(threadId)];
  // 3) dari pesan pertama topic (service message) via forward lookup
  try {
    const res = await ctx.telegram.callApi('getForumTopicIconStickers', {});
    void res;
  } catch {}
  return null;
}

// simpan mapping saat topic baru dibuat (via UI Telegram maupun /new)
bot.on('forum_topic_created', async (ctx, next) => {
  const ftc = ctx.message?.forum_topic_created;
  const tid = ctx.message?.message_thread_id;
  if (ftc?.name && tid) { topicMap[String(tid)] = ftc.name; saveMap(); console.log(`[topic-mapped] ${tid} -> ${ftc.name}`); }
  return next?.();
});

// ---------- /usage (asli dari respons CLI agy) ----------
const USAGE_FILE = path.join(BASE, 'usage.json');
let usageLog = {};
try { usageLog = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {}
const saveUsage = () => { try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usageLog, null, 2)); } catch {} };

bot.command('usage', async (ctx) => {
  const slug = activeTopicOf(ctx);
  const fmt = (n) => (n || 0).toLocaleString('id-ID');
  let lines = [`📊 Usage sesi: ${slug}`];
  const st = readState(slug);
  if (st.last_usage) {
    const u = st.last_usage;
    lines.push(`• Model: ${st.last_model || '-'}`);
    lines.push(`• Terakhir: in ${fmt(u.input_tokens)} + out ${fmt(u.output_tokens)} = ${fmt(u.total_tokens)} token`);
  } else lines.push('• Belum ada pemakaian di sesi ini.');
  let tIn = 0, tOut = 0, tTot = 0, nReq = 0;
  for (const s of Object.keys(usageLog)) for (const e of usageLog[s]) { tIn += e.in; tOut += e.out; tTot += e.total; nReq++; }
  lines.push('', `🌐 Total semua sesi (${nReq} request):`);
  lines.push(`• Input: ${fmt(tIn)} | Output: ${fmt(tOut)} | Total: ${fmt(tTot)} token`);
  lines.push('', 'ℹ️ Angka di atas = pemakaian nyata token via CLI agy (kuota langganan dihitung server-side Google).');
  await ctx.reply(lines.join('\n'));
});

// ---------- alert kuota/limit ----------
const QUOTA_FILE = path.join(BASE, 'quota.json');
let quotaState = { lastLimit: null, notified: {} };
try { quotaState = { lastLimit: null, notified: {}, ...JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')) }; } catch {}
const saveQuota = () => { try { fs.writeFileSync(QUOTA_FILE, JSON.stringify(quotaState, null, 2)); } catch {} };
const QUOTA_COOLDOWN = 30 * 60 * 1000; // jangan spam alert, min. jeda 30 menit per jenis
const QUOTA_REQ_THRESHOLD = 40;        // request per model per 5 jam dianggap rawan limit

function detectLimit(raw) {
  const t = String(raw || '');
  const hit = (re) => re.test(t);
  if (hit(/week/i) && hit(/limit|quota|exceed/i)) return { window: 'week', label: 'Mingguan (1 week)' };
  if (hit(/5\s*hour|\b5h\b|lima jam/i) && hit(/limit|quota|exceed/i)) return { window: '5h', label: '5 jam' };
  if (hit(/rate.?limit|\b429\b|resource.?exhausted|quota|limit.*(reach|exceed)/i)) return { window: 'other', label: 'Rate limit' };
  return null;
}

// Ambil "Resets in Xm Ys" dari output error CLI (info resmi dari Google)
function extractResetIn(raw) {
  const m = String(raw || '').match(/Resets? in ([0-9dhm s]+)/i);
  return m ? m[1].trim() : null;
}

function quotaStats() {
  const now = Date.now(), w5 = 5 * 3600e3, w7 = 7 * 24 * 3600e3;
  const agg = {};
  for (const s of Object.keys(usageLog)) for (const e of usageLog[s]) {
    const m = e.model || 'default';
    agg[m] = agg[m] || { r5: 0, t5: 0, r7: 0, t7: 0 };
    const age = now - (e.ts || 0);
    if (age <= w7) { agg[m].r7++; agg[m].t7 += e.total || 0; }
    if (age <= w5) { agg[m].r5++; agg[m].t5 += e.total || 0; }
  }
  return agg;
}

bot.command('quota', async (ctx) => {
  await ctx.telegram.sendChatAction(ctx.chat.id, 'typing', { message_thread_id: ctx.message?.message_thread_id }).catch(() => {});

  // 1. Ambil kuota ASLI dari CLI agy (sumber sama dengan panel "Models & Quota" di TUI)
  let quota = null;
  try {
    const r = spawnSync(AGY, ['-p', '/usage', '--output-format', 'json'], {
      encoding: 'utf8', timeout: 90000,
      env: { ...process.env, PATH: `/root/.local/bin:${process.env.PATH}` }
    });
    if (r.status === 0 && r.stdout) {
      const j = JSON.parse(r.stdout);
      const buckets = j?.command?.data?.groups;
      if (Array.isArray(buckets) && buckets.length) quota = buckets;
    }
  } catch {}

  // 2. Estimasi pemakaian via bot (pemakaian nyata token) — data pendukung
  const agg = quotaStats();
  const fmt = (n) => (n || 0).toLocaleString('id-ID');

  const lines = ['🚦 <b>Models &amp; Quota</b>', ''];

  if (quota) {
    const bar = (frac) => {
      const total = 20, filled = Math.round(Math.max(0, Math.min(1, frac)) * total);
      return '▮'.repeat(filled) + '▯'.repeat(total - filled);
    };
    const pct = (f) => `${(f * 100).toFixed(1)}%`;
    const color = (f) => f > 0.5 ? '🟢' : f > 0.15 ? '🟡' : '🔴';
    const fmtReset = (iso) => {
      try {
        const diff = new Date(iso) - Date.now();
        if (diff <= 0) return 'segera';
        const h = Math.floor(diff / 3.6e6), m = Math.round((diff % 3.6e6) / 6e4);
        return h > 24 ? `${Math.floor(h / 24)}h ${h % 24}j ${m}m` : h > 0 ? `${h}j ${m}m` : `${m}m`;
      } catch { return iso; }
    };
    for (const g of quota) {
      lines.push(`🏷 <b>${escapeHtml(g.name)}</b>`);
      if (g.description) lines.push(`<i>${escapeHtml(g.description)}</i>`);
      lines.push('');
      for (const b of (g.buckets || [])) {
        const f = typeof b.remaining_fraction === 'number' ? b.remaining_fraction : 0;
        lines.push(`${color(f)} ${escapeHtml(b.name)}`);
        lines.push(`<code>[${bar(f)}] ${pct(f)}</code>`);
        if (/5h/.test(b.window || '')) lines.push(`♻️ Reset dalam ${fmtReset(b.reset_time)}`);
        else lines.push(`♻️ Reset: ${new Date(b.reset_time).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} WIB`);
        lines.push('');
      }
    }
  } else {
    lines.push('⚠️ Gagal ambil kuota resmi dari CLI (coba lagi / cek /whoami).', '');
  }

  // 3. Estimasi pemakaian via bot + riwayat limit
  if (Object.keys(agg).length) {
    lines.push('📈 <b>Pemakaian via bot (estimasi token):</b>');
    for (const m of Object.keys(agg)) {
      const a = agg[m];
      lines.push(`• ${escapeHtml(m)} — ${a.r5} req / ${fmt(a.t5)} token (5 jam) • ${a.r7} req / ${fmt(a.t7)} token (7 hari)`);
    }
    lines.push('');
  }
  const ll = quotaState.lastLimit;
  lines.push(ll
    ? `⚠️ Limit terakhir terdeteksi: <b>${escapeHtml(ll.label)}</b> pada ${new Date(ll.ts).toLocaleString('id-ID')}`
    : '✅ Belum pernah kena limit sejak bot jalan.');

  await sendLong(ctx, lines.join('\n'));
});

async function quotaAlerts(ctx, model, threadId) {
  const now = Date.now();
  const a = quotaStats()[model];
  if (a && a.r5 >= QUOTA_REQ_THRESHOLD) {
    const key = 'high_' + model;
    if (!quotaState.notified[key] || now - quotaState.notified[key] > QUOTA_COOLDOWN) {
      quotaState.notified[key] = now; saveQuota();
      await ctx.telegram.sendMessage(ctx.chat.id,
        `⚠️ <b>Pemakaian ${model} tinggi:</b> ${a.r5} request dalam 5 jam terakhir (${(a.t5 || 0).toLocaleString('id-ID')} token). Hati-hati kena limit 5 jam!`,
        { message_thread_id: threadId }).catch(() => {});
    }
  }
}

// /whoami — cek akun login aktif
bot.command('whoami', async (ctx) => {
  const email = whoamiEmail();
  if (email) await ctx.reply(`👤 Login sebagai: <b>${email}</b>`, { parse_mode: 'HTML' });
  else await ctx.reply('🚪 Belum ada akun yang login. Gunakan /login.');
});

// /login — ganti akun via OAuth link
bot.command('login', async (ctx) => {
  if (loginState) { await ctx.reply('⏳ Masih ada proses login berjalan. Kirim /login cancel untuk membatalkan.'); return; }
  const threadId = ctx.message?.message_thread_id;
  const hadOld = fs.existsSync(TOKEN_FILE);
  try { fs.mkdirSync(path.dirname(TOKEN_BAK), { recursive: true }); } catch {}
  if (hadOld) { try { fs.copyFileSync(TOKEN_FILE, TOKEN_BAK); } catch {} }

  // jalankan agy interaktif di pseudo-terminal (butuh `script`), tanpa hapus TUI-nya
  const proc = spawn('script', ['-qfc', `stty cols 2000 rows 50 2>/dev/null; ${AGY}`, '/dev/null']);
  loginState = { proc, poll: null, timeout: null, chatId: ctx.chat.id, threadId, msgId: null, hadOld };
  const st = loginState;

  // tekan Enter untuk memilih akun pertama di welcome screen
  setTimeout(() => { try { proc.stdin.write('\r'); } catch {} }, 2500);

  const status = await ctx.telegram.sendMessage(ctx.chat.id,
    '🔑 Menyiapkan link login Google…', { message_thread_id: threadId });
  st.msgId = status.message_id;

  let url = null;
  const tries = setInterval(() => {
    try { url = extractLoginUrl(fs.readFileSync('/dev/null')); } catch {}
  }, 500);
  // kumpulkan stdout lalu ekstrak URL setelah 5 detik
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  setTimeout(() => {
    clearInterval(tries);
    url = extractLoginUrl(Buffer.from(out));
    if (!url) {
      loginCleanup(true);
      ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
        '❌ Gagal mengambil link login. Coba lagi nanti.');
      return;
    }
    ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      `🔑 Klik link ini lalu login dengan akun Google yang diinginkan:\n\n${url}\n\n⏳ Menunggu kamu selesai login… (maks 5 menit)\nKetik /login cancel untuk membatalkan.`,
      { disable_web_page_preview: true }).catch(() => {});
  }, 5000);

  // poll: apakah file token baru sudah muncul (login sukses)
  st.poll = setInterval(() => {
    if (!loginState) return;
    if (fs.existsSync(TOKEN_FILE)) {
      const email = whoamiEmail() || 'akun baru';
      loginCleanup(false);
      try { fs.unlinkSync(TOKEN_BAK); } catch {}
      ctx.telegram.editMessageText(st.chatId, st.msgId, undefined,
        `✅ Berhasil! Sekarang login sebagai: <b>${email}</b>\nPrompt berikutnya otomatis pakai akun ini.`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
  }, 2000);

  // timeout 5 menit → restore akun lama
  st.timeout = setTimeout(() => {
    if (!loginState) return;
    loginCleanup(true);
    ctx.telegram.editMessageText(st.chatId, st.msgId, undefined,
      '⌛ Waktu login habis. Akun lama tetap dipakai (tidak ada perubahan).').catch(() => {});
  }, 5 * 60 * 1000);
});

// /login cancel
bot.action('login_cancel', async (ctx) => {
  if (!loginState) { await ctx.answerCbQuery('Tidak ada proses login.'); return; }
  loginCleanup(true);
  try { await ctx.editMessageText('🚫 Login dibatalkan. Akun lama tetap dipakai.'); } catch {}
  await ctx.answerCbQuery('Dibatalkan');
});

// /logout — hapus token lokal
bot.command('logout', async (ctx) => {
  if (loginState) { await ctx.reply('⏳ Selesaikan/batalkan proses login dulu (/login cancel).'); return; }
  const email = whoamiEmail();
  if (!email) { await ctx.reply('🚪 Memang belum login.'); return; }
  try { fs.mkdirSync(path.dirname(TOKEN_BAK), { recursive: true }); fs.copyFileSync(TOKEN_FILE, TOKEN_BAK); } catch {}
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
  await ctx.reply(`🚪 Logout dari <b>${email}</b> berhasil.\nGunakan /login untuk masuk dengan akun lain.`, { parse_mode: 'HTML' });
});

// Chat biasa di topic -> prompt ke agy
// /whitelist — kelola user yang boleh pakai bot
bot.command('whitelist', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  const sub = (parts[1] || 'list').toLowerCase();
  const arg = parts[2];
  // cuma admin grup / admin whitelist yang boleh mengatur
  const uid = ctx.from?.id;
  let isAdmin = whitelist.admins.includes(uid);
  if (!isAdmin) {
    try { const m = await ctx.telegram.getChatMember(ctx.chat.id, uid); isAdmin = ['administrator', 'creator'].includes(m.status); } catch {}
  }
  if (sub === 'list') {
    const fmt = (arr) => arr.length ? arr.map(String).join(', ') : '(kosong — akses terbuka)';
    return ctx.reply(`🛡️ Whitelist:\n• Admins: ${fmt(whitelist.admins)}\n• Users: ${fmt(whitelist.users)}\n\nℹ️ Kalau keduanya kosong, semua orang boleh pakai.`);
  }
  if (!isAdmin) return ctx.reply('⛔ Cuma admin grup/admin whitelist yang bisa mengatur whitelist.');
  if (!['add', 'del'].includes(sub) || !arg) return ctx.reply('Pakai: /whitelist add <user_id> | /whitelist del <user_id> | /whitelist list');
  const id = parseInt(arg, 10);
  if (isNaN(id)) return ctx.reply('user_id harus angka (ambil dari @userinfobot).');
  if (sub === 'add') {
    if (!whitelist.users.includes(id)) whitelist.users.push(id);
    saveWhitelist();
    return ctx.reply(`✅ User ${id} ditambahkan ke whitelist.`);
  }
  whitelist.users = whitelist.users.filter((x) => x !== id);
  whitelist.admins = whitelist.admins.filter((x) => x !== id);
  saveWhitelist();
  return ctx.reply(`🗑️ User ${id} dihapus dari whitelist.`);
});

// /status — kondisi server & proses
const BOT_START = Date.now();
let agyVersionCache = null;
bot.command('status', async (ctx) => {
  const up = process.uptime();
  const d = Math.floor(up / 86400), h = Math.floor((up % 86400) / 3600), mnt = Math.floor((up % 3600) / 60);
  const mem = process.memoryUsage();
  const runningList = [];
  const queuedList = [];
  for (const slug of Object.keys(queues)) {
    if (queues[slug].length) queuedList.push(`• ${slug}: ${queues[slug].length} antre`);
  }
  if (!agyVersionCache) { try { const r = spawnSync(AGY, ['--version'], { encoding: 'utf8', timeout: 10000 }); agyVersionCache = (r.stdout || '').trim() || '?'; } catch { agyVersionCache = '?'; } }
  const sessions = (() => { try { return fs.readdirSync(path.join(BASE, 'sessions')).filter((f) => fs.statSync(path.join(BASE, 'sessions', f)).isDirectory()); } catch { return []; } })();
  const lines = [
    '🟢 <b>Status AGYBot</b>',
    `• Uptime: ${d ? d + ' hari ' : ''}${h} jam ${mnt} menit`,
    `• RAM: ${(mem.rss / 1024 / 1024).toFixed(0)} MB`,
    `• Proses agy jalan: ${running}/${MAX_PARALLEL}`, runningList.length ? runningList.join('\n') : null,
    `• Antrean: ${Object.values(queues).reduce((a, q) => a + q.length, 0)}`, queuedList.length ? queuedList.join('\n') : null,
    `• Sesi tersimpan: ${sessions.length}`, sessions.length ? `  (${sessions.slice(0, 8).join(', ')}${sessions.length > 8 ? ', …' : ''})` : null,
    `• Versi agy: ${agyVersionCache}`,
    `• Login: ${whoamiEmail() || 'belum login'}`,
    `• Whitelist: ${whitelist.users.length} user, ${whitelist.admins.length} admin`,
  ].filter((x) => x !== null);
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

bot.on('text', async (ctx) => {
  const msg = ctx.message;
  console.log(`[msg] chat=${ctx.chat.id} thread=${msg.message_thread_id} text=${(msg.text || '').slice(0, 40)}`);
  if (msg.text.startsWith('/')) return next(); // lanjut ke handler command
  const isTopic = ctx.chat.is_forum && msg.message_thread_id && msg.message_thread_id !== msg.message_id;
  let title = isTopic ? (await topicTitle(ctx, msg.message_thread_id)) : (ctx.chat.title || 'default');
  if (!title) title = `Topic ${msg.message_thread_id}`; // fallback: tetap proses, jangan diam
  const slug = slugify(title);
  const dir = topicDir(slug);
  const st = readState(slug);
  const isBusy = (queues[slug]?.length || 0) > 0 || running >= MAX_PARALLEL;
  const queuePos = (queues[slug]?.length || 0);
  const started = Date.now();
  const before = snapshotFiles([dir, brainDirOf(st.conversation_id)]); // patokan utk deteksi file baru
  const thinking = await ctx.telegram.sendMessage(ctx.chat.id,
    isBusy ? `⏳ Masuk antrean (posisi ${queuePos})…` : '⏳ Sedang diproses…',
    { message_thread_id: msg.message_thread_id });

  // fallback: topic tanpa model eksplisit → pakai Gemini (hindari default GPT/Claude TUI yang makan pool Claude&GPT)
  if (!st.model) { st.model = 'gemini-3.8-flash-high'; writeState(slug, st); }
  const res = await runQueued(slug, () => agyPrompt(dir, msg.text, st.model, st.conversation_id));
  const rawOut = res.raw_output || res.response || '';
  const dur = Math.round((Date.now() - started) / 1000);
  const durTxt = dur >= 60 ? ` (kelar dalam ${Math.floor(dur / 60)}m ${dur % 60}s)` : '';
  if (res.conversation_id) { st.conversation_id = res.conversation_id; writeState(slug, st); }
  if (res.usage) {
    st.last_usage = res.usage; st.last_model = st.model || 'default'; st.last_ts = Date.now();
    usageLog[slug] = usageLog[slug] || [];
    usageLog[slug].push({ ts: Date.now(), model: st.model || 'default', in: res.usage.input_tokens || 0, out: res.usage.output_tokens || 0, total: res.usage.total_tokens || 0 });
    if (usageLog[slug].length > 200) usageLog[slug] = usageLog[slug].slice(-200);
    saveUsage();
  }

  // 🚨 alert kalau CLI terdeteksi kena limit (5 jam / mingguan)
  if (res.limitDetected) {
    const L = res.limitDetected;
    const resetIn = extractResetIn(rawOut);
    quotaState.lastLimit = { window: L.window, label: L.label, ts: Date.now(), model: st.model || 'default' };
    saveQuota();
    const saran = L.window === '5h' ? 'tunggu ±5 jam atau ' : L.window === 'week' ? 'tunggu reset mingguan atau ' : '';
    await ctx.telegram.sendMessage(ctx.chat.id,
      `🚨 <b>Limit terdeteksi (${L.label})</b> — model: ${st.model || 'default'}\n${resetIn ? `♻️ Reset otomatis dalam: <b>${resetIn}</b>\n` : ''}💡 Saran: ${saran}/login ke akun lain.`,
      { message_thread_id: msg.message_thread_id }).catch(() => {});
  }
  quotaAlerts(ctx, st.model || 'default', msg.message_thread_id).catch(() => {});

  // 📎 kirim file baru yang dibuat agy (gambar/dokumen/dll) langsung ke topic
  try {
    const after = snapshotFiles([dir, brainDirOf(res.conversation_id || st.conversation_id)]);
    const nFiles = await deliverNewFiles(ctx, msg.message_thread_id, before, after);
    if (nFiles) console.log(`[file] ${nFiles} file hasil dikirim ke topic ${slug}`);
  } catch (e) { console.log('[file] err:', e.message); }

  const html = res.status === 'SUCCESS' ? mdToTelegramHtml(res.response) : `<b>❌ Error</b>\n${mdToTelegramHtml(res.response)}`;
  try { await ctx.telegram.deleteMessage(ctx.chat.id, thinking.message_id); } catch {}
  await sendLong(ctx, dur >= 45 ? `✅ <b>Selesai${durTxt}</b>\n\n${html}` : html);
});

// (blok /usage sudah dipindah ke atas sebelum bot.on('text'))

// Upload file/zip/foto/dokumen -> project/
bot.on(['document', 'photo', 'video', 'audio'], async (ctx) => {
  const msg = ctx.message;
  const isTopic = ctx.chat.is_forum && msg.message_thread_id && msg.message_thread_id !== msg.message_id;
  let title = isTopic ? (await topicTitle(ctx, msg.message_thread_id)) : (ctx.chat.title || 'default');
  const slug = slugify(title || 'default');
  const dir = topicDir(slug);
  const doc = msg.document || msg.photo?.slice(-1)[0] || msg.video || msg.audio;

  const fname = msg.document?.file_name || (msg.photo ? `foto_${msg.message_id}.jpg` : (msg.video?.file_name || `video_${msg.message_id}.mp4`));
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const dest = path.join(dir, 'project', fname);
  const status = await ctx.telegram.sendMessage(ctx.chat.id, `⬇️ Mengunduh ${fname}…`, { message_thread_id: msg.message_thread_id });

  await new Promise((res, rej) => {
    execFile('curl', ['-sL', link.href, '-o', dest], (e) => e ? rej(e) : res());
  });
  try { await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id); } catch {}
  await ctx.telegram.sendMessage(ctx.chat.id, `📥 ${fname} tersimpan di sessions/${slug}/project/`, { message_thread_id: msg.message_thread_id });
});

// error handling
bot.catch((err, ctx) => { console.error('Bot error:', err.message || err); });

bot.launch({ allowedUpdates: ['message', 'callback_query', 'forum_topic_created'] });
console.log('✅ AGYBot berjalan…');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
