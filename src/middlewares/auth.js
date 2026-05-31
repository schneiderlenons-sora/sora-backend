// Autenticação real do usuário via JWT do Supabase.
// Antes: um token compartilhado (x-api-token) que vinha no bundle do cliente
// → qualquer um chamava a API e acessava dados de qualquer telefone (IDOR).
// Agora: exige o access token do usuário logado, valida no Supabase e
// AMARRA o request ao próprio usuário (sobrescreve o phone informado).
const supabase = require('../db/supabase');

async function auth(req, res, next) {
  try {
    const header = req.headers['authorization'] || '';
    const jwt = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!jwt) return res.status(401).json({ erro: 'Não autenticado' });

    const { data: { user }, error } = await supabase.auth.getUser(jwt);
    if (error || !user) return res.status(401).json({ erro: 'Sessão inválida' });

    // Dados básicos do usuário (pra autorização por posse)
    const { data: row } = await supabase
      .from('users')
      .select('id, phone, grupo_ativo')
      .eq('id', user.id)
      .maybeSingle();

    req.authUser = {
      id:         user.id,
      phone:      row?.phone || null,
      grupoAtivo: row?.grupo_ativo || null,
    };

    // Anti-IDOR: rotas keyed por :phone na URL (ou ?phone=) resolvem o grupo
    // pelo telefone. Forçamos o telefone do PRÓPRIO usuário — bloqueia ler
    // dados de outra pessoa passando outro número. (body.phone NÃO é tocado:
    // ele é dado legítimo em algumas rotas, ex.: vincular WhatsApp / convite.)
    const phoneDoUsuario = req.authUser.phone || '__sem_phone__';
    if (req.params && Object.prototype.hasOwnProperty.call(req.params, 'phone')) {
      req.params.phone = phoneDoUsuario;
    }
    if (req.query && req.query.phone !== undefined) req.query.phone = phoneDoUsuario;

    next();
  } catch (e) {
    console.error('[auth] erro:', e.message);
    return res.status(401).json({ erro: 'Não autorizado' });
  }
}

module.exports = auth;
