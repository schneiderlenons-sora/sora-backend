// =============================================================================
// Renomeia os cartões de crédito JÁ IMPORTADOS pelo Open Finance para o padrão
// "<Banco> Crédito" — o mesmo que o sync passou a usar em cartão novo.
//
// POR QUE UM SCRIPT E NÃO O SYNC: `upsertWallet` NUNCA reescreve o nome de uma
// carteira que já existe, de propósito — é o que protege o nome que o usuário
// escolheu à mão. Mudar isso renomearia à revelia toda vez que o sync roda.
//
// ⚠️ RENOMEAR TEM DE CASCATEAR. Transação não aponta pra carteira por id: ela
// guarda `carteira_nome` (TEXTO). Renomear só a wallet transforma o histórico
// inteiro em conta-fantasma. As duas tabelas que ligam por nome são
// `transacoes.carteira_nome` e `recorrencias.carteira`.
//
// ⚠️ SECO POR PADRÃO. Sem `--aplicar` ele só MOSTRA o que faria.
//
// Rodar:
//   node scripts/renomear-cartoes-of.js                    # simulação
//   node scripts/renomear-cartoes-of.js --email=x@y.com    # um cliente só
//   node scripts/renomear-cartoes-of.js --aplicar          # vale valendo
// =============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { nomeDoCartao } = require('../src/services/polpCelcoinSync');

const sb = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);

const APLICAR = process.argv.includes('--aplicar');
const EMAIL = (process.argv.find((a) => a.startsWith('--email=')) || '').split('=')[1] || null;

// `%` e `_` são curingas no ilike — sem escapar, "Banco_1" arrastaria as
// transações de "Banco11". Mesma proteção do PUT /api/wallets/:id.
const escapar = (s) => String(s).replace(/([%_\\])/g, '\\$1');

