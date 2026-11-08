// =============================================================================
// TODA CONTA TEM UM GRUPO — e o grupo original não se perde.
//
// Relato (Paulo, nov/2026): o WhatsApp respondia "Erro ao carregar seu perfil"
// a toda mensagem e o Open Finance dizia "Você não tem um grupo ativo". Um
// cliente pagante, sem saída: "tente novamente" nunca ia funcionar.
//
// Como chegou lá: o grupo criado junto com a conta ("Pessoal de X") foi
// RENOMEADO, um convidado entrou, e o dono saiu. A trava "não pode sair do
// Pessoal" olhava só o NOME (/pessoal/i), então com outro nome o botão aparecia,
// a posse ia pro convidado e o dono ficava sem grupo nenhum.
//
// ⚠️ O QUE IDENTIFICA O GRUPO ORIGINAL É TER NASCIDO COM A CONTA, não o nome. O
// trigger de cadastro cria os dois na mesma transação, então `created_at` é
// idêntico (medido: 344 das 348 contas; 9 delas com o grupo já renomeado). Os
// 10s são folga; quem não tem essa marca é conta legada e segue pela regra do nome.
// ⚠️ NÃO É "O MAIS ANTIGO DE QUE ELE É DONO": um grupo recebido por transferência
// costuma ser mais velho que o Pessoal de quem o recebeu.
// =============================================================================

const FOLGA_MS = 10_000;

/** Este é o grupo que nasceu junto com a conta? */
function ehGrupoOriginal(grupo, user) {
  if (!grupo || !user || grupo.dono_id !== user.id) return false;
  const g = new Date(grupo.created_at).getTime();
  const u = new Date(user.created_at).getTime();
  return Math.abs(g - u) < FOLGA_MS; // data inválida vira NaN e dá false
}

/** O dono pode sair deste grupo? O original nunca (o nome ainda vale pro legado). */
function podeSairDoGrupo(grupo, user) {
  if (!grupo || !user) return false;
  if (grupo.dono_id !== user.id) return true;
  return !(/pessoal/i.test(grupo.nome || '') || ehGrupoOriginal(grupo, user));
}

/** Pra onde a conta sem grupo volta: um dela, senão um em que participa. */
function escolherGrupo(proprios, participacoes) {
  const maisAntigo = (lista) => [...lista]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
  if (proprios && proprios.length) return maisAntigo(proprios).id;
  if (participacoes && participacoes.length) return maisAntigo(participacoes).grupo_id;
  return null;
}

// O painel dispara ~10 chamadas de uma vez: sem isto, cada uma criaria um grupo.
const emAndamento = new Map();

/**
 * Garante que a conta tem grupo ativo e devolve qual.
 * @param {{id:string, name?:string, grupo_ativo?:string|null}} user
 * @returns {Promise<{grupoId:string|null, criado:boolean}>}
 */
function garantirGrupoAtivo(user, deps = {}) {
  if (!user?.id) return Promise.resolve({ grupoId: null, criado: false });
  if (user.grupo_ativo) return Promise.resolve({ grupoId: user.grupo_ativo, criado: false });
  if (emAndamento.has(user.id)) return emAndamento.get(user.id);
  const p = resolver(user, deps).finally(() => emAndamento.delete(user.id));
  emAndamento.set(user.id, p);
  return p;
}

async function resolver(user, { supabase = require('../db/supabase') }) {
  // Leitura que falha NÃO cria grupo: criar às cegas daria um segundo espaço
  // vazio a quem só teve um soluço de rede.
  const [dono, membro] = await Promise.all([
    supabase.from('grupos').select('id, created_at').eq('dono_id', user.id),
    supabase.from('grupo_membros').select('grupo_id, created_at').eq('user_id', user.id),
  ]);
  if (dono.error || membro.error) return { grupoId: null, criado: false };

  const existente = escolherGrupo(dono.data, membro.data);
  if (existente) {
    const { data: gravou } = await supabase.from('users').update({ grupo_ativo: existente })
      .eq('id', user.id).is('grupo_ativo', null).select('id');
    if (!gravou?.length) return lerAtual(user.id, supabase);
    return { grupoId: existente, criado: false };
  }

  let nomeConta = user.name;
  if (!String(nomeConta || '').trim()) {
    const { data: linha } = await supabase.from('users').select('name').eq('id', user.id).maybeSingle();
    nomeConta = linha?.name;
  }
  const nome = String(nomeConta || '').trim() || 'você';
  const { data: novo, error } = await supabase.from('grupos')
    .insert({ nome: `Pessoal de ${nome}`, dono_id: user.id }).select('id').single();
  if (error || !novo) return { grupoId: null, criado: false };

  // A conta padrão antiga mora no grupo que ficou pra trás: mantê-la faria o
  // lançamento cair numa conta que não existe aqui.
  const { data: gravou } = await supabase.from('users')
    .update({ grupo_ativo: novo.id, wallet_padrao_id: null })
    .eq('id', user.id).is('grupo_ativo', null).select('id');
  if (!gravou?.length) {
    // Outro processo resolveu primeiro: desfaz o grupo vazio.
    await supabase.from('grupos').delete().eq('id', novo.id);
    return lerAtual(user.id, supabase);
  }
  // Mesmas categorias de uma conta nova; falhar aqui não tira o grupo de ninguém.
  try { await supabase.rpc('criar_categorias_padrao', { p_grupo_id: novo.id }); } catch (e) { console.warn('[grupo] categorias:', e.message); }
  try { await supabase.rpc('criar_categorias_extra', { p_grupo_id: novo.id }); } catch (e) { console.warn('[grupo] extras:', e.message); }
  console.warn('[grupo] conta sem grupo recebeu um novo:', user.id);
  return { grupoId: novo.id, criado: true };
}

async function lerAtual(userId, supabase) {
  const { data } = await supabase.from('users').select('grupo_ativo').eq('id', userId).maybeSingle();
  return { grupoId: data?.grupo_ativo || null, criado: false };
}

module.exports = { ehGrupoOriginal, podeSairDoGrupo, escolherGrupo, garantirGrupoAtivo };
