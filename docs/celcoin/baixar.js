// Baixa e converte os docs da Celcoin (Polp) pra texto legível.
// Rodar: node docs/celcoin/baixar.js   (atualiza a cópia local)
const fs = require('fs');
const path = require('path');
const urls = fs.readFileSync(path.join(__dirname, '_URLS.txt'), 'utf8')
  .split('\n').map((s) => s.trim()).filter(Boolean);

const texto = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(tr|div|p|li|h[1-6]|table|section)>/gi, '\n')
  .replace(/<\/t[dh]>/gi, '\t')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim())
  .filter((l, i, a) => l && !(i && a[i - 1] === l)).join('\n');

(async () => {
  let ok = 0;
  for (const url of urls) {
    const slug = url.replace('https://polp.com.br/docs/celcoin', '').replace(/^\//, '') || 'index';
    const arq = path.join(__dirname, slug.replace(/\//g, '__') + '.txt');
    try {
      const r = await fetch(url);
      const html = await r.text();
      const t = texto(html);
      // Corta a navegação lateral, que se repete em toda página.
      const i = t.indexOf('Postman Collection');
      fs.writeFileSync(arq, `# ${url}\n# baixado em ${new Date().toISOString().slice(0, 10)}\n\n`
        + (i >= 0 ? t.slice(i + 20) : t));
      ok++;
    } catch (e) { console.log('FALHOU', slug, e.message); }
  }
  console.log(`${ok}/${urls.length} docs salvos em docs/celcoin/`);
})();
