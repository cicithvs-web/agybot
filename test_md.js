const { mdToTelegramHtml, splitMessage } = require('./mdconv');
const md = `# Judul

**bold** dan *italic* dan \`kode\`

\`\`\`js
console.log('<h1>ok</h1>');
\`\`\`

- item 1
- item 2

> kutipan

[Lihat](https://x.com)`;
console.log(mdToTelegramHtml(md));
