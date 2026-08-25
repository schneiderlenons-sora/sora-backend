// =============================================================================
// EVAL da FILA DE TEMPLATES do `lembrete()` — o guarda contra ENVIO DUPLICADO.
//
// Fora da janela de 24h só existe template, então cada aviso tem uma fila de
// reserva: lista → modelo dedicado → reserva → lembretes_gerais. O perigo mora
// exatamente aí: se o laço tentar o próximo em QUALQUER falha, uma resposta
// perdida depois de a Meta já ter aceitado a mensagem vira 2, 3 ou 4 cópias no
// WhatsApp do cliente.
//
// A regra travada aqui: só passa pro próximo quando a falha PROVA que nada
// saiu — a família 132xxx (modelo inexistente/não aprovado/pausado/nº de
// parâmetros errado). Timeout, 5xx e rate limit PARAM a fila.
//
// Rodar:  npm run eval:lembrete-fila
// =============================================================================
process.env.WHATSAPP_PROVIDER = 'meta';
process.env.AGENTES_TEMPLATE = '1';
process.env.AGENTES_VOZ = '1';
process.env.NEXT_PUBLIC_APP_URL = 'https://www.forsora.com';
// O jobs puxa o resumoFinanceiro, que instancia o client da OpenAI no import.
// Chave de mentira só pra passar do construtor — nada aqui chama a API.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-eval-sem-uso';

const path = require('path');
const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };

// ── Stubs ───────────────────────────────────────────────────────────────────
// `node-cron` registraria 15 agendamentos ao importar o jobs; o supabase abriria
// conexão. Trocamos os dois ANTES do require pra carregar só o helper.
require.cache[require.resolve('node-cron')] = {
  id: 'node-cron', filename: 'node-cron', loaded: true,
  exports: { schedule: () => ({ stop() {} }) },
};
const dbPath = require.resolve('../src/db/supabase');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: new Proxy({}, { get: () => () => ({ select: () => ({ eq: () => ({ data: [] }) }) }) }),
};

// O envio é interceptado aqui: cada chamada vira uma linha em `enviados`, e o
// roteiro (`respostas`) decide o que a Meta "responde" em cada tentativa.
const waPath = require.resolve('../src/services/whatsapp');
let enviados = [];
let respostas = [];
require.cache[waPath] = {
  id: waPath, filename: waPath, loaded: true,
  exports: {
    enviarTexto: async (phone, txt) => { enviados.push({ tipo: 'texto', phone, txt }); },
    enviarTemplateDetalhado: async (phone, name) => {
      enviados.push({ tipo: 'template', phone, name });
      return respostas.shift() || { ok: true, code: null, falhaDeModelo: false };
    },
    enviarTemplate: async (...a) => true,
  },
};

const { lembrete } = require('../src/jobs/index.js');

const cenario = (roteiro) => { enviados = []; respostas = roteiro.slice(); };
const REJEITA = (code) => ({ ok: false, code, falhaDeModelo: code >= 132000 && code <= 132999 });
const AMBIGUA = (code) => ({ ok: false, code, falhaDeModelo: false });
const ACEITA  = { ok: true, code: null, falhaDeModelo: false };

// Um aviso com fila CHEIA: lista + dedicado + reserva + lembretes_gerais.
const avisoCompleto = {
  id: 'loki', aviso: 'briefing', seed: 'u1',
  lista: { assunto: 'Sua agenda de hoje', itens: ['📌 09:00 Dentista', '💳 Fatura'] },
  campos: null,
  tplReserva: { name: 'briefing_matinal', params: ['Ana', 'resumo'], opts: {} },
};

