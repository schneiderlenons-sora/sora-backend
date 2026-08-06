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

async function criarRecorrencia({
  grupoId, criadoPor, tipo, categoria, valor, dia_vencimento, descricao, carteira, valor_variavel,
  modo_lancamento, lembrete,
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
    valor:          parseFloat(valor) || 0,
    // 1–31. Dia que não existe no mês (29/30/31 em fev, 31 em abr…) o cron dispara
    // no ÚLTIMO dia do mês — mesma semântica do ocorrenciasMensais (Agenda). Travar
    // em 28 mudava a intenção do usuário calada ("dia 29" virava dia 28).
    dia_vencimento: Math.max(1, Math.min(31, parseInt(dia_vencimento, 10) || 5)),
    descricao:      desc,
    carteira:       carteira || 'Dinheiro',
    ativa:          true,
  };
  const variavel = { valor_variavel: !!valor_variavel };
  // Migration 112. Se não veio escolha, o padrão é decidido pela CARTEIRA: conta
  // ligada ao Open Finance nasce 'nao_lancar' (o banco já traz a cobrança real,
  // a Sora não precisa inventar linha); o resto nasce 'lancar', como sempre foi.
  const modo = { modo_lancamento: modo_lancamento || await modoPadrao(grupoId, carteira), lembrete: lembrete !== false };

  // Vai removendo as colunas que o banco ainda não tiver (112, 066, 052).
  let ins = await supabase.from('recorrencias').insert({ ...base, ...variavel, ...modo, criado_por: criadoPor }).select().single();
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

module.exports = { criarRecorrencia, categoriaValida, modoPadrao };
