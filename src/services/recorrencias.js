// =====================================================================
// Criação de recorrência (conta fixa: gasto/receita que se repete todo mês).
// Usado pela aba "Previstos do mês" (POST /api/recorrencias) E pelo toggle
// "Recorrente" do modal de Nova Transação (POST /api/transacoes).
//
// Tolerante às migrations 052 (criado_por) e 066 (valor_variavel): vai
// removendo as colunas extras que o banco ainda não tiver.
// =====================================================================
const supabase = require('../db/supabase');
const { categorizarDescricao } = require('./categorizar');
const { calcularDataFim } = require('./frequenciaRecorrencia');
// Conta fixa em moeda estrangeira (migration 160): o valor informado está na
// moeda DA CARTEIRA, igual à transação avulsa. Ver `moedaDaCarteira` abaixo.
const { normalizarMoeda, taxas, camposTransacao } = require('./moeda');

/**
 * Confere se a categoria EXISTE no catálogo do grupo; se não, tenta sem o
 * emoji e, em último caso, devolve 'Outros'.
 *
 * ⚠️ Conserto de um bug real: aqui havia '💼 Salário' cravado como padrão de
 * receita, e o rebuild de categorias (migrations 084→087) renomeou pra
 * 'Salário'. 30 recorrências ficaram apontando pra um nome que não existe mais
 * — a transação lançada carregava o nome fantasma, a aba Categorias não achava
 * no catálogo do grupo e jogava em "Outros". Parecia que a edição não salvava.
 *
 * Validar contra o catálogo impede que QUALQUER renomeação futura volte a
 * criar categoria fantasma. Tolerante: se a consulta falhar, mantém o que veio
 * (categoria não pode impedir a criação da conta fixa).
 */
async function categoriaValida(grupoId, nome) {
  const alvo = String(nome || 'Outros');
  try {
    const existe = async (n) => {
      const { data } = await supabase.from('categorias')
        .select('nome').eq('grupo_id', grupoId).eq('nome', n).maybeSingle();
      return !!data;
    };
    if (await existe(alvo)) return alvo;
    const sem = alvo.replace(/^[^\p{L}\p{N}]+/u, '').trim();   // "💼 Salário" → "Salário"
    if (sem && sem !== alvo && await existe(sem)) return sem;
    return 'Outros';
  } catch { return alvo; }
}

/**
 * Em que moeda está o valor de uma conta fixa: a da CARTEIRA dela.
 *
 * ⚠️ Mesma regra da transação avulsa — "o valor está na moeda da conta". Sem
 * isto, quem tem conta em coroa cadastrava "salário 20000" e a Sora guardava
 * R$ 20.000 onde ele quis dizer kr 20.000 (≈ R$ 11.000).
 *
 * Falha de leitura cai em BRL: é o comportamento de sempre, e chutar moeda
 * estrangeira num erro de rede seria muito pior que chutar real.
 */
async function moedaDaCarteira(grupoId, carteira) {
  try {
    const { data } = await supabase.from('wallets')
      .select('moeda').eq('grupo_id', grupoId).ilike('nome', carteira || 'Dinheiro').maybeSingle();
    return normalizarMoeda(data?.moeda);
  } catch { return 'BRL'; }
}

