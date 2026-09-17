const supabase = require('../db/supabase');
const { CATEGORIA_FATURA } = require('../services/categorizar');
const { enviarTexto, enviarBotaoLink } = require('../services/mensageiro');
const { termoCasaCompra, parcelaJaCobrada, agruparParcelas } = require('../services/consultaParcela');
const { criarPendente } = require('../services/pendentes');
const { oferecerDesconto } = require('../services/descontoConta');
// Cartão numa moeda diferente da base do grupo (migration 168) — ver
// services/moeda.cartaoForaDaBase. Em grupo em real nada disto muda o fluxo.
const {
  moedaBaseDoGrupo, taxasParaBase, camposTransacao, normalizarMoeda,
  cartaoForaDaBase, motivoCartaoForaDaBase, formatar: fmtMoeda,
} = require('../services/moeda');

const gerarId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// O ciclo da fatura mora em services/cicloFatura.js (fonte única compartilhada
// com o painel e os crons). Os helpers locais que existiam aqui clampavam o dia
// em 28 e estouravam o mês — 10 cartões da base fecham depois do dia 28.
const { competenciaAtual, competenciaVizinha, cicloPorCompetencia, hojeSP } = require('../services/cicloFatura');

// ── CARTÃO DA COMPRA PARCELADA ───────────────────────────────────────────────
//
// ⚠️ Importado de `transacoes.js` de propósito: é o resolvedor CANÔNICO de
// carteira do projeto (exato → sem ruído → palavra → fuzzy), o mesmo que o
// lançamento avulso usa. Ter uma segunda regra aqui foi exatamente o que
// produziu o relato de "cartão não encontrado" pra um cartão existente.
const { resolverCarteiraReal } = require('./transacoes');

const ehCredito = (w) => /cr[eé]dito/i.test(String(w && w.tipo || ''));

/** Só os cartões de crédito ATIVOS do grupo. */
async function listarCartoes(grupoId) {
  const { data } = await supabase.from('wallets')
    .select('id, nome, tipo, saldo, arquivada, moeda')
    .eq('grupo_id', grupoId)
    .order('created_at', { ascending: true });
  return (data || []).filter((w) => !w.arquivada && ehCredito(w));
}

/**
 * Acha o cartão que a pessoa citou.
 *
 * ⚠️ SEGUNDA TENTATIVA COM " crédito" COLADO, e ela existe por um motivo real:
 * quem tem a conta "Nubank" E o cartão "Nubank Crédito" costuma dizer só
 * "comprei no nubank em 3x". O resolvedor canônico devolveria a CONTA (é o
 * nome exato), e parcelamento não existe em conta de débito. Como aqui a
 * intenção já é inequívoca — parcelar —, procurar o cartão homônimo é o certo.
 */
async function acharCartao(grupoId, termo, cartoes) {
  const nome = await resolverCarteiraReal(grupoId, termo, cartoes);
  if (nome) return cartoes.find((c) => c.nome === nome) || null;

  const nome2 = await resolverCarteiraReal(grupoId, `${termo} crédito`, cartoes);
  if (nome2) return cartoes.find((c) => c.nome === nome2) || null;
  return null;
}

/** Pergunta em qual cartão lançar, guardando a compra pra próxima mensagem. */
async function pedirCartao(ctx, data, cartoes, motivo) {
  const { phone, user, grupoId } = ctx;
  const base = await moedaBaseDoGrupo(grupoId);
  const fmt = (v) => fmtMoeda(v, base);
  const lista = cartoes.map((c, i) => `${i + 1}. ${c.nome}`).join('\n');
  await criarPendente({
    userId: user?.id,
    tipoPergunta: 'escolher_cartao_parcelado',
    // O payload inteiro volta na resposta — assim a pessoa não precisa repetir
    // a frase, só dizer o cartão.
    contexto: { compra: data, opcoes: cartoes.map((c) => c.nome) },
  });
  await enviarTexto(phone,
    `${motivo ? `${motivo}\n\n` : ''}💳 *Em qual cartão* foi essa compra de ` +
    `${data.numParcelas}x de ${fmt(Number(data.valorParcela))}?\n\n${lista}\n\n` +
    'Responde com o número ou o nome.');
}

