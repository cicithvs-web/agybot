// Konversi Markdown (output AI) -> HTML untuk Telegram sendMessage (parse_mode=HTML)
// Urutan penting: escape dulu, lalu code blocks, inline code, bold/italic, heading, list.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Render array of rows jadi tabel kotak monospace rapi
function renderTable(rows, aligns) {
  const ncol = Math.max(...rows.map(r => r.length));
  const dlen = s => String(s || '').replace(/&[a-zA-Z#0-9]+;/g, '.').length; // panjang tampilan (entity HTML dihitung 1)
  const widths = [];
  for (let i = 0; i < ncol; i++) widths[i] = Math.max(3, ...rows.map(r => dlen(r[i])));
  const pad = (s, i) => {
    s = String(s || ''); const w = widths[i], d = dlen(s);
    if (aligns[i] === 'right') return ' '.repeat(Math.max(0, w - d)) + s;
    if (aligns[i] === 'center') { const t = Math.floor((w - d) / 2); return ' '.repeat(t) + s + ' '.repeat(Math.max(0, w - d - t)); }
    return s + ' '.repeat(Math.max(0, w - d));
  };
  const line = (l, m, r) => l + widths.map(w => '─'.repeat(w + 2)).join(m) + r;
  const row = r => '│ ' + Array.from({ length: ncol }, (_, i) => pad(r[i], i)).join(' │ ') + ' │';
  const out = [line('┌', '┬', '┐'), row(rows[0]), line('├', '┼', '┤')];
  for (let i = 1; i < rows.length; i++) out.push(row(rows[i]));
  out.push(line('└', '┴', '┘'));
  return '<pre>' + out.join('\n') + '</pre>';
}

function mdToTelegramHtml(md) {
  let text = escapeHtml(md || '');

  const blocks = [];
  // 1. Ambil fenced code block ``` ... ``` (termasuk bahasa)
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    code = code.replace(/\n$/, '');
    blocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  // 1b. Tabel markdown -> kotak <pre> rapi (Telegram tidak dukung <table>)
  text = text.replace(/(?:^\|.+\|[ \t]*$\n?)+/gm, (tbl) => {
    try {
      const lines = tbl.replace(/\n$/, '').split('\n');
      const clean = c => c.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/`/g, '');
      const rows = lines.map(l => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => clean(c.trim())));
      if (rows.length < 2) return tbl;
      // Baris ke-2 harus separator (---) agar dianggap tabel sah
      if (!rows[1].every(c => /^:?-{2,}:?$/.test(c) || c === '')) return tbl;
      const aligns = rows[1].map(c => (c.startsWith(':') && c.endsWith(':')) ? 'center' : c.endsWith(':') ? 'right' : 'left');
      const body = rows.slice(2).filter(r => r.some(c => c !== ''));
      const html = renderTable([rows[0], ...body], aligns);
      blocks.push(html);
      return '\u0000BLOCK' + (blocks.length - 1) + '\u0000\n';
    } catch (e) { return tbl; }
  });

  // 2. Inline code
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 3. Bold: **x** atau __x__
  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_]+)__/g, '<b>$1</b>');

  // 4. Italic: *x* (satu bintang) atau _x_
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');

  // 5. Strikethrough ~~x~~
  text = text.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  // 6. Link [teks](url)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

  // 7. Heading # -> bold baris penuh
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 8. Bullet list: - / * / • di awal baris -> •
  text = text.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  // 9. Blockquote > -> italic dengan garis
  text = text.replace(/^\s*&gt;\s?(.*)$/gm, '┃ $1');

  // 10. Bersihkan divider ---
  text = text.replace(/^---+$/gm, '──────────');

  // 11. Kembalikan code blocks
  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (m, i) => blocks[+i]);

  return text.trim();
}

// Pecah pesan panjang > 4000 char, hindari memotong di tengah tag HTML sederhana
function splitMessage(html, max = 4000) {
  if (html.length <= max) return [html];
  const parts = [];
  let rest = html;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    // Jangan potong di tengah tag <pre> terbuka — potong sebelum <pre jika ada
    const preIdx = rest.lastIndexOf('<pre', cut);
    if (preIdx > max * 0.5 && rest.slice(preIdx, cut).indexOf('</pre>') === -1) cut = preIdx;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

module.exports = { mdToTelegramHtml, splitMessage, escapeHtml };