async function criarRecorrencia({
  grupoId, criadoPor, tipo, categoria, valor, dia_vencimento, descricao, carteira, valor_variavel,
  modo_lancamento, lembrete,
  frequencia, dia_semana, mes_vencimento, repeticoes, lembrete_dias,
}) {
  const ehReceita = tipo === 'Recebimento';
  const desc = (descricao || '').toString().slice(0, 120);
  const base = {
    grupo_id:       grupoId,
    tipo:           ehReceita ? 'Recebimento' : 'Gasto',
    // Categoria explícita vence; senão auto-categoriza pela descrição (dentista
    // → Saúde, luz → Contas…); receita sem categoria cai em Salário. Sempre
    // conferida contra o catálogo do grupo — ver categoriaValida().
    categoria:      await categoriaValida(
      grupoId,
      categoria || (ehReceita ? 'Salário' : (categorizarDescricao(desc) || 'Outros')),
    ),
    valor:          0,   // preenchido logo abaixo (pode ser conversão)
    // 1–31. Dia que não existe no mês (29/30/31 em fev, 31 em abr…) o cron dispara
    // no ÚLTIMO dia do mês — mesma semântica do ocorrenciasMensais (Agenda). Travar
    // em 28 mudava a intenção do usuário calada ("dia 29" virava dia 28).
    dia_vencimento: Math.max(1, Math.min(31, parseInt(dia_vencimento, 10) || 5)),
    descricao:      desc,
    carteira:       carteira || 'Dinheiro',
    ativa:          true,
  };

  // ── Moeda da carteira (migration 160) ───────────────────────────────────
  // ⚠️ `valor` fica SEMPRE em BRL: 22 arquivos somam esse campo (projeção dos
  // Previstos, saldo projetado, agenda, Oráculo, resumo do zap…). Converter na
  // leitura obrigaria os 22 a conhecer cotação — a receita das cópias
  // divergentes. O nativo vai ao lado, e o JOB 1M mantém o BRL atualizado.
  const moedaRec = await moedaDaCarteira(grupoId, carteira);
  const tabelaRec = moedaRec === 'BRL' ? {} : await taxas([moedaRec]);
  const camposRec = camposTransacao(parseFloat(valor) || 0, moedaRec, tabelaRec);
  base.valor = camposRec.valor;
  // Só em conta estrangeira; sem a 160 o insert cai na camada seguinte.
  const extraMoeda = camposRec.moeda
    ? { moeda: camposRec.moeda, valor_moeda: camposRec.valor_moeda, taxa_brl: camposRec.taxa_brl }
    : {};

  const variavel = { valor_variavel: !!valor_variavel };
  // Migration 112. Se não veio escolha, o padrão é decidido pela CARTEIRA: conta
  // ligada ao Open Finance nasce 'nao_lancar' (o banco já traz a cobrança real,
  // a Sora não precisa inventar linha); o resto nasce 'lancar', como sempre foi.
  const modo = { modo_lancamento: modo_lancamento || await modoPadrao(grupoId, carteira), lembrete: lembrete !== false };

  // ── Frequência, duração e antecedência (migration 157) ────────────────────
  //
  // ⚠️ O QUE O CRON CONSULTA É `data_fim`, NÃO `repeticoes`. As duas são
  // gravadas: `repeticoes` existe só pra a tela reexibir a escolha ("12x") na
  // edição. Encerrar por contagem exigiria um contador incrementado a cada
  // lançamento, e ele sai de sincronia com um restart no meio do laço, um
  // lançamento manual ou um restore. A data é imutável depois de escrita.
  const hojeSP = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const freq = ['semanal', 'mensal', 'anual'].includes(frequencia) ? frequencia : 'mensal';
  const diaSem = freq === 'semanal' ? Math.max(0, Math.min(6, parseInt(dia_semana, 10) || 0)) : null;
  const mesVen = freq === 'anual'   ? Math.max(1, Math.min(12, parseInt(mes_vencimento, 10) || 1)) : null;
  const extra157 = {
    frequencia: freq,
    dia_semana:     diaSem,
    mes_vencimento: mesVen,
    repeticoes:     Number(repeticoes) > 0 ? Math.min(999, parseInt(repeticoes, 10)) : null,
    lembrete_dias:  Math.max(0, Math.min(30, parseInt(lembrete_dias, 10) || 0)),
    data_inicio:    hojeSP,
    // ⚠️ `diaSemana`/`mesVencimento` VÃO JUNTO: sem eles a data final conta
    // a partir de HOJE em vez da primeira ocorrência, e "12x" entrega 11.
    data_fim: calcularDataFim({
      frequencia: freq,
      repeticoes,
      dataInicio: hojeSP,
      diaVencimento: base.dia_vencimento,
      diaSemana: diaSem,
      mesVencimento: mesVen,
    }),
  };

  // Vai removendo as colunas que o banco ainda não tiver (112, 066, 052).
  // ⚠️ A camada da 157 vem PRIMEIRO, e a antiga continua logo abaixo: sem a
  // migration a recorrência ainda é criada (mensal e pra sempre, como antes)
  // em vez de o cadastro inteiro falhar.
  // ⚠️ A camada de MOEDA vem junto da 157, e a linha de baixo já é o retrocesso:
  // sem a migration 160 a conta fixa ainda é criada, só sem registrar a moeda.
  let ins = await supabase.from('recorrencias').insert({ ...base, ...variavel, ...modo, ...extra157, ...extraMoeda, criado_por: criadoPor }).select().single();
  if (ins.error) ins = await supabase.from('recorrencias').insert({ ...base, ...variavel, ...modo, criado_por: criadoPor }).select().single();
  if (ins.error) ins = await supabase.from('recorrencias').insert({ ...base, ...variavel, criado_por: criadoPor }).select().single();
  if (ins.error) ins = await supabase.from('recorrencias').insert({ ...base, ...variavel }).select().single();
  if (ins.error) ins = await supabase.from('recorrencias').insert({ ...base, criado_por: criadoPor }).select().single();
  if (ins.error) ins = await supabase.from('recorrencias').insert(base).select().single();
  if (ins.error) throw ins.error;
  return ins.data;
}

/** Conta fixa numa carteira do Open Finance nasce sem lançar nada. */
async function modoPadrao(grupoId, carteira) {
  try {
    const { data } = await supabase.from('wallets')
      .select('of_conta_id').eq('grupo_id', grupoId)
      .ilike('nome', carteira || 'Dinheiro').maybeSingle();
    return data?.of_conta_id ? 'nao_lancar' : 'lancar';
  } catch { return 'lancar'; }
}

module.exports = { criarRecorrencia, categoriaValida, modoPadrao, moedaDaCarteira };