// ── CONSULTA DE UMA COMPRA PARCELADA ─────────────────────────────────────
// "parcelas do presente da juliana", "quantas parcelas faltam do celular".
//
// ⚠️ É o `listar_parcelas` com um `termo`, e usa OS MESMOS grupos que a lista
// completa monta — assim "o que conta como paga", "a próxima" e o legado
// "Desc (2/3)" nunca divergem entre ver uma compra e ver todas.
//
// Motivo: um cliente pediu "o valor e quantidade de parcelas do presente da
// Juliana" e não conseguiu (5x de R$ 54,03 no Mercado Pago, 1 paga).
// Data pura (YYYY-MM-DD) por fatia, nunca por `new Date` — que leria em UTC e
// voltaria um dia no Brasil.
const dataBRParcela = (d) => {
  const s = String(d || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '';
};
const nomeDaCompra = (g) => String((g && g.desc) || 'Compra').replace(/\s*\(\d+\/\d+\)\s*$/, '');

async function responderCompraParcelada(phone, grupoId, termo, grupos) {
  // Parcela de cartão fora da base sai NA MOEDA DO CARTÃO; dívida, na do grupo.
  const base = await moedaBaseDoGrupo(grupoId);
  const brlParcela = (v, g) => fmtMoeda(v, (g && g.moeda) || base);
  const achadas = grupos
    .filter((g) => termoCasaCompra(termo, nomeDaCompra(g), g.cartao))
    // Em aberto primeiro (pela próxima parcela); quitadas depois.
    .sort((a, b) => (Number(b.restantes > 0) - Number(a.restantes > 0))
      || String((a.proxima && a.proxima.data) || '').localeCompare(String((b.proxima && b.proxima.data) || '')));

  if (achadas.length) {
    const MAX = 3;
    const blocos = achadas.slice(0, MAX).map((g) => {
      const total = g.total || (g.pagas + g.restantes);
      // `pagas` e `valorTotal` vêm prontos de `agruparParcelas` — inclusive
      // as parcelas que não existem como linha (legado, marcador faltando).
      const { pagas, valorTotal } = g;
      const linhas = [
        `🧾 *${nomeDaCompra(g)}* — ${g.cartao || 'cartão'}`,
        `💰 Total: ${brlParcela(valorTotal, g)} · ${total}x de ${brlParcela(g.valorParcela, g)}`,
      ];
      // "Cobrada", não "paga": a parcela que caiu na fatura ainda aberta já saiu
      // do cronograma, mas a fatura dela pode não ter sido paga.
      if (g.restantes > 0) {
        linhas.push(`✅ Já cobradas: ${pagas} de ${total}`);
        linhas.push(`⏳ Faltam: ${g.restantes} ${g.restantes === 1 ? 'parcela' : 'parcelas'} · ${brlParcela(g.valorRestante, g)}`);
        if (g.proxima) linhas.push(`📅 Próxima: ${dataBRParcela(g.proxima.data)}`);
      } else {
        linhas.push(`✅ Todas as ${total} parcelas já foram cobradas — nada a vencer.`);
      }
      return linhas.join('\n');
    }).join('\n\n');
    const mais = achadas.length > MAX
      ? `\n\n_+${achadas.length - MAX} compra(s) com "${termo}" — veja no painel._` : '';
    await enviarBotaoLink(phone, {
      message: `${blocos}${mais}\n\n_Pra adiantar: *antecipar parcela do <nome>*._`,
      label: 'Ver no painel',
      url: 'https://forsora.com/cartao-de-credito',
    });
    return;
  }

  // Não é compra de cartão? Pode ser parcelamento com alguém ou empréstimo,
  // que moram em Dívidas ("parcelei o notebook com o joão").
  // ⚠️ Leitura TOLERANTE: se falhar, cai no "não achei" em vez de derrubar.
  try {
    const { data: dividas, error } = await supabase.from('dividas')
      .select('titulo, credor, valor_total, valor_parcela, parcelas_total, parcelas_pagas, status')
      .eq('grupo_id', grupoId);
    if (!error) {
      const d = (dividas || []).find((x) => x.status !== 'quitada' && termoCasaCompra(termo, x.titulo, x.credor));
      if (d) {
        const total = Number(d.parcelas_total) || 0;
        const pagas = Number(d.parcelas_pagas) || 0;
        const restantes = Math.max(0, total - pagas);
        const vp = Number(d.valor_parcela) || (total ? Number(d.valor_total) / total : 0);
        const linhas = [`🧾 *${d.titulo}*${d.credor ? ` — ${d.credor}` : ''}`];
        if (total) {
          linhas.push(`💰 Total: ${brlParcela(Number(d.valor_total) || vp * total)} · ${total}x de ${brlParcela(vp)}`);
          linhas.push(`✅ Pagas: ${pagas} de ${total}`);
          linhas.push(`⏳ Faltam: ${restantes} ${restantes === 1 ? 'parcela' : 'parcelas'} · ${brlParcela(vp * restantes)}`);
        } else {
          linhas.push(`💰 Parcela: ${brlParcela(vp)}`);
        }
        await enviarBotaoLink(phone, {
          message: linhas.join('\n'),
          label: 'Ver no painel',
          url: 'https://forsora.com/dividas',
        });
        return;
      }
    }
  } catch { /* tolerante */ }

  const abertas = grupos.filter((g) => g.restantes > 0).slice(0, 5).map((g) => `*${nomeDaCompra(g)}*`);
  await enviarTexto(phone,
    `🔍 Não achei compra parcelada com *"${termo}"*.`
    + (abertas.length ? `\n\nSuas compras parceladas em aberto: ${abertas.join(', ')}.` : '')
    + '\n\n_Manda *parcelas* pra ver todas._');
}
module.exports = async function handleParcelas(data, ctx) {
  const { phone, grupoId, user } = ctx;
  // Moeda do GRUPO pros totais; cartão e conta saem na moeda deles (Fase 3).
  const base = await moedaBaseDoGrupo(grupoId);
  const fmt = (v) => fmtMoeda(v, base);

  // ── PAGAR FATURA DO CARTÃO: "pagar fatura [nome]" (aberta) ou
  //    "pagar fatura fechada/anterior [nome]" (a que fechou e está vencendo) ──
  if (data.acao === 'pagar_fatura') {
    const termo = (data.termo || '').trim();
    const fechada = !!data.fechada;   // true = ciclo fechado anterior
    // Match tolerante: `ilike` do Postgres é case-insensitive mas NÃO ignora
    // acento — "itau" não casava com "Itaú Crédito". Buscamos todos os cartões
    // e casamos em JS sem acento e sem ruído ("cartão/crédito/fatura/do/da…").
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const semRuido = (s) => norm(s).replace(/\b(cartao|credito|debito|fatura|conta|banco|meu|minha|do|da|de|no|na|o|a)\b/g, '').replace(/\s+/g, ' ').trim();
    const { data: todosCartoes } = await supabase.from('wallets')
      .select('id, nome, dia_fechamento, dia_vencimento, of_conta_id, saldo, moeda').eq('grupo_id', grupoId).eq('tipo', 'Crédito')
      .order('created_at', { ascending: true });
    let cartoes = todosCartoes || [];
    const termoN = semRuido(termo);
    if (termoN) {
      const exato = cartoes.filter((c) => semRuido(c.nome) === termoN);
      const contem = cartoes.filter((c) => { const n = semRuido(c.nome); return n && (n.includes(termoN) || termoN.includes(n)); });
      cartoes = exato.length ? exato : contem;
    }
    if (!cartoes?.length) {
      await enviarTexto(phone, termo
        ? `❌ Não encontrei cartão com *"${termo}"*. Veja os seus: 🌐 forsora.com/cartao-de-credito`
        : `💳 Você ainda não tem cartão de crédito cadastrado.\nCrie um: *cartão nubank limite 5000 fecha 5 vence 15*`);
      return;
    }
    if (cartoes.length > 1) {
      const lista = cartoes.map(c => `• ${c.nome}`).join('\n');
      await enviarTexto(phone, termo
        ? `🤔 Mais de um cartão com *"${termo}"*:\n${lista}\n\nSeja mais específico.`
        : `💳 Você tem mais de um cartão. Qual fatura quer pagar?\n${lista}\n\nEx.: *pagar fatura ${cartoes[0].nome.toLowerCase()}*`);
      return;
    }
    const cartao = cartoes[0];

    // ⚠️ Cartão em outra moeda que a do grupo: sem pagamento manual (mesma
    // recusa do painel, `POST /wallets/fatura/pagar`). Grupo em real nunca cai aqui.
    const baseGrupo = await moedaBaseDoGrupo(grupoId);
    if (cartaoForaDaBase(cartao, baseGrupo)) {
      await enviarTexto(phone, `💳 ${motivoCartaoForaDaBase(cartao, baseGrupo)}`);
      return;
    }

    // Fatura pelo CICLO REAL de fechamento — MESMA fonte do painel, do rollover
    // (096) e dos crons (services/cicloFatura + statusFatura). Antes isto usava
    // mês-calendário justamente pra não divergir do painel; agora os dois falam
    // a mesma língua. `fechada` = a fatura ANTERIOR (ciclo anterior).
    const { statusFatura, cent } = require('../services/faturaRollover');
    const compAtual = competenciaAtual(cartao);
    const competencia = fechada ? competenciaVizinha(cartao, compAtual, -1) : compAtual;
    const ciclo = cicloPorCompetencia(cartao, competencia);
    const ehOF = !!cartao.of_conta_id;

    // A fatura está NA MOEDA DO CARTÃO (migration 168) — é o número do app do banco.
    const fmtCartao = (v) => fmtMoeda(v, cartao.moeda || base);
    let fatura, jaPago = 0;
    if (ehOF && !fechada && typeof cartao.saldo === 'number' && cartao.saldo < 0) {
      // Open Finance: saldo = −fatura (já sem parcelas a vencer). Igual ao painel.
      // ⚠️ Só vale com saldo NEGATIVO: zero quer dizer "o banco não publicou o
      // total" (normal enquanto o ciclo não fecha), não "você não deve nada" —
      // aí caímos no ciclo, que soma as transações importadas.
      fatura = cent(-(cartao.saldo));
    } else {
      const st = await statusFatura(grupoId, cartao, competencia);
      jaPago = st.pago;
      fatura = st.restante;
    }
    const qualTxt = fechada ? 'fatura anterior' : 'fatura';

    if (fatura <= 0) {
      await enviarTexto(phone,
        `🎉 A ${qualTxt} do *${cartao.nome}* está ${jaPago > 0 ? 'quitada' : 'zerada'}` +
        `${jaPago > 0 ? ` (você já pagou ${fmtCartao(jaPago)})` : ''}. Nada a pagar!`);
      return;
    }

    // Pagamento PARCIAL: "paguei 100 da fatura..." → paga só R$100 (limita à fatura).
    const parcial = !!(data.valor && data.valor > 0);
    const valorPagar = parcial ? Math.min(data.valor, fatura) : fatura;

    // Período do ciclo + vencimento — deixa claro QUAL fatura está sendo paga.
    const [vy, vm, vd] = ciclo.venc.split('-');
    const vencTxt = `\n⏰ Vence em ${vd}/${vm}`
      + (ciclo.porCiclo ? `\n📅 Ciclo: ${ciclo.label}` : '');

    const introValor = parcial
      ? `💳 Pagar *${fmtCartao(valorPagar)}* da fatura do *${cartao.nome}* (fatura: ${fmtCartao(fatura)})`
      : `💳 *Fatura ${cartao.nome}${fechada ? ' (anterior)' : ''}: ${fmtCartao(fatura)}*`;
    await oferecerDesconto({
      user, phone, grupoId, valor: valorPagar,
      categoria: CATEGORIA_FATURA, observacao: `Fatura ${cartao.nome}${fechada ? ' (anterior)' : ''}`,
      extra: { cartao_id: cartao.id, competencia },
      permiteExterno: true, // fatura pode ter sido paga por outra pessoa
      intro: `${introValor}${vencTxt}\nCom qual conta você pagou?`,
    });
    return;
  }

  // ── DEFINIR DIA DE FECHAMENTO DA FATURA ─────────────────────────
  if (data.acao === 'set_fatura_dia') {
    await supabase.from('users')
      .update({ dia_fechamento_fatura: data.dia })
      .eq('phone', phone);
    await enviarTexto(phone, `📅 Dia de fechamento da fatura definido para o dia *${data.dia}* de cada mês.`);
    return;
  }

  // ── COMPRA PARCELADA ────────────────────────────────────────────
  if (data.acao === 'compra_parcelada') {
    const { descricao, numParcelas, valorParcela, valorTotal, categoria } = data;

    // ── QUAL CARTÃO ─────────────────────────────────────────────────
    //
    // ⚠️ ISTO ERA UM `ilike('%' + nome + '%')` CRU, E FOI METADE DO RELATO DE
    // set/2026. `ilike` compara byte a byte: "itau credito" (como a pessoa
    // digita, e como o Whisper transcreve) NÃO casa com "Itaú Crédito" — a
    // Sora respondia "cartão não encontrado, crie primeiro com itau credito 0",
    // mandando criar um cartão que já existia.
    //
    // `resolverCarteiraReal` é o resolvedor canônico do projeto e já resolve
    // isso: normaliza acento/caixa, tira ruído ("cartão", "conta"), casa por
    // palavra e cai num fuzzy com limiar alto. E o `.single()` de antes
    // ESTOURAVA quando o termo casava com dois cartões.
    const cartoes = (await listarCartoes(grupoId));
    if (!cartoes.length) {
      await enviarTexto(phone, '❌ Você ainda não tem nenhum *cartão de crédito* cadastrado.\nCrie com: "nubank crédito 0" e tente de novo.');
      return;
    }

    // Sem cartão citado ("comprei 50 em roupas em 2x") → PERGUNTA, não chuta.
    // Parcelamento mora sempre num cartão específico; escolher sozinho poderia
    // pendurar 12 parcelas no cartão errado.
    if (!data.carteira) {
      await pedirCartao(ctx, data, cartoes);
      return;
    }

    const wallet = await acharCartao(grupoId, data.carteira, cartoes);
    if (!wallet) {
      // Pode ser conta de DÉBITO citada ("no nubank" quando só existe a conta):
      // aí o caminho é escolher um cartão, não mandar criar um que já existe.
      await pedirCartao(ctx, data, cartoes,
        `❓ Não achei um *cartão de crédito* chamado "${data.carteira}".`);
      return;
    }
    const carteiraNome = wallet.nome;
    // Gera N transações futuras (uma por fatura/mês). Cada parcela é um Gasto
    // não-pago no cartão, com data no mês da respectiva fatura. Assim o painel
    // (que lê transações) reflete o limite comprometido, mostra faturas futuras
    // e permite antecipar. A 1ª parcela cai na FATURA ATUAL (mês corrente) —
    // a compra de hoje entra na fatura aberta. As seguintes nos meses seguintes.
    // Base da 1ª parcela = data da compra ("comprei ... ontem") ou hoje (SP),
    // ancorada ao meio-dia UTC. As demais caem nos meses seguintes.
    let base;
    if (data.dataTx) base = new Date(data.dataTx + 'T12:00:00.000Z');
    else { const [Y, M, D] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).split('-').map(Number); base = new Date(Date.UTC(Y, M - 1, D, 12)); }
    const bY = base.getUTCFullYear(), bM = base.getUTCMonth(), bD = base.getUTCDate();
    const dataParcela = i => new Date(Date.UTC(bY, bM + i, Math.min(bD, 28), 12));

    // ⚠️ O RESTO DOS CENTAVOS VAI NA PRIMEIRA PARCELA — é o que o banco faz, e
    // sem isso a soma das parcelas não fecha com o total. Vale pro formato em
    // que a pessoa diz o TOTAL ("100 em 3 parcelas"): 100/3 = 33,33, e três
    // vezes 33,33 dá 99,99. A fatura ficaria 1 centavo menor pra sempre.
    const cent = (v) => Math.round((Number(v) || 0) * 100);
    const sobra = cent(valorTotal) - cent(valorParcela) * numParcelas;
    const valorDaParcela = (i) => (i === 0
      ? (cent(valorParcela) + sobra) / 100
      : valorParcela);

    // Cartão fora da moeda base do grupo (migration 168): a parcela guarda o
    // valor ORIGINAL (moeda do cartão, que é o que a fatura soma) e `valor`
    // convertido — igual ao lançamento avulso. Cartão na base devolve `moeda`
    // null e a linha sai idêntica à de antes.
    const baseGrupo = await moedaBaseDoGrupo(grupoId);
    const moedaCartao = wallet.moeda == null ? baseGrupo : normalizarMoeda(wallet.moeda);
    const tabelaCartao = await taxasParaBase([moedaCartao], baseGrupo);
    const valoresDaParcela = (i) => {
      const c = camposTransacao(valorDaParcela(i), moedaCartao, tabelaCartao, baseGrupo);
      return c.moeda
        ? { valor: c.valor, moeda: c.moeda, valor_moeda: c.valor_moeda, taxa_brl: c.taxa_brl }
        : { valor: c.valor };
    };

    // Mesmo schema do painel (migration 071): parcela_num/total/grupo — assim o
    // "listar parcelas", a badge "1/3" e o "excluir todas" funcionam igual.
    const grupoParcela = 'P' + Math.random().toString(36).substring(2, 10).toUpperCase();
    const linhas = [];
    for (let i = 0; i < numParcelas; i++) {
      linhas.push({
        id_curto:      gerarId(),
        grupo_id:      grupoId,
        criado_por:    user?.id || null,
        tipo:          'Gasto',
        categoria:     categoria || 'Outros',
        ...valoresDaParcela(i),
        observacao:    descricao,
        carteira_nome: wallet.nome,
        pago:          false,
        data:          dataParcela(i).toISOString(),
        parcela_num:   i + 1,
        parcela_total: numParcelas,
        parcela_grupo: grupoParcela,
      });
    }
    await supabase.from('transacoes').insert(linhas);

    const ultimaData = dataParcela(numParcelas - 1);
    const compraFmt = base.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    await enviarTexto(phone,
      `✅ *Compra parcelada registrada!*\n\n` +
      `📦 ${descricao}\n` +
      `💳 Cartão: ${wallet.nome}\n` +
      `🏷️ Categoria: ${categoria || 'Outros'}\n` +
      `💵 Total: ${fmtMoeda(valorTotal, moedaCartao)} em ${numParcelas}x de ${fmtMoeda(valorParcela, moedaCartao)}\n` +
      `📅 ${data.dataTx ? `Compra em ${compraFmt} · ` : '1ª parcela na fatura atual · '}última em ${ultimaData.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', month: 'long', year: 'numeric' })}\n\n` +
      `As ${numParcelas} parcelas já aparecem nas faturas do painel. Você pode antecipar por lá.`
    );
    return;
  }

  // ── ANTECIPAR PARCELA(S) ────────────────────────────────────────
  // Marca como paga(s) a(s) parcela(s) em aberto (transações não-pagas)
  // cujo nome casa com o termo. "antecipar parcela X" = a próxima;
  // "quitar parcelas X" = todas.
  if (data.acao === 'antecipar_parcela') {
    const termo = (data.termo || '').trim();
    if (!termo) {
      await enviarTexto(phone, '❓ Qual compra? Ex: "antecipar parcela do fone" ou "quitar parcelas da tv".');
      return;
    }

    const { data: parcelas } = await supabase.from('transacoes')
      .select('*')
      .eq('grupo_id', grupoId)
      .eq('tipo', 'Gasto')
      .eq('pago', false)
      .ilike('observacao', `%${termo}%`)
      .order('data', { ascending: true });

    // ⚠️ Parcela cujo dia já chegou foi COBRADA, mesmo com `pago: false` (ver
    // parcelaJaCobrada). "Antecipar" a que já está numa fatura debitaria a
    // conta por um valor que a fatura também cobra.
    const aVencer = (parcelas || []).filter((p) => !parcelaJaCobrada(p, hojeSP()));
    if (!aVencer.length) {
      await enviarTexto(phone, `❌ Não encontrei parcelas em aberto de *"${termo}"*.\nVeja suas faturas no painel: forsora.com/cartao-de-credito`);
      return;
    }

    const alvo = data.todas ? aVencer : [aVencer[0]];

    // ⚠️ Parcela de cartão em outra moeda que a do grupo: sem antecipação
    // manual (mesma recusa do painel). A linha diz sozinha — `moeda` só é
    // preenchida quando a carteira NÃO está na base (ver moeda.camposTransacao)
    // —, então a base só é lida quando há uma assim. Grupo em real nunca recusa.
    const foraDaBase = alvo.find((t) => t.moeda);
    if (foraDaBase) {
      const baseGrupo = await moedaBaseDoGrupo(grupoId);
      const cartaoDaParcela = { nome: foraDaBase.carteira_nome, moeda: foraDaBase.moeda };
      if (cartaoForaDaBase(cartaoDaParcela, baseGrupo)) {
        await enviarTexto(phone, `💳 ${motivoCartaoForaDaBase(cartaoDaParcela, baseGrupo)}`);
        return;
      }
    }

    const totalPago = alvo.reduce((s, t) => s + (t.valor || 0), 0);

    // Pagar fatura debita de uma conta — pergunta de qual (igual ao painel).
    const { data: contas } = await supabase.from('wallets')
      .select('id, nome, saldo, tipo, arquivada, moeda')
      .eq('grupo_id', grupoId)
      .neq('tipo', 'Crédito')
      .order('created_at', { ascending: true });
    const contasAtivas = (contas || []).filter(c => !c.arquivada);

    if (contasAtivas.length === 0) {
      // Sem conta pra debitar — só quita as parcelas (libera limite)
      await supabase.from('transacoes').update({ pago: true }).in('id', alvo.map(t => t.id));
      await enviarTexto(phone,
        `✅ Quitei *${alvo.length}* parcela(s) de *"${termo}"* (${fmt(totalPago)}) e liberei o limite.\n` +
        `⚠️ Você não tem conta bancária cadastrada, então não debitei de nenhuma.`
      );
      return;
    }

    const opcoesTexto = contasAtivas
      .map((c, i) => `${i + 1}️⃣ ${c.nome} (${fmtMoeda(c.saldo || 0, c.moeda || base)})`)
      .join('\n');
    await enviarTexto(phone,
      `💳 Vou antecipar *${alvo.length}* parcela(s) de *"${termo}"* — total ${fmt(totalPago)}.\n\n` +
      `❓ *De qual conta pago?*\n${opcoesTexto}\n\nResponde com o número ou o nome.`
    );

    if (user?.id) {
      await criarPendente({
        userId: user.id,
        tipoPergunta: 'pagar_parcela_conta',
        contexto: {
          ids: alvo.map(t => t.id),
          termo,
          total: totalPago,
          opcoes: contasAtivas.map(c => ({ id: c.id, nome: c.nome })),
        },
      });
    }
    return;
  }

  // ── LISTAR COMPRAS PARCELADAS EM ABERTO ─────────────────────────
  // "parcelas", "minhas parcelas", "como estão minhas parcelas",
  // "quantas parcelas tenho pra pagar". Agrupa por compra (parcela_grupo)
  // e mostra só as que ainda têm parcela a vencer.
  if (data.acao === 'listar_parcelas') {
    // Fonte principal: linhas com parcela_grupo (painel + WhatsApp novo).
    const { data: comGrupo } = await supabase.from('transacoes')
      .select('valor, valor_moeda, moeda, observacao, carteira_nome, pago, data, parcela_num, parcela_total, parcela_grupo')
      .eq('grupo_id', grupoId).eq('tipo', 'Gasto')
      .not('parcela_grupo', 'is', null)
      .order('data', { ascending: true });

    // Fallback legado: WhatsApp antigo (sem parcela_grupo) — observação "Desc (2/3)".
    const { data: semGrupo } = await supabase.from('transacoes')
      .select('valor, valor_moeda, moeda, observacao, carteira_nome, pago, data')
      .eq('grupo_id', grupoId).eq('tipo', 'Gasto').eq('pago', false)
      .is('parcela_grupo', null)
      .ilike('observacao', '%(%/%)%')
      .order('data', { ascending: true });

    // ⚠️ "Já cobrada" NÃO é `pago`: parcela futura nasce não paga e nada a vira
    // quando o dia chega. Ver parcelaJaCobrada em services/consultaParcela.js.
    const grupos = agruparParcelas(comGrupo, semGrupo, hojeSP());

    // Uma compra específica ("parcelas do presente da juliana"). SEM termo, tudo
    // abaixo segue exatamente como era.
    if (data.termo) {
      await responderCompraParcelada(phone, grupoId, data.termo, [...grupos.values()]);
      return;
    }

    const abertas = [...grupos.values()]
      .filter(g => g.restantes > 0)
      .sort((a, b) => (a.proxima?.data || '').localeCompare(b.proxima?.data || ''));

    if (!abertas.length) {
      await enviarTexto(phone, '🎉 Você não tem *compras parceladas em aberto*. Tudo quitado por aqui!');
      return;
    }

    const fmtMes = iso => new Date(iso)
      .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', month: 'short', year: '2-digit' })
      .replace('.', '');
    // Cabe no corpo do botão (limite 1024): mostra as ~8 mais próximas.
    const MAX = 8;
    const mostradas = abertas.slice(0, MAX);
    const blocos = mostradas.map(g => {
      const nome = (g.desc || 'Compra').replace(/\s*\(\d+\/\d+\)\s*$/, '');
      const pagasTxt = g.total ? `${g.pagas}/${g.total} cobradas` : `${g.pagas} cobradas`;
      const prox = g.proxima ? ` · próxima ${fmtMes(g.proxima.data)}` : '';
      return `💳 *${nome}* — ${g.cartao || 'cartão'}\n   ${g.restantes}x de ${fmtMoeda(g.valorParcela, g.moeda || base)} a pagar (${pagasTxt})${prox}`;
    }).join('\n\n');
    const maisTxt = abertas.length > MAX ? `\n\n_+${abertas.length - MAX} compra(s) — veja o restante no painel._` : '';

    // Soma compras de cartões diferentes: na moeda do GRUPO (migration 168).
    // Cada linha acima segue na moeda do cartão. Sem cartão fora da base é o
    // mesmo número de antes.
    const totalRestante = abertas.reduce((s, g) => s + g.valorRestanteBase, 0);
    await enviarBotaoLink(phone, {
      message:
        `🧾 *Suas compras parceladas*\n\n${blocos}${maisTxt}\n\n` +
        `💰 *Total ainda a pagar: ${fmt(totalRestante)}*\n\n` +
        `_Pra adiantar: *antecipar parcela do <nome>* · quitar tudo: *quitar parcelas do <nome>*._`,
      label: 'Ver no painel',
      url: 'https://forsora.com/cartao-de-credito',
    });
    return;
  }
};

// (cicloFatura/somarFatura/vencimentoApos saíram daqui — agora vivem em
//  services/cicloFatura.js + faturaRollover.somaFaturaCiclo, fonte única.)