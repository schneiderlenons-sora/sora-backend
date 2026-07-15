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

async function criarRecorrencia({
  grupoId, criadoPor, tipo, categoria, valor, dia_vencimento, descricao, carteira, valor_variavel,
}) {
  const ehReceita = tipo === 'Recebimento';
  const desc = (descricao || '').toString().slice(0, 120);
  const base = {
    grupo_id:       grupoId,
    tipo:           ehReceita ? 'Recebimento' : 'Gasto',
    // Categoria explícita vence; senão auto-categoriza pela descrição (dentista
    // → Saúde, luz → Contas…); receita sem categoria cai em Salário.
    categoria:      categoria || (ehReceita ? '💼 Salário' : (categorizarDescricao(desc) || 'Outros')),
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
  let ins = await supabase.from('recorrencias').insert({ ...base, ...variavel, criado_por: criadoPor }).select().single();
  if (ins.error) ins = await supabase.from('recorrencias').insert({ ...base, ...variavel }).select().single();
  if (ins.error) ins = await supabase.from('recorrencias').insert({ ...base, criado_por: criadoPor }).select().single();
  if (ins.error) ins = await supabase.from('recorrencias').insert(base).select().single();
  if (ins.error) throw ins.error;
  return ins.data;
}

module.exports = { criarRecorrencia };
