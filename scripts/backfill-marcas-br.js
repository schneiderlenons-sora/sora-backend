// =============================================================================
// Recategoriza o histórico que as regras novas de marca passaram a acertar.
//
// O sync NUNCA reescreve linha existente (de propósito: senão apagaria a
// categoria corrigida à mão). Então, sem este script, as regras novas só valem
// pro que entrar daqui pra frente — e o cliente continua vendo o gráfico
// errado que ele reclamou.
//
// MEDIDO antes de escrever (base inteira, ago/2026) — o delta entre o
// categorizador ANTIGO e o NOVO é de exatamente 57 linhas:
//     14x  Outros -> Alimentação      ("Superfoods Alimentaca", "RJPRODUTOSALIMENT")
//     10x  Lazer  -> Cinema           ("CINEMARK GRANJA VIANA", "Cinema")
//     10x  Outros -> Academia         ("Dellas Fitness 1/3", "Sportfit")
//      9x  Outros -> Uber             ("Me Leva Bq*Meleva")
//      7x  Outros -> Ônibus           ("Bus Servicos*Clickbus", "BUS SERVICOS*CLIC")
//      6x  Outros -> Higiene Pessoal  ("Vindi *Bodylaserbarba")
//      1x  Lazer  -> Alimentação      ("CABUM SHOW ALIMENTOS")
//
// ⚠️ SÓ MEXE NO QUE AS REGRAS NOVAS ALCANÇAM. O alvo é a interseção de duas
// condições: a descrição casa uma keyword NOVA **e** o categorizador canônico
// concorda com o destino. A segunda condição é o que respeita a ORDEM das
// regras — é ela que impede o radical 'aliment' de arrastar
// "Transferência enviada|AMM X COMERCIO DE ALIMENTOS" (que continua
// Transferências) e "Ifd*Superfoods Aliment" (que continua iFood).
//
// ⚠️ NÃO É UMA RECATEGORIZAÇÃO GERAL. Rodar o categorizador em cima de tudo
// discordaria de 6.388 linhas — porque a maioria foi categorizada pela IA, pelo
// banco ou À MÃO pelo usuário. Reescrever essas seria apagar correção humana.
//
// ⚠️ NÃO TOCA LINHA COM `transferencia = true`: ali a categoria participa do
// cálculo da fatura (valorFatura.js) e quem manda é a direção, não o texto.
//
// ⚠️ SCRIPT E NÃO MIGRATION SQL, pelo mesmo motivo do
// backfill-movimento-investimento.js: reescrever a regra em SQL criaria uma
// segunda verdade. Aqui a função canônica é IMPORTADA.
//
// Uso:
//   node scripts/backfill-marcas-br.js            (simulação)
//   node scripts/backfill-marcas-br.js --aplicar  (grava)
// =============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { categorizar } = require('../src/services/categorizar');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const APLICAR = process.argv.includes('--aplicar');

const norm = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// As keywords que ENTRARAM agora. Nada fora desta lista é considerado — é o
// que mantém o raio do script igual ao raio da mudança.
const NOVAS = [
  { cat: 'Uber',            re: /meleva|me leva/ },
  { cat: 'Ônibus',          re: /clickbus|bus servicos|buser|\bonibus\b|passagem rodoviaria|\bbrt\b/ },
  { cat: 'Cinema',          re: /cinema|cinemark|kinoplex|cinepolis|uci cinemas|velox tick|veloxticket|velox ingresso|veloxingresso/ },
  { cat: 'Higiene Pessoal', re: /body laser|bodylaser/ },
  { cat: 'Alimentação',     re: /aliment/ },
  // ⚠️ SEM 'fitness' e SEM 'body shape'. A 1ª rodada os tinha, e moveu 3 linhas
  // de "Dellas Fitness" (uma LOJA) pra Academia — desfeito à mão depois que o
  // usuário apontou. Palavra genérica no nome não diz o ramo do negócio.
  { cat: 'Academia',        re: /contorno do corpo|sportfit|sport fit|panobianco|justfit|cia athletica|pratique fitness|skyfit|sky fit|ironberg|iron berg|formula academia/ },
];

