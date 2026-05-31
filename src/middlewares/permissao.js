// Middleware de permissão por papel no grupo ativo
// Uso: router.post('/', auth, exigirPermissao('admin', 'escrita'), handler)
const supabase = require('../db/supabase');
const norm = p => p?.replace(/\D/g, '');

function exigirPermissao(...papeisPermitidos) {
  return async (req, res, next) => {
   try {
    // Usa o usuário autenticado (do middleware auth), nunca o phone do request.
    const authUser = req.authUser;
    if (!authUser?.id) return res.status(401).json({ erro: 'Não autenticado.' });
    if (!authUser.grupoAtivo) return res.status(403).json({ erro: 'Você não tem um grupo ativo.' });

    const { data: membro } = await supabase.from('grupo_membros')
      .select('papel')
      .eq('grupo_id', authUser.grupoAtivo).eq('user_id', authUser.id).maybeSingle();

    // Fallback: se ainda não há grupo_membros mas o user é dono do grupo, assume admin
    let papel = membro?.papel;
    if (!papel) {
      const { data: grupo } = await supabase.from('grupos')
        .select('dono_id').eq('id', authUser.grupoAtivo).maybeSingle();
      if (grupo?.dono_id === authUser.id) papel = 'admin';
    }
    if (!papel) return res.status(403).json({ erro: 'Você não é membro deste grupo.' });

    if (!papeisPermitidos.includes(papel)) {
      return res.status(403).json({
        erro: `Permissão insuficiente. Seu papel: ${papel}. Necessário: ${papeisPermitidos.join(' ou ')}.`,
        codigo: 'PERMISSAO_INSUFICIENTE',
        papel,
      });
    }

    req.userPapel = papel;
    req.userId    = authUser.id;
    req.grupoId   = authUser.grupoAtivo;
    next();
   } catch (err) {
    console.error('[permissao] erro:', err.message);
    return res.status(500).json({ erro: 'Erro ao verificar permissão.' });
   }
  };
}

// Helper: descobre o papel do user sem bloquear (retorna 'leitura' como default seguro)
async function descobrirPapel(phone) {
  const norm_ = phone?.replace(/\D/g, '');
  if (!norm_) return null;
  const { data: user } = await supabase.from('users')
    .select('id, grupo_ativo').eq('phone', norm_).maybeSingle();
  if (!user?.grupo_ativo) return null;
  const { data: membro } = await supabase.from('grupo_membros')
    .select('papel').eq('grupo_id', user.grupo_ativo).eq('user_id', user.id).maybeSingle();
  if (membro?.papel) return { papel: membro.papel, userId: user.id, grupoId: user.grupo_ativo };
  const { data: grupo } = await supabase.from('grupos')
    .select('dono_id').eq('id', user.grupo_ativo).maybeSingle();
  if (grupo?.dono_id === user.id) return { papel: 'admin', userId: user.id, grupoId: user.grupo_ativo };
  return { papel: 'leitura', userId: user.id, grupoId: user.grupo_ativo };
}

module.exports = { exigirPermissao, descobrirPapel };
