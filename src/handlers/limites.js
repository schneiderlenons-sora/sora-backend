const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/mensageiro');

// Normaliza nome de categoria pra casar transações ↔ limites (subcategoria conta
// pro limite da categoria-pai). Espelha o limpaCat de handlers/transacoes.js.
function limpaCat(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Linha "Nome: R$ gasto de R$ limite (pct%)" com bolinha de status por consumo.
function linhaLimite(nome, gasto, limite, extra = '') {
  const pct = limite > 0 ? Math.round((gasto / limite) * 100) : 0;
  const dot = pct >= 100 ? '🔴' : pct >= 80 ? '🟠' : '🟢';
  return `${dot} *${nome}:* R$ ${gasto.toFixed(2)} de R$ ${limite.toFixed(2)} (${pct}%)${extra}`;
}

module.exports = async function handleLimites(data, ctx) {
  const { phone, grupoId, user } = ctx;
  const mesRef = new Date().toISOString().slice(0,7);

  if (data.acao === 'set_limite') {
    const cat = data.categoria.charAt(0).toUpperCase() + data.categoria.slice(1).toLowerCase();
    await supabase.from('category_limits').upsert(
      { grupo_id: grupoId, categoria: cat, limite_mensal: data.valor, mes_referencia: mesRef },
      { onConflict: 'grupo_id,categoria,mes_referencia' }
    );
    await enviarTexto(phone, `🔔 Limite de *${cat}* definido: R$ ${parseFloat(data.valor).toFixed(2)}/mês.`);
    return;
  }

  if (data.acao === 'set_meta') {
    await supabase.from('users').update({ meta_mensal: data.valor }).eq('phone', phone);
    await enviarTexto(phone, `🎯 Meta mensal de gastos: *R$ ${parseFloat(data.valor).toFixed(2)}*.`);
    return;
  }

  if (data.acao === 'meus_limites') {
    // Janela do mês (fim = 1º dia do mês seguinte → evita dia inválido em fev/30)
    const [ay, am] = mesRef.split('-').map(Number);
    const prox = new Date(ay, am, 1);
    const fimMes = `${prox.getFullYear()}-${String(prox.getMonth() + 1).padStart(2, '0')}-01`;

    // Gastos do mês do grupo — base pra calcular quanto já foi gasto de cada limite
    const { data: gastosRows } = await supabase
      .from('transacoes').select('valor, categoria')
      .eq('grupo_id', grupoId).eq('tipo', 'Gasto')
      .gte('data', `${mesRef}-01`).lt('data', fimMes);
    const gastos = gastosRows || [];
    const gastoTotal = gastos.reduce((s, g) => s + (g.valor || 0), 0);

    // Limite GERAL (users.meta_mensal do grupo) — antes era ignorado aqui
    let metaGeral = 0, metaAtiva = true;
    try {
      const { data: u } = await supabase.from('users')
        .select('meta_mensal, meta_mensal_ativo')
        .eq('grupo_ativo', grupoId).limit(1).maybeSingle();
      metaGeral = u?.meta_mensal || 0;
      metaAtiva = u?.meta_mensal_ativo ?? true;
    } catch { /* tolerante */ }

    // Limites POR CATEGORIA do mês
    const { data: limitesRows } = await supabase.from('category_limits')
      .select('categoria, limite_mensal, ativo')
      .eq('grupo_id', grupoId).eq('mes_referencia', mesRef);
    const limitesCat = (limitesRows || []).filter(l => l.ativo !== false && l.limite_mensal);

    const temGeral = metaGeral > 0;
    if (!temGeral && !limitesCat.length) {
      await enviarTexto(phone,
        'Você ainda não tem limites definidos. 🙂\n' +
        'Crie um *limite geral* no painel, ou mande *"limite mercado 500"* pra um limite por categoria.');
      return;
    }

    // Categorias do grupo (subcategoria conta pro limite da categoria-pai)
    const { data: cats } = await supabase.from('categorias')
      .select('id, nome, parent_id').eq('grupo_id', grupoId);

    const linhas = [];
    if (temGeral) {
      linhas.push(linhaLimite('Geral (todos os gastos)', gastoTotal, metaGeral, metaAtiva ? '' : ' _(pausado)_'));
    }
    for (const lim of limitesCat) {
      const alvo = limpaCat(lim.categoria);
      const nomes = new Set([alvo]);
      const cat = (cats || []).find(c => limpaCat(c.nome) === alvo);
      if (cat) (cats || []).filter(c => c.parent_id === cat.id).forEach(c => nomes.add(limpaCat(c.nome)));
      const gastoCat = gastos
        .filter(g => nomes.has(limpaCat(g.categoria)))
        .reduce((s, g) => s + (g.valor || 0), 0);
      linhas.push(linhaLimite(lim.categoria, gastoCat, lim.limite_mensal));
    }

    await enviarTexto(phone,
      `📊 *Seus limites do mês:*\n\n${linhas.join('\n')}\n\n_O 1º valor é quanto você já gastou de cada limite._`);
    return;
  }
};
