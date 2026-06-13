// =====================================================================
// Compartilhamento do Sora Grow — fonte única dos toggles por grupo.
//
// Abas pessoais (Hábitos, Saúde, Tarefas, Agenda, Bem-estar) são SEMPRE
// privadas (lidas por user_id). Casa + Coleções são opcionais: leem por
// grupo_id quando a flag do grupo está ligada, senão por user_id.
// Usado por routes/grow.js, handlers/grow.js e jobs/index.js.
// =====================================================================
const supabase = require('../db/supabase');

async function growShareCfg(grupoId) {
  try {
    const { data } = await supabase.from('grupos')
      .select('grow_compartilha_casa, grow_compartilha_viagens, grow_compartilha_midia, grow_compartilha_leituras')
      .eq('id', grupoId).maybeSingle();
    return {
      casa:     !!data?.grow_compartilha_casa,
      viagens:  !!data?.grow_compartilha_viagens,
      midia:    !!data?.grow_compartilha_midia,
      leituras: !!data?.grow_compartilha_leituras,
    };
  } catch { return { casa: false, viagens: false, midia: false, leituras: false }; }
}

module.exports = { growShareCfg };