(async () => {
  // ── 1. Caminho feliz: UMA mensagem, e é a mais bonita ────────────────────
  console.log('── 1. sucesso no 1º modelo ──');
  cenario([ACEITA]);
  await lembrete('5511999999999', 'texto rico', 'core', avisoCompleto);
  ok(enviados.length === 1, `1 envio só (foram ${enviados.length})`);
  ok(enviados[0].name === 'agente_lista_2', `usou a lista de 2 itens (veio ${enviados[0].name})`);
  console.log('  ok');

  // ── 2. Modelo recusado (132001) → cai pro próximo, SEM duplicar ──────────
  // Duas TENTATIVAS, mas só uma mensagem chega: a 1ª comprovadamente não saiu.
  console.log('── 2. modelo não aprovado cai pro próximo ──');
  cenario([REJEITA(132001), ACEITA]);
  await lembrete('5511999999999', 'texto rico', 'core', avisoCompleto);
  ok(enviados.length === 2, `2 tentativas (foram ${enviados.length})`);
  ok(enviados[1].name === 'briefing_matinal', `2ª foi a reserva (veio ${enviados[1].name})`);
  console.log('  ok');

  // ── 3. ⚠️ O CASO QUE CAUSA DUPLICATA: falha AMBÍGUA para a fila ──────────
  // Timeout/5xx/rate limit acontecem DEPOIS de a Meta aceitar com frequência
  // suficiente pra importar. Diante da dúvida, para.
  console.log('── 3. falha ambígua PARA a fila ──');
  for (const [rotulo, r] of [['timeout/rede', AMBIGUA(null)], ['5xx', AMBIGUA(500)],
                             ['rate limit', AMBIGUA(429)], ['genérico', AMBIGUA(100)]]) {
    cenario([r, ACEITA, ACEITA, ACEITA]);
    await lembrete('5511999999999', 'texto rico', 'core', avisoCompleto);
    ok(enviados.length === 1, `${rotulo}: parou na 1ª (foram ${enviados.length} envios)`);
  }
  console.log('  ok');

  // ── 4. Fila inteira recusada = 3 tentativas, ZERO entregue ───────────────
  console.log('── 4. fila inteira recusada ──');
  cenario([REJEITA(132001), REJEITA(132000), REJEITA(132015)]);
  const r4 = await lembrete('5511999999999', 'texto rico', 'core', avisoCompleto);
  ok(r4 === false, 'devolve false quando ninguém entregou');
  ok(enviados.length === 3, `tentou os 3 da fila (foram ${enviados.length})`);
  ok(enviados[2].name === 'lembretes_gerais', `o último é sempre o genérico (veio ${enviados[2].name})`);
  console.log('  ok');

  // ── 5. Falha ambígua NO MEIO da fila também para ─────────────────────────
  console.log('── 5. ambígua no meio ──');
  cenario([REJEITA(132001), AMBIGUA(null), ACEITA]);
  await lembrete('5511999999999', 'texto rico', 'core', avisoCompleto);
  ok(enviados.length === 2, `parou na 2ª (foram ${enviados.length})`);
  ok(!enviados.some((e) => e.name === 'lembretes_gerais'), 'não chegou no genérico');
  console.log('  ok');

  // ── 6. Aviso SEM campos nem lista usa só o genérico ──────────────────────
  // É o caso do versículo do dia e da cópia pro parceiro: sem dados
  // estruturados não há o que preencher, e tentar seria envio perdido.
  console.log('── 6. aviso sem modelo dedicado ──');
  cenario([ACEITA]);
  await lembrete('5511999999999', 'texto rico', 'core', null);
  ok(enviados.length === 1 && enviados[0].name === 'lembretes_gerais',
    `só o genérico (veio ${JSON.stringify(enviados.map((e) => e.name))})`);
  console.log('  ok');

  // ── 7. Fora do trilho Meta: UM envio, nunca a fila ───────────────────────
  // No Z-API o `enviarTexto` não devolve confirmação; se o laço rodasse ali, o
  // "não entregou" seria sempre falso e a pessoa receberia 4 cópias.
  console.log('── 7. provider != meta manda uma vez só ──');
  process.env.WHATSAPP_PROVIDER = 'zapi';
  cenario([]);
  await lembrete('5511999999999', 'texto rico', 'core', avisoCompleto);
  ok(enviados.length === 1, `1 envio só fora do trilho Meta (foram ${enviados.length})`);
  ok(enviados[0].tipo === 'texto', `e foi texto livre (veio ${enviados[0].tipo})`);
  process.env.WHATSAPP_PROVIDER = 'meta';
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ fila de templates: nenhum caminho duplica envio');
})();
