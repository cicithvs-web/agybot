# 🤖 AGY TeleBot — Panduan Instalasi di Server Baru

Bot Telegram sebagai **jembatan ke Google Antigravity (CLI `agy`)**.
Satu grup Telegram + Topics = banyak sesi AI, tiap topic punya folder kerja sendiri.

---

## 📋 Prasyarat

| Komponen | Fungsi | Catatan |
|---|---|---|
| Linux x64 (Ubuntu/Debian) | OS server | Sudah dites di Ubuntu |
| Node.js ≥ 18 | Menjalankan bot | `apt install -y nodejs npm` |
| CLI Antigravity (`agy`) | Otak AI | Binary ±265 MB, path default `/root/.local/bin/agy` |
| `script` (util-linux) | Menangkap URL login OAuth | `apt install -y util-linux` |
| curl | Debug/verifikasi | `apt install -y curl` |

**Token yang harus disiapkan sebelum mulai:**
1. **BOT_TOKEN** — dari [@BotFather](https://t.me/BotFather) (perintah `/newbot` atau pakai bot lama)
2. **Akun Google** — dengan langganan Google AI Pro untuk akses model

---

## 🔧 Langkah Instalasi

### 1. Install dependensi sistem

```bash
apt update
apt install -y nodejs npm util-linux curl
node -v   # pastikan ≥ v18
```

### 2. Install CLI Antigravity (`agy`)

**Opsi A — pindah dari server lama (paling cepat):**
```bash
scp /root/.local/bin/agy server-baru:/root/.local/bin/agy
chmod +x /root/.local/bin/agy
```

**Opsi B — install fresh:**
Download installer dari Google Antigravity, lalu pastikan binary-nya ada di:
```
/root/.local/bin/agy
```

Cek versi:
```bash
/root/.local/bin/agy --version
```

### 3. Login Antigravity sekali secara manual

> Profil login disimpan di **home user yang menjalankan bot**. Kalau bot jalan sebagai root, login sebagai root. Kalau sebagai user lain, jalankan langkah ini dengan user yang sama.

```bash
/root/.local/bin/agy
```

- Akan muncul **URL OAuth** → buka di browser → login akun Google → approve
- Token tersimpan otomatis di:
  ```
  /root/.gemini/antigravity-cli/antigravity-oauth-token
  ```
- Keluar dari CLI (`exit`) setelah login sukses.

> ⚠️ Langkah ini cuma **sekali** di awal. Ganti akun selanjutnya bisa lewat bot (`/login`).

### 4. Siapkan folder bot

```bash
mkdir -p /root/agybot
cd /root/agybot
# copy bot.js, mdconv.js, package.json dari ZIP yang diberikan
unzip agybot-source.zip
```

### 5. Isi token bot

```bash
echo "ISI_BOT_TOKEN_DARI_BOTFATHER" > token.txt
chmod 600 token.txt
```

### 6. Install dependensi Node

```bash
cd /root/agybot
npm install
```
> Hanya butuh `telegraf`. Sisanya modul bawaan Node.

### 7. Sesuaikan path (jika perlu)

Buka `bot.js`, cek dua konstanta di bagian atas:

| Konstanta | Default | Kapan diubah |
|---|---|---|
| `AGY` | `/root/.local/bin/agy` | Kalau binary agy ada di path lain |
| `TOKEN_FILE` | `/root/.gemini/antigravity-cli/antigravity-oauth-token` | Kalau jalan sebagai user non-root → ganti `/root` ke home user tersebut |

### 8. Jalankan bot

```bash
cd /root/agybot
nohup node bot.js > bot.log 2>&1 &
```

Verifikasi:
```bash
node --check bot.js        # cek sintaks
tail -f bot.log            # lihat log live
```

Kirim pesan di grup Telegram → bot harusnya membalas. ✅

---

## 🤖 Setup Grup Telegram

1. Invite **@AGY_teleBot** (atau bot-mu) ke grup
2. Jadikan **Admin** dengan izin **Manage Topics**
3. Aktifkan Topics: *Group Settings → Topics → ON*
4. Buat topic baru → tiap topic = 1 sesi AI terpisah

---

## ⌨️ Perintah Bot

| Perintah | Fungsi |
|---|---|
| `/model` | Pilih model (Gemini / Claude / GPT) |
| `/usage` | Lihat token input/output per sesi + agregat |
| `/files` | Lihat daftar file di folder `project/` sesi |
| `/reset` | Mulai percakapan baru di topic (hapus conversation_id) |
| `/whoami` | Cek akun Antigravity yang sedang login |
| `/login` | Ganti akun → bot kirim link OAuth → approve di browser |
| `/login cancel` | Batalkan proses login (akun lama tetap aman) |
| `/logout` | Keluar dari akun (hapus token lokal) |

**Upload file/foto:** kirim langsung di topic → tersimpan ke `sessions/<topic>/project/` → agent otomatis bisa mengaksesnya.

---

## 🗂️ Struktur Data

```
/root/agybot/
├── bot.js              # kode utama bot
├── mdconv.js           # konversi Markdown → HTML Telegram
├── package.json
├── token.txt           # BOT_TOKEN (jangan disebar!)
├── bot.log             # log berjalan
├── map.json            # mapping topic Telegram ↔ folder sesi
└── sessions/
    └── <nama-topic>/
        ├── AGENT.md    # instruksi permanen + catatan agent
        ├── state.json  # model aktif + conversation_id
        └── project/    # file/foto yang di-upload user
```

**Profil login Antigravity** (di luar folder bot):
```
/root/.gemini/antigravity-cli/antigravity-oauth-token
```

---

## 🔄 Menjalankan Bot Saat Boot (opsional)

Buat service systemd agar bot auto-restart:

```bash
cat > /etc/systemd/system/agybot.service << 'EOF'
[Unit]
Description=AGY Telegram Bot
After=network.target

[Service]
WorkingDirectory=/root/agybot
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now agybot
systemctl status agybot   # pastikan active (running)
```

Lihat log: `journalctl -u agybot -f`

---

## 🩺 Troubleshooting

| Masalah | Solusi |
|---|---|
| Bot tidak membalas | Cek `tail -f bot.log`; pastikan bot admin grup & Topics ON |
| `ENOENT ... state.json` | Sudah difix (auto mkdir); pastikan pakai bot.js versi ini |
| `/login` link tidak muncul | Pastikan `util-linux` terpasang (perintah `script` dipakai untuk menangkap URL OAuth) |
| Error 401/403 dari agy | Token kedaluwarsa → jalankan `/login` lagi dari bot, atau login manual (`/root/.local/bin/agy`) |
| Ganti akun tidak berefek | Pastikan tidak ada prompt yang sedang diproses saat re-login |
| Prompt lama tidak "diingat" | Cek `conversation_id` di `state.json` sesi; `/reset` kalau mau mulai fresh |

---

## 🔐 Catatan Keamanan

- `token.txt` dan folder `~/.gemini/` berisi **kredensial** — jangan di-commit atau dibagikan
- Backup berkala: `map.json` + `sessions/` (riwayat & file) + token OAuth
- Bot **stateless**: pindah server cukup bawa 3 file kode + token; data sesi opsional