(async () => {
  console.log(APLICAR ? '⚠️  MODO APLICAR — vai escrever no banco\n' : '🔎 SIMULAÇÃO (use --aplicar pra valer)\n');

  let grupos = null;
  if (EMAIL) {
    const { data: u } = await sb.from('users').select('grupo_ativo').eq('email', EMAIL).maybeSingle();
    if (!u) { console.error('usuário não encontrado:', EMAIL); process.exit(1); }
    grupos = [u.grupo_ativo];
  }

  // A instituição vem do CONSENTIMENTO, não do cartão — é a mesma fonte que o
  // sync usa pra nomear cartão novo. Dois caminhos, nessa ordem:
  //   1. `wallets.of_consent_id` (migration 133) → atribuição EXATA, funciona
  //      mesmo em grupo com vários bancos conectados;
  //   2. o grupo ter UMA conexão só → dá pra deduzir sem ambiguidade.
  const { data: conexoes } = await sb.from('of_conexoes').select('grupo_id, external_id, instituicao');
  const instPorGrupo = {};
  const instPorConsent = {};
  for (const c of conexoes || []) {
    if (!c.instituicao) continue;
    instPorConsent[c.external_id] = c.instituicao;
    (instPorGrupo[c.grupo_id] = instPorGrupo[c.grupo_id] || new Set()).add(c.instituicao);
  }

  // ⚠️ TOLERANTE À MIGRATION 133. Pedir uma coluna que não existe faz o
  // Supabase falhar o select INTEIRO — o script morreria antes de mostrar o que
  // já dá pra fazer. Sem a coluna, sobra a dedução por grupo de banco único.
  const ler = async (comConsent) => {
    let q = sb.from('wallets')
      .select(`id, nome, grupo_id, of_conta_id, ultimos4${comConsent ? ', of_consent_id' : ''}`)
      .eq('tipo', 'Crédito').not('of_conta_id', 'is', null);
    if (grupos) q = q.in('grupo_id', grupos);
    return q;
  };
  let { data: cartoes, error } = await ler(true);
  if (error) {
    console.log('ℹ️  migration 133 ainda não rodou — atribuindo só por grupo de banco único\n');
    ({ data: cartoes, error } = await ler(false));
  }
  if (error) { console.error('erro ao ler wallets:', error.message); process.exit(1); }

  let renomeados = 0, pulados = 0, txTotal = 0;

  for (const c of cartoes || []) {
    // 1º: o consentimento gravado na própria carteira (migration 133) — exato.
    let instituicao = c.of_consent_id ? instPorConsent[c.of_consent_id] : null;

    // 2º: grupo com UMA conexão só. Com duas ou mais é AMBÍGUO — não dá pra
    // saber de qual banco é ESTE cartão, e chutar daria "Itaú Crédito" num
    // Nubank. Pula e reporta, pro próximo sync resolver (ele grava o consent).
    if (!instituicao) {
      const insts = [...(instPorGrupo[c.grupo_id] || [])];
      if (insts.length !== 1) {
        console.log(`  ⏭  "${c.nome}" — ${insts.length === 0 ? 'sem conexão' : `${insts.length} bancos no grupo, e a carteira ainda não sabe de qual (roda o sync)`}`);
        pulados++; continue;
      }
      instituicao = insts[0];
    }

    // ⚠️ Passa o NOME DO PRODUTO junto: a regra preserva o que distingue
    // ("Personnalité", "Uniclass") e só descarta o que é ruído ("gold", "VISA
    // INFINITE"). Sem isso, três cartões Itaú do mesmo dono virariam o mesmo
    // "Itaú Crédito" — indistinguíveis pra ele E na lista de transações, que
    // casa por NOME.
    const novo = nomeDoCartao({ identification: { name: c.nome } }, instituicao);
    if (novo === c.nome) { pulados++; continue; }

    // Nome já ocupado no grupo? Desempata com os últimos 4 — é o mesmo critério
    // do sync. Sem os dígitos, pula: fundir duas carteiras seria pior.
    const { data: ocupado } = await sb.from('wallets')
      .select('id').eq('grupo_id', c.grupo_id).ilike('nome', escapar(novo)).maybeSingle();
    let alvo = novo;
    if (ocupado && ocupado.id !== c.id) {
      if (!c.ultimos4) {
        console.log(`  ⏭  "${c.nome}" → "${novo}" JÁ EXISTE e o cartão não tem os últimos 4 dígitos`);
        pulados++; continue;
      }
      alvo = `${novo} ${c.ultimos4}`.slice(0, 60);
    }

    const { count: nTx } = await sb.from('transacoes')
      .select('id', { count: 'exact', head: true })
      .eq('grupo_id', c.grupo_id).ilike('carteira_nome', escapar(c.nome));

    console.log(`  ✏️  "${c.nome}" → "${alvo}"   (${nTx || 0} transações)`);
    txTotal += nTx || 0;
    renomeados++;

    if (!APLICAR) continue;

    // ORDEM IMPORTA: a wallet primeiro (é onde o unique pode estourar, e falhar
    // ali não deixa rastro). Só depois o histórico.
    const { error: eW } = await sb.from('wallets').update({ nome: alvo }).eq('id', c.id);
    if (eW) { console.log(`      ❌ wallet: ${eW.message} — nada alterado`); renomeados--; continue; }

    const { error: eTx } = await sb.from('transacoes')
      .update({ carteira_nome: alvo })
      .eq('grupo_id', c.grupo_id).ilike('carteira_nome', escapar(c.nome));
    if (eTx) {
      // Cascata falhou → DESFAZ o rename, pra não deixar histórico órfão.
      await sb.from('wallets').update({ nome: c.nome }).eq('id', c.id);
      console.log(`      ❌ transações: ${eTx.message} — rename DESFEITO`);
      renomeados--; continue;
    }

    // Recorrências também apontam por nome. Tolerante: falhar aqui não desfaz
    // o rename (o histórico, que é o caro, já foi).
    try {
      await sb.from('recorrencias').update({ carteira: alvo })
        .eq('grupo_id', c.grupo_id).ilike('carteira', escapar(c.nome));
    } catch { /* segue */ }
  }

  console.log(`\n${APLICAR ? 'RENOMEADOS' : 'seriam renomeados'}: ${renomeados}`
    + ` · pulados: ${pulados} · transações afetadas: ${txTotal}`);
  if (!APLICAR && renomeados) console.log('\nPra valer: node scripts/renomear-cartoes-of.js --aplicar');
})();
