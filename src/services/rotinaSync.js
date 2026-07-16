// =====================================================================
// Agenda → Planejamento Semanal.
//
// Quando a pessoa marca um compromisso ("reunião sábado 13h"), ele também
// aparece no card de rotina — mas como bloco PONTUAL:
//   • data_especifica = o dia do compromisso → vale só naquela semana,
//     não entra no template que se repete (é o "apenas uma vez").
//   • compromisso_id  = a origem → se o compromisso for sincronizado de novo,
//     não duplica.
//
// Tolerante por natureza: NUNCA pode quebrar a criação do compromisso. Se a
// migration 073 não rodou ou algo falha, só loga e segue.
// =====================================================================
const supabase = require('../db/supabase');

async function sincronizarCompromisso(c) {
  try {
    // Sem hora não há onde encaixar na grade (bloco "dia todo" fica só na Agenda).
    if (!c?.id || !c.data || !c.hora) return null;

    // Já sincronizado? → "apenas uma vez".
    const { data: ja } = await supabase.from('rotina_blocos')
      .select('id').eq('compromisso_id', c.id).maybeSingle();
    if (ja) return ja;

    const dataISO = String(c.data).slice(0, 10);
    // Meio-dia UTC evita o dia virar por fuso.
    const js  = new Date(dataISO + 'T12:00:00Z').getUTCDay(); // 0=dom
    const dia = js === 0 ? 7 : js;                            // 1=Seg … 7=Dom

    const { data, error } = await supabase.from('rotina_blocos').insert({
      grupo_id:        c.grupo_id,
      user_id:         c.user_id,
      dia_semana:      dia,
      hora:            String(c.hora).slice(0, 5),
      titulo:          String(c.titulo || 'Compromisso').slice(0, 60),
      cor:             c.cor || null,
      data_especifica: dataISO,
      compromisso_id:  c.id,
    }).select().single();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('[rotinaSync] não sincronizou o compromisso:', e.message);
    return null;
  }
}

module.exports = { sincronizarCompromisso };