// ⚠️ SÓ SOBE DE UMA CATEGORIA GENÉRICA. Esta lista é a trava mais importante do
// script — ela nasceu do dry run, que mostrou 4 estragos que eu ia causar:
//
//   · "Venda bunge alimentos" R$ 19.500 estava em `💼 Trabalho` — é RECEITA de
//     venda pra Bunge Alimentos, não despesa de comida.
//   · "Cartão Alimentação" R$ 900 estava em `Receita recorrente` — é benefício
//     RECEBIDO.
//   · "Alimentação" R$ 762 estava em `🏠 Casa Ap`, categoria criada À MÃO.
//   · linhas em `Restaurante`, `Supermercado` e `Lanches` iriam pro genérico
//     `Alimentação` — REBAIXANDO uma categoria mais específica.
//
// A regra que sobrou: só recategoriza o que está parado num balde genérico
// (ou no pai da categoria de destino). Categoria específica, categoria com nome
// próprio e categoria de receita ficam intocadas — se alguém já decidiu melhor
// que a keyword, a decisão fica de pé.
const ORIGENS_GENERICAS = [
  'outros', 'outro', 'outras', 'sem categoria', 'importado', 'nao categorizado',
  // Pais das subcategorias que as regras novas passaram a preencher:
  'lazer',      // -> Cinema
  'transporte', // -> Ônibus
  'consultas',  // -> Higiene Pessoal (é onde a Body Laser estava caindo)
];

// Tira emoji/acento pra comparar "📦 Importado" com "importado".
const chave = (s) => (s || '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

async function tudo(tabela, colunas) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(tabela).select(colunas).range(from, from + 999);
    if (error) throw new Error(`${tabela}: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

(async () => {
  const tx = await tudo('transacoes', 'id, observacao, categoria, tipo, valor, transferencia, grupo_id');
  console.log(`transações lidas: ${tx.length}\n`);

  const alvo = [];
  for (const t of tx) {
    if (t.transferencia === true) continue;             // direção manda, não texto
    // Todas as categorias que as regras novas produzem são de DESPESA. Sem esta
    // linha, "Venda bunge alimentos" (R$ 19.500 de receita) virava despesa de
    // comida — o dry run pegou.
    if (t.tipo !== 'Gasto') continue;
    if (!ORIGENS_GENERICAS.includes(chave(t.categoria))) continue;

    const s = norm(t.observacao);
    if (!s) continue;
    const regra = NOVAS.find((r) => r.re.test(s));
    if (!regra) continue;

    // O categorizador canônico é o juiz: se a ORDEM das regras mandar a linha
    // pra outro lugar (iFood, Transferências, Dieta, Padaria…), ele diz isso
    // aqui e a linha fica de fora.
    const decidido = categorizar({ descricao: t.observacao || '', ehGasto: t.tipo === 'Gasto' });
    if (decidido !== regra.cat) continue;
    if (t.categoria === decidido) continue;             // já está certo

    alvo.push({ ...t, novo: decidido });
  }

  const pares = {};
  for (const a of alvo) {
    const k = `${a.categoria}  ->  ${a.novo}`;
    pares[k] = pares[k] || { n: 0, ex: new Set(), v: 0 };
    pares[k].n++;
    pares[k].v += Number(a.valor || 0);
    pares[k].ex.add(String(a.observacao || '').slice(0, 34));
  }

  console.log('═══ RECATEGORIZAR ═══');
  for (const [k, v] of Object.entries(pares).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(v.n).padStart(3)}x  R$ ${v.v.toFixed(2).padStart(10)}  ${k}`);
    console.log(`        ex: ${[...v.ex].slice(0, 3).join(' | ')}`);
  }
  console.log(`\n  total: ${alvo.length} linha(s) em ${new Set(alvo.map((a) => a.grupo_id)).size} grupo(s)`);

  if (!APLICAR) {
    console.log('\nSIMULAÇÃO — nada foi gravado. Rode com --aplicar para valer.');
    return;
  }

  let ok = 0;
  for (const a of alvo) {
    const { error } = await sb.from('transacoes').update({ categoria: a.novo }).eq('id', a.id);
    if (error) console.error('  ❌', a.id, error.message);
    else ok++;
  }
  console.log(`\n✅ ${ok}/${alvo.length} linha(s) recategorizadas.`);
})().catch((e) => { console.error('erro:', e.message); process.exit(1); });
