// =============================================================================
// EVAL — caracteres invisíveis na mensagem do WhatsApp (services/textoEntrada.js).
// Caso real (nov/2026): a marca de rastreio da UTMify nos links do painel fazia
// "gastei 50 no mercado" chegar como "g\u206C\u206D\u206C\u206D\u206C\u206D\u206C\u206Dastei 50 no mercado".
// Rodar:  node evals/textoEntrada.eval.js
// =============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-eval-sem-rede';
const fs = require('fs');
const path = require('path');
const { limparInvisiveis } = require('../src/services/textoEntrada');
const { interpretarRapido } = require('../src/handlers/interpretador');

const falhas = [];
let total = 0;
const eq = (a, b, m) => { total++; if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m}\n      esperado ${JSON.stringify(b)}\n      veio     ${JSON.stringify(a)}`); };

const MARCA = '\u206C\u206D\u206C\u206D\u206C\u206D\u206C\u206D';
const sujo = `g${MARCA}astei 50 no mercado`;
eq(interpretarRapido(sujo), null, '⚠️ a prova do defeito: com a marca, o leitor local não entende');
eq(limparInvisiveis(sujo), 'gastei 50 no mercado', 'a marca de rastreio sai');
eq(interpretarRapido(limparInvisiveis(sujo)).acao, 'salvar', 'limpa, a frase volta a ser um lançamento');
eq(limparInvisiveis('o\u200Bi\u200C \u200E\u200FSora\u2060\u2066\u2069\uFEFF'), 'oi Sora', 'espaço de largura zero, marcas de direção, juntor de palavra, isoladores e BOM saem');
eq(limparInvisiveis('Família 👨\u200D👩\u200D👧 e 👍🏽'), 'Família 👨\u200D👩\u200D👧 e 👍🏽', '⚠️ o ZWJ fica: emoji composto não se desmonta');
eq(limparInvisiveis('Café às 8h, R$ 12,50 — ok!'), 'Café às 8h, R$ 12,50 — ok!', 'texto normal (acento, cifrão, travessão) não muda');
eq([limparInvisiveis(null), limparInvisiveis(undefined), limparInvisiveis(42)], [null, undefined, 42], 'o que não é texto passa igual');

// A limpeza roda na ENTRADA, antes de tudo (busca de usuário, leitor, IA).
const fonte = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8').replace(/\r\n/g, '\n');
const ini = fonte.indexOf('async function processarMensagem(');
const corpo = fonte.slice(ini, ini + 600);
eq(/mensagem = limparInvisiveis\(mensagem\);/.test(corpo) && corpo.indexOf('limparInvisiveis(mensagem)') < corpo.indexOf('if (!mensagem || !phone) return;'),
  true, 'processarMensagem limpa a mensagem logo na entrada');
eq(/legendaImg = limparInvisiveis\(legendaImg\);/.test(corpo), true, 'e a legenda da foto também');

console.log(`${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
if (falhas.length) { for (const f of falhas) console.log('  ✘ ' + f); process.exit(1); }
