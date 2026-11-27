// =============================================================================
// REPETIR a sincronização do Open Finance depois de uma falha do provedor.
//
// A Polp avisa por webhook quando TEM dado novo, o que pode levar horas. Se uma
// lista falhou (500/rede), a Sora tenta de novo sozinha: 10, 30 e 90 minutos.
// Em memória de propósito — num restart, o próximo webhook cobre.
// =============================================================================
const ESPERAS_MIN = [10, 30, 90];
const NOVA_SERIE_APOS_MS = 3 * 3600 * 1000;

function criarRepetidor({
  sincronizar, esperasMin = ESPERAS_MIN,
  agendar = setTimeout, cancelar = clearTimeout, agora = Date.now,
}) {
  const fila = new Map(); // id → { n, timer, ultima }

  function falhou(id) {
    let x = fila.get(id);
    // Série esgotada há muito tempo: uma falha nova começa outra.
    if (x && !x.timer && agora() - x.ultima > NOVA_SERIE_APOS_MS) x = null;
    if (!x) { x = { n: 0, timer: null, ultima: agora() }; fila.set(id, x); }
    x.ultima = agora();
    if (x.timer || x.n >= esperasMin.length) return false;
    const ms = esperasMin[x.n] * 60 * 1000;
    x.n += 1;
    x.timer = agendar(async () => {
      x.timer = null;
      try { await sincronizar(id); }
      catch (e) { console.warn(`[of] repetição do sync ${id} falhou:`, e.message); }
    }, ms);
    if (x.timer && x.timer.unref) x.timer.unref();   // não segura o processo
    return true;
  }

  function deuCerto(id) {
    const x = fila.get(id);
    if (x && x.timer) cancelar(x.timer);
    fila.delete(id);
  }

  return { falhou, deuCerto };
}

module.exports = { criarRepetidor, ESPERAS_MIN };
