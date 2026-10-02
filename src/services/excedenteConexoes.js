// =============================================================================
// CONEXÃO DE BANCO ALÉM DO DIREITO — quem avisar, quando, e qual desligar.
//
// Medido em 02/10/2026: 9 contas usando 16 conexões além do que o plano cobre.
// Cinco são VITALÍCIAS (franquia zero, por decisão: pagou uma vez e cada
// conexão nos custa mensalidade no agregador) e quatro estão `inativo` — gente
// sem plano nenhum com banco conectado. A maior usa 5 conexões com direito 0.
//
// ⚠️ A CAUSA É ESTRUTURAL, não má-fé do cliente: a franquia só é checada no
// momento de CONECTAR (`POST /conectar`). Depois disso nada reavalia — cancelar
// a assinatura da conexão avulsa zera `of_conexoes_pagas` (webhook do Stripe) e
// cair pra `inativo` zera a franquia, e as conexões seguem vivas e cobradas.
//
// A regra escolhida pelo dono (02/10/2026) é AVISAR E DAR PRAZO, nunca cortar
// na hora: a tela diz que a conexão não está mais coberta, dá 2 dias e oferece
// as duas saídas (contratar a avulsa de R$6/mês ou desconectar um banco).
//
// ⚠️ ESTE ARQUIVO NÃO TOCA EM NADA. Ele só responde "qual é o estado" e "qual
// conexão sairia" — é o cron (JOB 1R) que age, e é a rota que exibe. Separado
// de propósito: desligar o banco de um cliente é irreversível (reconectar cria
// consentimento novo, que a Polp cobra), então a decisão tinha de ficar num
// lugar testável.
//
// Eval: npm run eval:excedente-conexoes
// =============================================================================

const { ehConexaoViva } = require('./openFinanceProvider');

/** Prazo de regularização, em horas, a partir do PRIMEIRO aviso. */
const PRAZO_HORAS = 48;

const hora = (v) => {
  const t = v instanceof Date ? v.getTime() : Date.parse(v || '');
  return Number.isFinite(t) ? t : null;
};

/**
 * Ordem de desligamento: qual conexão sai PRIMEIRO quando sobra gente.
 *
 * ⚠️ MORTA ANTES DE VIVA. Conexão que não autoriza / não sincroniza é custo
 * puro: ela já não serve ao cliente e desligá-la pode até resolver o excedente
 * sozinho, sem ninguém perder acesso a nada. Era o caso mais comum na medição.
 *
 * ⚠️ Entre duas do mesmo estado, sai a MAIS NOVA. Quem conectou primeiro vinha
 * usando aquele banco há mais tempo; tirar a antiga pra manter a recém-criada
 * seria o inverso do que a pessoa espera, e `created_at` é o único critério que
 * não depende de palpite sobre qual banco ela "usa mais".
 */
function ordemDeCorte(a, b) {
  const vivaA = ehConexaoViva(a?.status) ? 1 : 0;
  const vivaB = ehConexaoViva(b?.status) ? 1 : 0;
  if (vivaA !== vivaB) return vivaA - vivaB;          // morta (0) primeiro
  const ca = hora(a?.created_at) ?? 0;
  const cb = hora(b?.created_at) ?? 0;
  return cb - ca;                                     // mais nova primeiro
}

/**
 * Estado do direito deste usuário sobre as conexões que ele tem.
 *
 * @param {Object}   p
 * @param {number}   p.limite          franquia do plano + conexões pagas (de `acessoOpenFinance`)
 * @param {Array}    p.conexoes        linhas de `of_conexoes` do usuário
 * @param {string}   [p.excedenteDesde] quando o excedente foi detectado pela 1ª vez
 * @param {Date}     [p.agora]
 * @returns {{
 *   estado: 'indefinido'|'ok'|'avisando'|'vencido',
 *   excede: boolean, limite: number, usando: number, excedente: number,
 *   prazo: string|null, horasRestantes: number|null, aDesligar: Array,
 * }}
 */
function estadoExcedente({ limite, conexoes, excedenteDesde, agora } = {}) {
  const vazio = {
    estado: 'indefinido', excede: false, limite: 0, usando: 0, excedente: 0,
    prazo: null, horasRestantes: null, aDesligar: [],
  };

  // ⚠️ SEM DADO NÃO SE AFIRMA NADA. Falha ao ler o plano ou as conexões tem de
  // devolver 'indefinido', não "excede": é esta linha que impede um soluço de
  // rede de desligar o banco de um cliente pagante. Mesma escolha do
  // `estadoConexao` do front e do `podeAnunciarFrescor`.
  if (!Array.isArray(conexoes)) return vazio;
  if (typeof limite !== 'number' || !Number.isFinite(limite) || limite < 0) return vazio;

  const usando = conexoes.length;
  const excedente = Math.max(0, usando - limite);
  if (excedente === 0) {
    return { ...vazio, estado: 'ok', limite, usando };
  }

  const inicio = hora(excedenteDesde);
  const agoraMs = (agora instanceof Date ? agora : new Date()).getTime();

  // Sem marco anterior, o relógio começa AGORA — nunca em retroativo. Quem
  // acabou de entrar nesta situação (ou quem já estava nela antes de o aviso
  // existir) recebe os 2 dias inteiros a partir do primeiro aviso de verdade.
  const base = inicio ?? agoraMs;
  const prazoMs = base + PRAZO_HORAS * 3600 * 1000;
  // ⚠️ `inicio != null` e REDUNDANTE por construcao (sem marco, `base` e agora e o
  // prazo cai no futuro) — a mutacao que o remove SOBREVIVE, e sobrevive por ser
  // equivalente, nao por teste fraco. Fica escrito porque e a REGRA: nada e
  // desligado sem aviso previo gravado. Quem mexer em PRAZO_HORAS descobre que
  // esta linha e a unica coisa segurando o corte.
  const vencido = inicio != null && agoraMs >= prazoMs;

  const aDesligar = vencido
    ? [...conexoes].sort(ordemDeCorte).slice(0, excedente)
    : [];

  return {
    estado: vencido ? 'vencido' : 'avisando',
    excede: true, limite, usando, excedente,
    prazo: new Date(prazoMs).toISOString(),
    horasRestantes: Math.max(0, Math.ceil((prazoMs - agoraMs) / 3600000)),
    aDesligar,
  };
}

module.exports = { estadoExcedente, ordemDeCorte, PRAZO_HORAS };
