const supabase = require('../db/supabase');

// Verifica se o usuário tem o plano exigido.
// Também checa plano_valido_ate: se expirado, trata como 'inativo' e
// atualiza a coluna em background (fire-and-forget) pra manter consistência.
function exigirPlano(...planosPermitidos) {
  return async (req, res, next) => {
    const phone = req.params.phone || req.body.phone || req.query.phone;
    if (!phone) return res.status(400).json({ erro: 'phone não informado' });

    const { data: user } = await supabase
      .from('users')
      .select('plano, plano_valido_ate')
      .eq('phone', phone.replace(/\D/g, ''))
      .single();

    if (!user) {
      return res.status(403).json({ erro: 'Usuário não encontrado' });
    }

    let planoAtual = user.plano;

    // Expira o plano automaticamente se valido_ate for passado
    if (planoAtual !== 'inativo' && user.plano_valido_ate) {
      if (new Date(user.plano_valido_ate) < new Date()) {
        planoAtual = 'inativo';
        // Atualiza em background sem bloquear a requisição
        supabase
          .from('users')
          .update({ plano: 'inativo' })
          .eq('phone', phone.replace(/\D/g, ''))
          .then(() => {})
          .catch(() => {});
      }
    }

    if (!planosPermitidos.includes(planoAtual)) {
      return res.status(403).json({
        erro: `Esta funcionalidade exige plano: ${planosPermitidos.join(' ou ')}`
      });
    }
    req.userPlano = planoAtual;
    next();
  };
}

module.exports = { exigirPlano };