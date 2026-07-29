const cron      = require('node-cron');
const supabase  = require('../db/supabase');
const { enviarTexto, enviarLink, enviarImagem } = require('../services/mensageiro');
const { criarPendente } = require('../services/pendentes');
const { avisosLigados, briefingLigado } = require('../services/avisos');
const { enviarProativo, provedor } = require('../services/proativo');
const yahooFinance    = require('yahoo-finance2').default;

// Gera ID curto de 6 caracteres
const gerarId = () => Math.random().toString(36).substring(2,8).toUpperCase();

// Colapsa quebras de linha/tab em espaço → parâmetro de template válido pra Meta
// (a Meta REJEITA parâmetro com \n; ver reference das regras de template).
const oneLine = (s) => String(s || '').replace(/\s*[\r\n\t]+\s*/g, ' ').trim();

// Atalho de LEMBRETE proativo: no Z-API vai o `texto` rico de sempre; na Meta
// (fora da janela de 24h) vai o template aprovado `lembretes_gerais` com `core`
// no {{1}} — SEMPRE em linha única (senão a Meta rejeita e o lembrete não chega).
// A escolha é do enviarProativo (via WHATSAPP_PROVIDER); no 'zapi' o texto rico
// de hoje é preservado.
const lembrete = (phone, texto, core) => enviarProativo(phone, {
  texto,
  // O template 'lembretes_gerais' tem cabeçalho de IMAGEM → a Meta EXIGE a capa
  // no header em todo envio (senão rejeita e o lembrete não chega). `CAPA` é
  // resolvido em tempo de chamada (o cron dispara após o módulo carregar).
  template: { name: 'lembretes_gerais', params: [oneLine(core || texto)], opts: { headerImage: CAPA } },
});

// Formata valor em BRL pros params de template (ex.: "R$ 1.240,00").
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Busca o telefone do dono de um grupo
async function phoneDono(grupoId) {
  const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', grupoId).single();
  if (!grupo) return null;
  const { data: user } = await supabase.from('users').select('phone').eq('id', grupo.dono_id).single();
  return user?.phone || null;
}

// Telefone do dono de um item pessoal (hábito/agenda/manutenção). Cai pro dono
// do grupo se o item ainda não tiver user_id (linhas antigas pré-migration 039).
async function phoneDoUser(userId, grupoId) {
  if (userId) {
    const { data: u } = await supabase.from('users').select('phone').eq('id', userId).maybeSingle();
    if (u?.phone) return u.phone;
  }
  return grupoId ? phoneDono(grupoId) : null;
}

// Busca o dono do grupo (id + phone) — preciso do id pra criar pendentes.
async function donoDoGrupo(grupoId) {
  const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', grupoId).single();
  if (!grupo) return null;
  const { data: user } = await supabase.from('users').select('id, phone').eq('id', grupo.dono_id).single();
  return user || null;
}

// Dono real de um item (cartão/recorrência) — {id, phone}. Cai pro dono do
// grupo se o item não tiver criado_por (linhas antigas / pré-migration).
async function donoDoItem(userId, grupoId) {
  if (userId) {
    const { data: u } = await supabase.from('users').select('id, phone').eq('id', userId).maybeSingle();
    if (u?.phone) return u;
  }
  return donoDoGrupo(grupoId);
}

// Envia o aviso de fatura (fechamento ou vencimento) e oferece o pagamento.
//
// Usa o MESMO caminho do "paguei a fatura" do WhatsApp (`oferecerDesconto` →
// pendente `descontar_destino`): lista as contas, debita a escolhida e registra
// em `pagamentos_fatura` com a competência certa. Antes criava um pendente
// `pagar_parcela_conta` que só marcava transações `pago=false` — que em cartão
// não existem, então respondia "Fatura paga! R$ 0,00".
async function avisarFatura({ titulo, ciclo, total, dono, cartao, competencia }) {
  const [, vm, vd] = ciclo.venc.split('-');
  const detalhe = `\n💵 Total: R$ ${total.toFixed(2)}`
    + `\n📅 Vence em ${vd}/${vm}`
    + (ciclo.porCiclo ? `\n🧾 Ciclo: ${ciclo.label}` : '');

  const { oferecerDesconto } = require('../services/descontoConta');
  const ofereceu = await oferecerDesconto({
    user: { id: dono.id }, phone: dono.phone, grupoId: cartao.grupo_id,
    valor: total,
    categoria: 'Fatura cartão',
    observacao: `Fatura ${cartao.nome}`,
    extra: { cartao_id: cartao.id, competencia },
    permiteExterno: true,          // a fatura pode ter sido paga por outra pessoa
    expiresInMin: 3 * 24 * 60,     // 3 dias — oferta de fatura não expira em 15min
    intro: `${titulo}${detalhe}\n\nCom qual conta você quer pagar?`,
  });

  // Sem conta cadastrada o oferecerDesconto não pergunta nada — avisa mesmo assim.
  if (!ofereceu) {
    await lembrete(dono.phone,
      `${titulo}${detalhe}\n\n` +
      `Você ainda não tem conta bancária cadastrada pra eu debitar — quando cadastrar, eu pago pra você.`);
  }
}

// Processa fechamento e vencimento das faturas dos cartões de crédito.
//
// O período é o CICLO REAL (services/cicloFatura) e o valor vem do
// statusFatura (fatura do ciclo − o que já foi pago). Antes somava transações
// com `pago=false`, mas gasto em cartão nasce `pago=true` → o total dava 0 e o
// aviso praticamente NUNCA saía. Também não dava pra detectar o fechamento de
// um cartão que fecha dia 31 em fevereiro (comparava o dia cru).
async function processarFaturas() {
  const { competenciaAtual, cicloPorCompetencia, hojeSP } = require('../services/cicloFatura');
  const faturaRoll = require('../services/faturaRollover');
  const hojeStr = hojeSP();   // fuso SP — `hoje.getDate()` em UTC virava o dia à noite

  // Traz todos os cartões com ciclo definido e decide em JS (o helper clampa o
  // dia ao último do mês, então fech=31 fecha em 28/02).
  const { data: cartoes } = await supabase.from('wallets')
    .select('id, nome, grupo_id, criado_por, saldo, of_conta_id, dia_fechamento, dia_vencimento, ultimo_aviso_fechamento, ultimo_aviso_vencimento')
    .eq('tipo', 'Crédito')
    .not('dia_fechamento', 'is', null);

  for (const c of cartoes || []) {
    const competencia = competenciaAtual(c, hojeStr);
    const ciclo = cicloPorCompetencia(c, competencia);
    const fecha = ciclo.fim  === hojeStr && c.ultimo_aviso_fechamento !== hojeStr;
    const vence = ciclo.venc === hojeStr && c.ultimo_aviso_vencimento !== hojeStr;
    if (!fecha && !vence) continue;

    // Valor a pagar: OF vem do banco (−saldo); manual = fatura do ciclo − pago.
    let total;
    if (c.of_conta_id && typeof c.saldo === 'number') {
      total = Math.max(0, faturaRoll.cent(-(c.saldo)));
    } else {
      const st = await faturaRoll.statusFatura(c.grupo_id, c, competencia);
      total = st.restante;
    }
    if (total <= 0) continue;

    // Aviso/cobrança da fatura vai pro DONO do cartão (não pro dono do grupo).
    const dono = await donoDoItem(c.criado_por, c.grupo_id);
    if (!dono?.phone) continue;
    if (!(await avisosLigados(dono.id))) continue; // kill-switch de avisos

    // Fechamento tem prioridade se cair no mesmo dia do vencimento.
    if (fecha) {
      await avisarFatura({
        titulo: `💳 *Fatura do ${c.nome} fechou*`,
        ciclo, total, dono, cartao: c, competencia,
      });
      await supabase.from('wallets').update({ ultimo_aviso_fechamento: hojeStr }).eq('id', c.id);
    } else if (vence) {
      // "Vence hoje" é responsabilidade do BRIEFING matinal (que lista o que
      // vence hoje). Se o usuário tem briefing ligado, não repetimos aqui; se
      // desligado, mandamos como fallback. Marca o dia dos dois jeitos pra não
      // reprocessar o cartão o dia todo.
      if (!(await briefingLigado(dono.id))) {
        await avisarFatura({
          titulo: `⏰ *Fatura do ${c.nome} vence hoje*`,
          ciclo, total, dono, cartao: c, competencia,
        });
      }
      await supabase.from('wallets').update({ ultimo_aviso_vencimento: hojeStr }).eq('id', c.id);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// JOB 1 — A cada hora: recorrências, lembretes, parcelas, fatura
// ─────────────────────────────────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  console.log('⏰ Processando tarefas agendadas...');
  const hoje      = new Date();
  const inicioHoje = new Date(hoje); inicioHoje.setHours(0,0,0,0);
  const fimHoje    = new Date(hoje); fimHoje.setHours(23,59,59,999);

  // ── 1A. RECORRÊNCIAS (contas/receitas fixas) — só de MANHÃ, no fuso SP ──
  // Antes rodava TODA hora e com data UTC: às 21h BR (já 00h UTC do dia seguinte)
  // disparava a VÉSPERA do dia agendado, e o previsto variável reavisava de hora
  // em hora (o "confirmar" tira o prefixo [Previsto] e quebrava o dedup antigo).
  // Agora: janela da manhã (8h–10h SP) + dia pelo fuso SP → cai na manhã do dia
  // certo; e o dedup do variável é por MÊS na própria recorrência (à prova de
  // confirmação/restart). Fixos e variáveis vão numa ÚNICA mensagem por telefone.
  const sp = agoraSP();                        // { dataStr:'YYYY-MM-DD', minutos }
  const horaSP = Math.floor(sp.minutos / 60);
  const ymSP   = sp.dataStr.slice(0, 7);       // 'YYYY-MM'
  if (horaSP >= 8 && horaSP <= 10) {
    const [ySP, mSP] = sp.dataStr.split('-').map(Number);
    const diaHojeSP  = mSP && sp.dataStr ? parseInt(sp.dataStr.slice(8, 10), 10) : 1;
    const diasNoMes  = new Date(ySP, mSP, 0).getDate();
    const diasAlvo   = [diaHojeSP];
    if (diaHojeSP === diasNoMes) for (let d = diaHojeSP + 1; d <= 31; d++) diasAlvo.push(d);

    const { data: recorrencias } = await supabase
      .from('recorrencias').select('*').in('dia_vencimento', diasAlvo).eq('ativa', true);

    // Acumula por telefone → UMA mensagem (fixos lançados + variáveis a confirmar).
    const porPhone = new Map(); // phone -> { lancados:[], confirmar:[] }
    const bucket = (p) => { if (!porPhone.has(p)) porPhone.set(p, { lancados: [], confirmar: [] }); return porPhone.get(p); };

    for (const rec of recorrencias || []) {
      // ── VARIÁVEL: valor muda (luz, água, vendas). Cria PREVISTO/pendente e pede
      // o valor real. Dedup por MÊS na recorrência (ultimo_previsto_ym) — imune ao
      // "confirmar" que remove o [Previsto].
      if (rec.valor_variavel) {
        if (rec.ultimo_previsto_ym === ymSP) continue; // já previsto este mês
        // Fallback pré-migration (coluna ausente): dedup pela observação do mês.
        if (rec.ultimo_previsto_ym === undefined) {
          const inicioMes = new Date(ySP, mSP - 1, 1).toISOString();
          const { data: jaP } = await supabase.from('transacoes').select('id')
            .eq('grupo_id', rec.grupo_id).eq('observacao', `[Previsto] ${rec.descricao}`)
            .gte('data', inicioMes).limit(1);
          if (jaP && jaP.length) continue;
        }
        await supabase.from('transacoes').insert({
          id_curto: gerarId(), grupo_id: rec.grupo_id, tipo: rec.tipo,
          categoria: rec.categoria || 'Outros', valor: rec.valor || 0,
          observacao: `[Previsto] ${rec.descricao}`, carteira_nome: rec.carteira || 'Dinheiro',
          pago: false, data: new Date().toISOString(),
        });
        try { await supabase.from('recorrencias').update({ ultimo_previsto_ym: ymSP }).eq('id', rec.id); } catch {}
        const phoneP = await phoneDoUser(rec.criado_por, rec.grupo_id);
        if (phoneP && await avisosLigados(rec.criado_por)) {
          bucket(phoneP).confirmar.push({ descricao: rec.descricao, valor: rec.valor, tipo: rec.tipo });
        }
        continue;
      }

      // ── FIXO: lança automaticamente. Dedup por transação já lançada hoje.
      const { data: jaLancado } = await supabase.from('transacoes').select('id')
        .eq('grupo_id', rec.grupo_id).eq('categoria', rec.categoria).eq('valor', rec.valor)
        .gte('data', inicioHoje.toISOString()).lte('data', fimHoje.toISOString()).maybeSingle();
      if (jaLancado) continue;

      const idCurto = gerarId();
      await supabase.from('transacoes').insert({
        id_curto: idCurto, grupo_id: rec.grupo_id, tipo: rec.tipo,
        categoria: rec.categoria || 'Outros', valor: rec.valor,
        observacao: `[Recorrente] ${rec.descricao}`, carteira_nome: rec.carteira || 'Dinheiro',
        pago: true, data: new Date().toISOString(),
      });
      const { data: wallet } = await supabase.from('wallets')
        .select('id, saldo').eq('grupo_id', rec.grupo_id).ilike('nome', rec.carteira || 'Dinheiro').maybeSingle();
      if (wallet) {
        const mult = rec.tipo === 'Gasto' ? -1 : 1;
        await supabase.from('wallets').update({ saldo: wallet.saldo + (rec.valor * mult) }).eq('id', wallet.id);
      }
      const phone = await phoneDoUser(rec.criado_por, rec.grupo_id);
      if (phone && await avisosLigados(rec.criado_por)) {
        bucket(phone).lancados.push({ descricao: rec.descricao, valor: rec.valor, tipo: rec.tipo, idCurto });
      }
    }

    // UMA mensagem por telefone: o que a Sora lançou + o que falta confirmar.
    const money = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    for (const [phone, { lancados, confirmar }] of porPhone) {
      if (!lancados.length && !confirmar.length) continue;
      const partes = [];
      if (lancados.length) {
        partes.push('✅ *Lancei automaticamente:*');
        for (const it of lancados) partes.push(`${it.tipo === 'Gasto' ? '🔴' : '🟢'} ${it.descricao} — R$ ${money(it.valor)}`);
      }
      if (confirmar.length) {
        if (partes.length) partes.push('');
        partes.push('💡 *A confirmar o valor* (responda *confirmar <nome> <valor>*):');
        for (const it of confirmar) partes.push(`• ${it.descricao} — estimei R$ ${money(it.valor)}`);
      }
      // Texto rico (Z-API / dentro da janela). Fora da janela vira o `core`
      // de uma linha só (template da Meta não aceita quebra de linha no param).
      if (confirmar.length) {
        const exC = confirmar[0];
        const exVal = exC.valor ? Number(exC.valor).toFixed(2).replace('.', ',') : '1890,54';
        partes.push('', `_Ex.: *confirmar ${exC.descricao.toLowerCase()} ${exVal}* — ou edite direto nas suas transações no painel._ 😉`);
      }
      const txt = `🔁 *Recorrências de hoje*\n\n${partes.join('\n')}`;

      // LISTA dos itens (SEM instrução) — vira o {{1}} do template dedicado
      // (a instrução de confirmar já está no CORPO FIXO do template).
      const listaSegs = [];
      if (lancados.length) listaSegs.push(`✅ Lancei: ${lancados.map(it => `${it.descricao} R$ ${money(it.valor)}`).join(', ')}`);
      if (confirmar.length) listaSegs.push(`💡 A confirmar o valor: ${confirmar.map(it => `${it.descricao} (estimei R$ ${money(it.valor)})`).join(', ')}`);
      const listaParam = listaSegs.join('. ');

      // `core` (fallback lembretes_gerais, linha única) — lista + a instrução de
      // confirmar, porque esse template genérico não tem corpo fixo.
      let core = `🔁 Recorrências de hoje. ${listaParam}.`;
      if (confirmar.length) {
        const ex = confirmar[0];
        const exVal = ex.valor ? Number(ex.valor).toFixed(2).replace('.', ',') : '1890,54';
        core += ` Responda "confirmar <nome> <valor>" (ex: confirmar ${ex.descricao.toLowerCase()} ${exVal}) — ou edite nas suas transações no painel.`;
      }

      // Com algo a confirmar, tenta o template dedicado `recorrencias_hoje`
      // (texto fixo bonito + botão "Abrir transações"); {{1}} = só a LISTA. Se
      // ainda não foi aprovado na Meta, o envio falha e caímos no `lembretes_gerais`
      // (core). Assim dá pra subir antes da aprovação e ele "liga" ao aprovar.
      let entregue = false;
      if (confirmar.length && provedor() === 'meta') {
        entregue = await enviarProativo(phone, {
          template: { name: 'recorrencias_hoje', params: [listaParam], opts: { headerImage: CAPA } },
        });
      }
      if (!entregue) await lembrete(phone, txt, core);
    }
  }

  // ── 1B. LEMBRETES ───────────────────────────────────────────────
  const { data: lembretes } = await supabase
    .from('lembretes')
    .select('*')
    .eq('ativo', true)
    .eq('enviado', false)
    .lte('data_vencimento', fimHoje.toISOString());

  for (const lem of lembretes || []) {
    const phone = await phoneDoUser(lem.criado_por, lem.grupo_id);
    if (phone && await avisosLigados(lem.criado_por)) {
      const txt =
        `🔔 *LEMBRETE:*\n` +
        `${lem.tipo === 'pagar' ? '💸 Pagar' : '💰 Receber'} *${lem.descricao}*\n` +
        `Valor: R$ ${(lem.valor||0).toFixed(2)}\n` +
        `Vencimento: ${new Date(lem.data_vencimento).toLocaleDateString('pt-BR')}`;
      const core =
        `${lem.tipo === 'pagar' ? '💸 Pagar' : '💰 Receber'} *${lem.descricao}* — R$ ${(lem.valor||0).toFixed(2)}\n` +
        `Vencimento: ${new Date(lem.data_vencimento).toLocaleDateString('pt-BR')}`;
      await lembrete(phone, txt, core);
    }
    await supabase.from('lembretes').update({ enviado: true }).eq('id', lem.id);
  }

  // ── 1C. PARCELAS VENCENDO ───────────────────────────────────────
  const { data: parcelas } = await supabase
    .from('parcelas')
    .select('*')
    .eq('ativa', true)
    .lte('data_proxima_vencimento', fimHoje.toISOString());

  for (const p of parcelas || []) {
    if (p.parcelas_pagas >= p.total_parcelas) continue;
    const phone = await phoneDoUser(p.criado_por, p.grupo_id);
    if (phone && await avisosLigados(p.criado_por)) {
      const txt =
        `🔔 *PARCELA VENCE HOJE:*\n` +
        `📦 ${p.descricao} — ${p.parcelas_pagas + 1}/${p.total_parcelas}\n` +
        `💵 R$ ${p.valor_parcela.toFixed(2)} no cartão *${p.carteira}*\n\n` +
        `Para pagar: "pagar parcela da ${p.descricao}"`;
      const core =
        `📦 *Parcela vence hoje:* ${p.descricao} — ${p.parcelas_pagas + 1}/${p.total_parcelas}\n` +
        `💵 R$ ${p.valor_parcela.toFixed(2)} no cartão *${p.carteira}*\n` +
        `Pra pagar, responda: "pagar parcela da ${p.descricao}"`;
      await lembrete(phone, txt, core);
    }
  }

  // ── 1D. FATURA DOS CARTÕES (fechamento + vencimento) ────────────
  // Por cartão: avisa quando fecha e quando vence, oferecendo pagar
  // (debita a conta escolhida e libera o limite). Ver processarFaturas.
  try {
    await processarFaturas();
  } catch (e) {
    console.warn('[jobs] processarFaturas falhou:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────
// JOB 1F — A cada 15 min: lembretes de MEDICAMENTOS
// Verifica horários cadastrados e envia WhatsApp.
// Dedup em memória (lembretesMedHoje) — reseta à meia-noite.
// ─────────────────────────────────────────────────────────────────
const lembretesMedHoje = new Set();
let diaResetMed = ''; // preenchido no 1º tick com a data de São Paulo

// A CADA MINUTO (não */15): remédio é horário-crítico, o usuário espera o aviso
// no minuto exato que cadastrou. Os outros lembretes (hábitos/briefing) toleram
// ±15 min; este não. Query leve (filtrada por ativo+lembrete_ativo) → ok rodar
// de minuto em minuto.
cron.schedule('* * * * *', async () => {
  // ⚠️ Fuso de São Paulo, NÃO o do servidor (Render roda em UTC). Usar
  // agora.getHours() disparava o remédio 3h adiantado — um remédio das 16:00
  // caía às 16:00 UTC = 13:00 em SP, e o usuário nunca recebia no horário.
  // Mesma correção já aplicada aos outros crons (hábitos, briefing, etc.).
  const sp = agoraSP();
  if (sp.dataStr !== diaResetMed) {
    lembretesMedHoje.clear();
    diaResetMed = sp.dataStr;
  }
  const diaSemana = sp.diaSemana;   // 1=seg ... 7=dom (fuso SP)
  const minutosAgora = sp.minutos;

  const { data: meds } = await supabase
    .from('medicamentos')
    .select('id, grupo_id, user_id, nome, dosagem, horarios, dias_semana, estoque_atual, estoque_alerta, lembrete_ativo')
    .eq('ativo', true)
    .eq('lembrete_ativo', true);

  for (const med of meds || []) {
    if (!med.dias_semana?.includes(diaSemana)) continue;
    if (!med.horarios?.length) continue;

    for (const h of med.horarios) {
      const [hh, mm] = String(h).split(':').map(Number);
      const minHorario = hh * 60 + mm;
      const diff = minutosAgora - minHorario;
      // Janela de 2 min: dispara no minuto EXATO do horário; o +1 é resiliência
      // se o tick do minuto certo tiver sido perdido (restart/carga). A dedup
      // (lembretesMedHoje) garante 1 envio só, então os 2 minutos não duplicam.
      if (diff < 0 || diff >= 2) continue;

      const key = `${med.id}|${h}|${sp.dataStr}`;
      if (lembretesMedHoje.has(key)) continue;

      const { data: user } = await supabase.from('users').select('phone').eq('id', med.user_id).single();
      if (!user?.phone) continue;
      if (!(await avisosLigados(med.user_id))) continue; // kill-switch

      const estoqueAviso = med.estoque_atual != null && med.estoque_atual <= (med.estoque_alerta || 5)
        ? `\n⚠️ Estoque baixo: ${med.estoque_atual} restantes`
        : '';
      const txt =
        `💊 *Hora de tomar ${med.nome}* ${med.dosagem || ''}\n` +
        `Quando tomar, responda *tomei ${med.nome}* pra eu marcar.${estoqueAviso}`;
      await lembrete(user.phone, txt,
        `💊 *Hora de tomar ${med.nome}* ${med.dosagem || ''} — quando tomar, responda *tomei ${med.nome}*.${estoqueAviso}`);
      lembretesMedHoje.add(key);
      console.log(`💊 Lembrete med enviado: ${med.nome} → ${user.phone}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// JOB 1H — A cada 15 min: lembrete DIÁRIO de HÁBITOS (opt-in)
// Só lembra quem ativou no painel, no horário escolhido (fuso SP), e só
// se ainda houver hábitos pendentes hoje. Dedup persistido (à prova de
// restart) via users.habito_lembrete_ultimo.
// ─────────────────────────────────────────────────────────────────

// Hora/data/dia-da-semana atuais no fuso de São Paulo (o servidor pode
// estar em UTC; o horário escolhido pelo usuário é local).
function agoraSP() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => partes.find((x) => x.type === t)?.value;
  const wd = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0; // alguns ambientes retornam '24' à meia-noite
  const mm = parseInt(get('minute'), 10);
  return {
    diaSemana: wd[get('weekday')],
    dataStr: `${get('year')}-${get('month')}-${get('day')}`,
    minutos: hh * 60 + mm,
  };
}

cron.schedule('*/15 * * * *', async () => {
  const sp = agoraSP();

  const { data: usuarios } = await supabase.from('users')
    .select('id, phone, grupo_ativo, habito_lembrete_horario, habito_lembrete_ultimo')
    .eq('habito_lembrete_ativo', true)
    .not('habito_lembrete_horario', 'is', null);

  for (const u of usuarios || []) {
    if (!u.phone || !u.grupo_ativo) continue;
    if (u.habito_lembrete_ultimo === sp.dataStr) continue; // já processado hoje

    const [hh, mm] = String(u.habito_lembrete_horario).split(':').map(Number);
    if (isNaN(hh)) continue;
    if (sp.minutos < hh * 60 + mm) continue; // ainda não chegou o horário
    if (!(await avisosLigados(u.id))) continue; // kill-switch de avisos

    // Marca como processado ANTES de enviar — evita duplicar se reiniciar.
    await supabase.from('users').update({ habito_lembrete_ultimo: sp.dataStr }).eq('id', u.id);

    const { data: habitos } = await supabase.from('habitos')
      .select('id, dias_semana').eq('user_id', u.id).eq('ativo', true);
    const doDia = (habitos || []).filter(h => (h.dias_semana || [1,2,3,4,5,6,7]).includes(sp.diaSemana));
    if (!doDia.length) continue; // nada programado pra hoje

    const { data: regs } = await supabase.from('registros_habito')
      .select('habito_id, concluido').eq('user_id', u.id).eq('data', sp.dataStr);
    const feitos = new Set((regs || []).filter(r => r.concluido).map(r => r.habito_id));
    const pendentes = doDia.filter(h => !feitos.has(h.id)).length;
    if (pendentes === 0) continue; // tudo feito — não precisa lembrar

    const txt =
      `🎯 *Lembrete de hábitos*\n\n` +
      `Você ainda tem *${pendentes}* hábito${pendentes === 1 ? '' : 's'} pra marcar hoje. Bora fechar o dia? 💪\n\n` +
      `Responda *fiz todos* que eu marco todos de uma vez — ou abra o painel:\n` +
      `🌐 https://www.forsora.com/grow/habitos`;
    await lembrete(u.phone, txt,
      `🎯 Você ainda tem *${pendentes}* hábito${pendentes === 1 ? '' : 's'} pra marcar hoje. Bora fechar o dia? 💪 Responda *fiz todos* que eu marco tudo.`);
    console.log(`🎯 Lembrete de hábitos → ${u.phone} (${pendentes} pendentes)`);
  }
});

// ─────────────────────────────────────────────────────────────────
// JOB 1G-B — Versículo do dia da BÍBLIA (opt-in por WhatsApp)
// ~07:00 (fuso SP). Só quem ativou (biblia_versiculo_ativo). Dedup por data
// (biblia_versiculo_em). Reusa o template lembretes_gerais (sem template novo).
// ─────────────────────────────────────────────────────────────────
const { versiculoDoDia } = require('../data/biblia');

cron.schedule('*/15 * * * *', async () => {
  const sp = agoraSP();
  if (sp.minutos < 7 * 60) return; // só a partir das 07:00 SP

  const { data: usuarios } = await supabase.from('users')
    .select('id, phone')
    .eq('biblia_versiculo_ativo', true);

  for (const u of usuarios || []) {
    if (!u.phone) continue;
    // dedup do dia — tolerante caso a coluna não exista (migration 081).
    try {
      const { data } = await supabase.from('users').select('biblia_versiculo_em').eq('id', u.id).maybeSingle();
      if (data?.biblia_versiculo_em === sp.dataStr) continue;
    } catch { /* sem coluna → segue */ }
    if (!(await avisosLigados(u.id))) continue;

    await supabase.from('users').update({ biblia_versiculo_em: sp.dataStr }).eq('id', u.id);

    const v = versiculoDoDia();
    const txt = `📖 *Versículo do dia*\n\n_"${v.texto}"_\n\n*${v.ref}*\n\nUm bom dia na Palavra! 🙏\n_(Pra parar: *desativar versículo diário*.)_`;
    await lembrete(u.phone, txt, `📖 Versículo do dia — "${v.texto}" (${v.ref}) 🙏`);
    console.log(`📖 Versículo do dia → ${u.phone}`);
  }
});

// ─────────────────────────────────────────────────────────────────
// JOB 1I — Todo dia às 09:00: lembretes de MANUTENÇÕES da casa (opt-in)
// Avisa quando a manutenção vence (próxima = última + frequência). Re-cutuca
// no máximo 1x por semana enquanto continuar pendente. Dedup persistido.
// ─────────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('🔧 Processando lembretes de manutenções...');
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const hojeStr = hoje.toISOString().slice(0, 10);

  const { data: mans } = await supabase.from('manutencoes')
    .select('id, grupo_id, user_id, nome, icone, frequencia_dias, ultima_data, lembrete_ultimo')
    .eq('lembrete_ativo', true);

  for (const m of mans || []) {
    let proxima;
    if (m.ultima_data) {
      proxima = new Date(m.ultima_data + 'T12:00:00');
      proxima.setDate(proxima.getDate() + (m.frequencia_dias || 90));
    } else {
      proxima = new Date(hoje); // nunca feita → já está na hora
    }
    proxima.setHours(0, 0, 0, 0);
    if (proxima > hoje) continue; // ainda não venceu

    // re-cutuca no máximo 1x por semana
    if (m.lembrete_ultimo) {
      const ult = new Date(m.lembrete_ultimo + 'T12:00:00');
      if (Math.round((hoje - ult) / 86400000) < 7) continue;
    }

    const phone = await phoneDoUser(m.user_id, m.grupo_id);
    if (!phone) continue;
    if (!(await avisosLigados(m.user_id))) continue; // kill-switch

    const diasAtraso = Math.round((hoje - proxima) / 86400000);
    const quando = diasAtraso <= 0 ? 'hoje' : `há ${diasAtraso} dia${diasAtraso === 1 ? '' : 's'}`;
    const txt =
      `🔧 *Manutenção: ${m.icone || ''} ${m.nome}*\n\n` +
      `${m.ultima_data ? `Tá na hora — venceu ${quando}.` : 'Você ainda não registrou essa manutenção.'}\n\n` +
      `Quando fizer, responda *fiz a manutenção ${m.nome}* que eu marco e reprogramo a próxima.`;
    await lembrete(phone, txt,
      `🔧 *Manutenção: ${m.icone || ''} ${m.nome}* — ${m.ultima_data ? `venceu ${quando}` : 'ainda não registrada'}. Quando fizer, responda *fiz a manutenção ${m.nome}*.`);
    await supabase.from('manutencoes').update({ lembrete_ultimo: hojeStr }).eq('id', m.id);
    console.log(`🔧 Lembrete manutenção → ${phone}: ${m.nome}`);
  }
});

// ─────────────────────────────────────────────────────────────────
// JOB 1J — A cada 15 min: lembretes de COMPROMISSOS da agenda (opt-in)
// Dispara no momento certo respeitando a antecedência (na hora / 10min /
// 1h / 1 dia antes). Eventos "dia todo" (sem hora) usam 09:00 como base.
// Dedup persistido via compromissos.lembrete_enviado.
// ─────────────────────────────────────────────────────────────────
function diasEpoch(dataStr) {
  const [y, mo, d] = dataStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
}

cron.schedule('*/15 * * * *', async () => {
  const sp = agoraSP();
  const hojeEpoch = diasEpoch(sp.dataStr);
  const nowMin = hojeEpoch * 1440 + sp.minutos;

  // Só os de hoje/ontem/amanhã com lembrete pendente (janela suficiente p/ "1 dia antes")
  const ontem   = new Date(); ontem.setDate(ontem.getDate() - 1);
  const amanha2 = new Date(); amanha2.setDate(amanha2.getDate() + 2);
  const { data: comps } = await supabase.from('compromissos')
    .select('id, grupo_id, user_id, titulo, hora, local, data, lembrete_antecedencia')
    .eq('lembrete_ativo', true).eq('lembrete_enviado', false)
    .gte('data', ontem.toISOString().slice(0, 10))
    .lte('data', amanha2.toISOString().slice(0, 10));

  for (const c of comps || []) {
    const [hh, mm] = c.hora ? String(c.hora).split(':').map(Number) : [9, 0];
    const eventMin = diasEpoch(c.data) * 1440 + (hh * 60 + (mm || 0));
    const triggerMin = eventMin - (Number.isInteger(c.lembrete_antecedencia) ? c.lembrete_antecedencia : 60);

    // Evento já passou (>1h) → marca enviado pra parar de checar
    if (nowMin >= eventMin + 60) {
      await supabase.from('compromissos').update({ lembrete_enviado: true }).eq('id', c.id);
      continue;
    }
    if (nowMin < triggerMin) continue; // ainda não chegou a hora de avisar

    const phone = await phoneDoUser(c.user_id, c.grupo_id);
    if (!phone) continue;
    if (!(await avisosLigados(c.user_id))) continue; // kill-switch (não marca enviado p/ reativar depois)

    await supabase.from('compromissos').update({ lembrete_enviado: true }).eq('id', c.id);
    const quando = c.hora ? `hoje às ${c.hora}` : 'hoje';
    const txt =
      `📅 *Lembrete de compromisso*\n\n` +
      `*${c.titulo}*\n🕐 ${quando}${c.local ? `\n📍 ${c.local}` : ''}\n\n` +
      `Ver agenda: 🌐 https://www.forsora.com/grow/agenda`;
    await lembrete(phone, txt,
      `📅 *${c.titulo}* — ${quando}${c.local ? ` · 📍 ${c.local}` : ''}`);
    console.log(`📅 Lembrete compromisso → ${phone}: ${c.titulo}`);
  }
});

// ─────────────────────────────────────────────────────────────────
// JOB 1K — A cada 15 min: BRIEFING MATINAL da agenda (opt-in)
// No horário escolhido, manda uma mensagem com TUDO de hoje, agregado de
// todos os módulos (compromissos, consultas, contas/faturas, manutenções).
// Só envia se houver algo hoje. Dedup persistido via agenda_briefing_ultimo.
// ─────────────────────────────────────────────────────────────────
const { montarFeed } = require('../services/agendaFeed');
const { growShareCfg } = require('../services/growShare');
const EMOJI_AGENDA = { compromisso: '📌', consulta: '🩺', recorrencia: '💰', divida: '💳', fatura: '💳', fechamento: '🧾', manutencao: '🔧' };

cron.schedule('*/15 * * * *', async () => {
  const sp = agoraSP();

  const { data: usuarios } = await supabase.from('users')
    .select('id, name, phone, grupo_ativo, agenda_briefing_horario, agenda_briefing_ultimo')
    .eq('agenda_briefing_ativo', true)
    .not('agenda_briefing_horario', 'is', null);

  for (const u of usuarios || []) {
    if (!u.phone || !u.grupo_ativo) continue;
    if (u.agenda_briefing_ultimo === sp.dataStr) continue; // já enviou hoje

    const [hh, mm] = String(u.agenda_briefing_horario).split(':').map(Number);
    if (isNaN(hh)) continue;
    if (sp.minutos < hh * 60 + mm) continue; // ainda não chegou o horário
    if (!(await avisosLigados(u.id))) continue; // kill-switch de avisos

    // Marca ANTES de enviar — evita duplicar em restart
    await supabase.from('users').update({ agenda_briefing_ultimo: sp.dataStr }).eq('id', u.id);

    const cfg = await growShareCfg(u.grupo_ativo);
    const eventos = await montarFeed(u.grupo_ativo, sp.dataStr, sp.dataStr, { userId: u.id, casaCompartilhada: cfg.casa, paraBriefing: true });
    if (!eventos.length) continue; // nada hoje — não enche o saco

    eventos.sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
    const linhas = eventos.map(e => {
      const h = e.hora ? `*${e.hora}*` : '•';
      const val = e.valor != null ? ` (R$ ${Number(e.valor).toFixed(2)})` : '';
      return `${EMOJI_AGENDA[e.source] || '•'} ${h} ${e.titulo}${val}`;
    });
    const dataFmt = new Date(sp.dataStr + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    const txt =
      `☀️ *Bom dia!*\nSua agenda de hoje (${dataFmt}):\n\n${linhas.join('\n')}\n\n` +
      `Tenha um ótimo dia! 💜`;
    // Param {{2}} do template em LINHA ÚNICA — a Meta rejeita \n no parâmetro (era
    // por isso que o briefing não chegava). Junta os eventos com " · ".
    const resumo = oneLine(linhas.join('  ·  ')).slice(0, 900);
    await enviarProativo(u.phone, {
      texto: txt,
      // 'briefing_matinal' tem cabeçalho de IMAGEM → manda a capa no header.
      template: { name: 'briefing_matinal', params: [(u.name || 'tudo bem').split(' ')[0], resumo], opts: { headerImage: CAPA } },
    });
    console.log(`☀️ Briefing → ${u.phone} (${eventos.length} itens)`);
  }
});

// ─────────────────────────────────────────────────────────────────
// JOB 1G — Todo dia às 09:00: lembretes de CONSULTAS (24h antes)
// E retornos médicos próximos (7 dias)
// ─────────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('🩺 Processando lembretes de consultas...');
  const hoje = new Date();
  const amanha = new Date(hoje); amanha.setDate(amanha.getDate() + 1);
  const amanhaStr = amanha.toISOString().slice(0, 10);
  const em7d = new Date(hoje); em7d.setDate(em7d.getDate() + 7);
  const em7dStr = em7d.toISOString().slice(0, 10);

  // Consultas de amanhã com lembrete ativo
  const { data: consultas } = await supabase
    .from('consultas').select('id, grupo_id, user_id, profissional, especialidade, data, hora, local')
    .eq('status', 'agendada').eq('lembrete_ativo', true).eq('data', amanhaStr);

  for (const c of consultas || []) {
    const { data: user } = await supabase.from('users').select('phone').eq('id', c.user_id).single();
    if (!user?.phone) continue;
    if (!(await avisosLigados(c.user_id))) continue; // kill-switch
    const partes = [
      `📅 *Lembrete: consulta amanhã*`,
      ``,
      `🩺 ${c.especialidade || c.profissional || 'Consulta'}`,
    ];
    if (c.profissional && c.especialidade) partes.push(`👨‍⚕️ ${c.profissional}`);
    if (c.hora) partes.push(`⏰ ${c.hora.slice(0,5)}`);
    if (c.local) partes.push(`📍 ${c.local}`);
    const txt = partes.join('\n');
    await lembrete(user.phone, txt,
      `📅 *Consulta amanhã:* ${c.especialidade || c.profissional || 'Consulta'}${c.hora ? ` às ${c.hora.slice(0,5)}` : ''}${c.local ? ` · 📍 ${c.local}` : ''}`);
  }

  // Retornos médicos pra próximos 7 dias (avisa só uma vez quando faltar exatamente 7d)
  const { data: retornos } = await supabase
    .from('consultas').select('id, user_id, especialidade, profissional, retorno_data')
    .not('retorno_data', 'is', null).eq('retorno_data', em7dStr);

  for (const r of retornos || []) {
    const { data: user } = await supabase.from('users').select('phone').eq('id', r.user_id).single();
    if (!user?.phone) continue;
    if (!(await avisosLigados(r.user_id))) continue; // kill-switch
    const txt = `📆 *Retorno em 7 dias*\n\nSeu retorno com ${r.especialidade || r.profissional || 'profissional'} é em uma semana.\nQuer agendar pelo painel?`;
    await lembrete(user.phone, txt,
      `📆 *Retorno em 7 dias:* seu retorno com ${r.especialidade || r.profissional || 'profissional'} é em uma semana. Quer agendar?`);
  }
  console.log('✅ Lembretes de consultas processados.');
});

// ─────────────────────────────────────────────────────────────────
// JOB 1E — Todo dia às 09:00: lembretes de dívidas
// Avisa 3 dias antes, no dia, e quando atrasado
// ─────────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('🔔 Processando lembretes de dívidas...');
  const hoje = new Date();
  const hojeStr = hoje.toISOString().slice(0, 10);
  const diaHoje = hoje.getDate();

  // Busca todas as dívidas ativas com lembrete ligado e dia_vencimento definido
  const { data: dividas } = await supabase
    .from('dividas')
    .select('id, grupo_id, titulo, credor, valor_parcela, parcelas_total, parcelas_pagas, dia_vencimento, data_inicio, ultimo_lembrete_em')
    .in('status', ['ativa', 'em_atraso'])
    .eq('lembretes_ativos', true)
    .not('dia_vencimento', 'is', null);

  for (const d of dividas || []) {
    // Não envia duas vezes no mesmo dia
    if (d.ultimo_lembrete_em === hojeStr) continue;

    // Calcula próximo vencimento
    const venc = new Date(hoje.getFullYear(), hoje.getMonth(), d.dia_vencimento);
    if (d.dia_vencimento < diaHoje) venc.setMonth(venc.getMonth() + 1);
    // 1ª parcela nunca vence no mês da compra: se o venc cair em/antes do
    // data_inicio, pula pro mês seguinte (não lembra parcelado no dia da compra).
    if (d.data_inicio && venc.getTime() <= new Date(d.data_inicio + 'T00:00:00').getTime()) {
      venc.setMonth(venc.getMonth() + 1);
    }
    const diffDias = Math.round((venc - new Date(hoje.getFullYear(), hoje.getMonth(), diaHoje)) / 86400000);

    // Janelas: 3 dias antes, no dia, ou atrasada (>=1 dia depois do venc do mês passado)
    let mensagem = null;
    let venceHoje = false;
    if (diffDias === 3) {
      mensagem = `🔔 *Lembrete de dívida*\n\n📌 *${d.titulo}*${d.credor ? ` (${d.credor})` : ''}\n💵 ${d.valor_parcela ? `R$ ${d.valor_parcela.toFixed(2)}` : ''}\n📅 Vence em *3 dias* (dia ${d.dia_vencimento})\n\nPara pagar: *pagar divida ${d.titulo} ${d.valor_parcela?.toFixed(2) || ''}*\nPra parar de receber: *cancelar lembrete divida ${d.titulo}*`;
    } else if (diffDias === 0) {
      venceHoje = true; // o "vence hoje" é do briefing; aqui só se briefing off (ver abaixo)
      mensagem = `🚨 *VENCE HOJE*\n\n📌 *${d.titulo}*${d.credor ? ` (${d.credor})` : ''}\n💵 ${d.valor_parcela ? `R$ ${d.valor_parcela.toFixed(2)}` : 'sem valor de parcela'}\n\nNão esqueça! Para pagar: *pagar divida ${d.titulo} ${d.valor_parcela?.toFixed(2) || ''}*`;
    } else {
      // Atrasada: vencimento foi no mês anterior (diffDias > 25 significa que rolou pro proximo mes)
      // Detecta atraso: se o vencimento ESTE mes já passou e nao houve pagamento desde entao
      const vencEsteMes = new Date(hoje.getFullYear(), hoje.getMonth(), d.dia_vencimento);
      const diasAtraso = Math.round((new Date(hoje.getFullYear(), hoje.getMonth(), diaHoje) - vencEsteMes) / 86400000);
      if (diasAtraso > 0 && diasAtraso <= 30) {
        // Confere se houve pagamento DESDE o vencimento
        const { data: pagto } = await supabase.from('divida_pagamentos')
          .select('id').eq('divida_id', d.id)
          .gte('data_pagamento', vencEsteMes.toISOString().slice(0, 10))
          .limit(1);
        if (!pagto?.length) {
          // Avisa só uma vez por semana
          if (diasAtraso === 1 || diasAtraso === 7 || diasAtraso === 15 || diasAtraso === 30) {
            mensagem = `⚠️ *DÍVIDA EM ATRASO*\n\n📌 *${d.titulo}*\n📅 Vencimento era dia ${d.dia_vencimento} (${diasAtraso} dia${diasAtraso > 1 ? 's' : ''} atrás)\n💵 ${d.valor_parcela ? `R$ ${d.valor_parcela.toFixed(2)}` : ''}\n\nO atraso costuma vir com juros — quanto antes melhor.`;
            // Marca status em_atraso
            await supabase.from('dividas').update({ status: 'em_atraso' }).eq('id', d.id);
          }
        }
      }
    }

    if (!mensagem) continue;

    // Busca o telefone do dono e checa se ele tem lembretes_dividas ligado
    const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', d.grupo_id).single();
    if (!grupo) continue;
    const { data: user } = await supabase.from('users').select('phone, lembretes_dividas').eq('id', grupo.dono_id).single();
    if (!user?.phone || user.lembretes_dividas === false) continue;
    if (!(await avisosLigados(grupo.dono_id))) continue; // kill-switch
    // "Vence hoje" é do briefing matinal — se ligado, não duplica aqui (só
    // antecedência de 3 dias e atraso seguem no cron). Briefing off → manda.
    if (venceHoje && await briefingLigado(grupo.dono_id)) continue;

    await lembrete(user.phone, mensagem);
    await supabase.from('dividas').update({ ultimo_lembrete_em: hojeStr }).eq('id', d.id);
  }
  console.log('✅ Lembretes de dívidas processados.');
});

// ─────────────────────────────────────────────────────────────────
// JOB 1L — Todo dia às 09:00: ROLLOVER da fatura do cartão (rotativo s/ juros)
// Passo A: cartão manual venceu e sobrou saldo → avisa e pede confirmação (24h).
// Passo B: rollover 'aguardando' há +24h → rola sozinho e avisa.
// Só cartões MANUAIS (Open Finance traz a fatura do banco). Migration 096.
// ─────────────────────────────────────────────────────────────────
const faturaRoll = require('../services/faturaRollover');
cron.schedule('0 9 * * *', async () => {
  console.log('💳 Processando rollover de fatura...');
  const { competenciaAtual, cicloPorCompetencia, competenciaVizinha, hojeSP } = require('../services/cicloFatura');
  const hojeStr = hojeSP();

  // `core` = resumo em 1 linha pro {{1}} do template lembretes_gerais (fora da
  // janela de 24h). `texto` = versão rica usada dentro da janela.
  const notificarDono = async (grupoId, texto, pendenteCtx, core) => {
    const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', grupoId).maybeSingle();
    if (!grupo?.dono_id) return;
    const { data: user } = await supabase.from('users').select('phone').eq('id', grupo.dono_id).maybeSingle();
    if (!user?.phone) return;
    if (!(await avisosLigados(grupo.dono_id))) return;
    await lembrete(user.phone, texto, core);
    if (pendenteCtx) {
      try { await criarPendente({ userId: grupo.dono_id, tipoPergunta: 'rolar_fatura', contexto: pendenteCtx, expiresInMin: 60 * 26 }); }
      catch { /* noop */ }
    }
  };

  // ── PASSO A: detectar vencimento com saldo restante ──
  try {
    const { data: cartoes } = await supabase.from('wallets')
      .select('id, nome, grupo_id, dia_fechamento, dia_vencimento, of_conta_id')
      .eq('tipo', 'Crédito').not('dia_vencimento', 'is', null).is('of_conta_id', null);

    for (const c of cartoes || []) {
      // A fatura a cobrar é a ANTERIOR à atual — a atual, por definição, ainda
      // não venceu (competenciaAtual = próximo vencimento ≥ hoje).
      const compVencida = competenciaVizinha(c, competenciaAtual(c, hojeStr), -1);
      const cicloVencido = cicloPorCompetencia(c, compVencida);
      if (cicloVencido.venc >= hojeStr) continue; // ainda não venceu

      // Já existe rollover pra essa fatura? (dedup pela unique)
      const { data: jaTem } = await supabase.from('fatura_rollover')
        .select('id').eq('cartao_id', c.id).eq('competencia', compVencida).maybeSingle();
      if (jaTem) continue;

      const st = await faturaRoll.statusFatura(c.grupo_id, c, compVencida);
      if (st.restante <= 0) continue;

      const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', c.grupo_id).maybeSingle();
      const { data: row } = await supabase.from('fatura_rollover').upsert({
        grupo_id: c.grupo_id, user_id: grupo?.dono_id || null, cartao_id: c.id,
        competencia: compVencida, valor: st.restante, status: 'aguardando',
        avisado_em: new Date().toISOString(),
        confirmar_ate: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      }, { onConflict: 'cartao_id,competencia' }).select().single();

      const txt = `💳 *Fatura do ${c.nome}*\n\nVocê pagou parte, mas sobraram *R$ ${st.restante.toFixed(2)}*.\n\nQuer que eu role esse saldo pra próxima fatura? Responda *sim*.\n\n_Se não responder em 24h, eu rolo automaticamente pra você não ficar sem controle._`;
      const core = `Sobraram R$ ${st.restante.toFixed(2)} da fatura do ${c.nome}. Quer rolar pra próxima? Responda sim (senão rolo sozinho em 24h).`;
      await notificarDono(c.grupo_id, txt, { rollover_id: row?.id, cartao_id: c.id, cartao_nome: c.nome, valor: st.restante }, core);
    }
  } catch (e) { console.warn('[rollover passo A]', e.message); }

  // ── PASSO B: passou 24h sem confirmar → rola sozinho ──
  try {
    const { data: pendentes } = await supabase.from('fatura_rollover')
      .select('*').eq('status', 'aguardando').lt('confirmar_ate', new Date().toISOString());
    for (const row of pendentes || []) {
      const { data: cartao } = await supabase.from('wallets')
        .select('id, nome, dia_fechamento, dia_vencimento').eq('id', row.cartao_id).maybeSingle();
      await faturaRoll.materializarRollover(row, cartao?.nome || 'cartão', cartao);
      const nome = cartao?.nome || 'cartão';
      const val = Number(row.valor).toFixed(2);
      await notificarDono(
        row.grupo_id,
        `💳 Rolei *R$ ${val}* da fatura do ${nome} pra próxima fatura (você não confirmou em 24h). Está tudo registrado no painel.`,
        null,
        `Rolei R$ ${val} da fatura do ${nome} pra próxima fatura (não confirmado em 24h). Registrado no painel.`,
      );
    }
  } catch (e) { console.warn('[rollover passo B]', e.message); }

  console.log('✅ Rollover de fatura processado.');
});

// ─────────────────────────────────────────────────────────────────
// JOB 2 — Todo dia 1º às 00:01: reseta alertas de limite
// ─────────────────────────────────────────────────────────────────
cron.schedule('1 0 1 * *', async () => {
  console.log('🔄 Resetando alertas de limite do mês anterior...');
  const mesAnterior = new Date();
  mesAnterior.setMonth(mesAnterior.getMonth() - 1);
  const mesRef = mesAnterior.toISOString().slice(0,7);

  await supabase.from('category_limits')
    .update({ alerta_enviado: false })
    .eq('mes_referencia', mesRef);

  console.log('✅ Alertas resetados.');
});

// ─────────────────────────────────────────────────────────────────
// JOB 3 — Todo dia às 03:00: atualiza preços via Yahoo Finance
// ─────────────────────────────────────────────────────────────────
cron.schedule('0 3 * * *', async () => {
  console.log('📈 Atualizando investimentos via Yahoo Finance...');

  const { data: invs } = await supabase
    .from('investimentos')
    .select('*')
    .not('ticker', 'is', null);

  let atualizados = 0;
  for (const inv of invs || []) {
    try {
      // validateResult:false → o Yahoo mudou campos e a lib rejeitava a
      // resposta por schema, derrubando a atualização de preços.
      const quote = await yahooFinance.quote(inv.ticker, {}, { validateResult: false });
      const precoAtual  = quote.regularMarketPrice;
      const novoValor   = precoAtual * inv.quantidade;

      // Busca dividendos desde a data de compra
      let dividendos = inv.dividendos_acumulados || 0;
      try {
        const hist = await yahooFinance.historical(inv.ticker, {
          period1: inv.data_compra, events: 'dividends'
        }, { validateResult: false });
        dividendos = (hist || []).reduce((s, h) => s + (h.dividends || 0), 0) * inv.quantidade;
      } catch { /* sem dividendos para esse ativo */ }

      const rentabilidade = inv.valor_aportado > 0
        ? ((novoValor + dividendos - inv.valor_aportado) / inv.valor_aportado)
        : 0;

      await supabase.from('investimentos').update({
        valor_atual:          novoValor,
        dividendos_acumulados: dividendos,
        rentabilidade,
        ultima_atualizacao:   new Date().toISOString()
      }).eq('id', inv.id);

      // Salva snapshot histórico
      await supabase.from('historico_investimentos').insert({
        grupo_id:        inv.grupo_id,
        investimento_id: inv.id,
        valor_atual:     novoValor
      });

      atualizados++;
      // Aguarda 1s entre requisições (rate limit do Yahoo)
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`❌ Erro ao atualizar ${inv.ticker}:`, err.message);
    }
  }
  console.log(`✅ ${atualizados} investimentos atualizados.`);
});

// ─────────────────────────────────────────────────────────────────
// JOB 4 — Todo dia às 23:59: snapshot do patrimônio total
// ─────────────────────────────────────────────────────────────────
cron.schedule('59 23 * * *', async () => {
  console.log('💰 Salvando snapshot de patrimônio...');

  // Busca grupos com plano Black
  const { data: users } = await supabase
    .from('users')
    .select('grupo_ativo')
    .eq('plano', 'black')
    .not('grupo_ativo', 'is', null);

  const gruposVistos = new Set();
  for (const u of users || []) {
    if (gruposVistos.has(u.grupo_ativo)) continue;
    gruposVistos.add(u.grupo_ativo);

    const { data: invs } = await supabase.from('investimentos')
      .select('valor_atual').eq('grupo_id', u.grupo_ativo);
    const { data: wallets } = await supabase.from('wallets')
      .select('saldo').eq('grupo_id', u.grupo_ativo);

    const totalInv     = (invs    || []).reduce((s,i) => s + i.valor_atual, 0);
    const totalWallets = (wallets || []).reduce((s,w) => s + w.saldo, 0);
    const patrimonioTotal = totalInv + totalWallets;

    // Busca patrimônio do dia anterior para calcular rentabilidade
    const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
    const { data: anterior } = await supabase.from('patrimonio_historico')
      .select('patrimonio_total')
      .eq('grupo_id', u.grupo_ativo)
      .gte('data', ontem.toISOString())
      .order('data', { ascending: false })
      .limit(1)
      .single();

    const rentabilidade = anterior?.patrimonio_total > 0
      ? ((patrimonioTotal - anterior.patrimonio_total) / anterior.patrimonio_total) * 100
      : 0;

    await supabase.from('patrimonio_historico').insert({
      grupo_id:             u.grupo_ativo,
      patrimonio_total:     patrimonioTotal,
      rentabilidade_periodo: rentabilidade
    });
  }
  console.log('✅ Snapshots salvos.');
});

// ─────────────────────────────────────────────────────────────────
// JOB — Snapshot de DRE diário (00h05) para usuários com integrações ativas
// ─────────────────────────────────────────────────────────────────
const { gerarDre } = require('../handlers/negocios');
const { gerarInsights } = require('../handlers/insights-negocio');
cron.schedule('5 0 * * *', async () => {
  console.log('📊 Gerando snapshots de DRE + insights...');
  const periodoAtual    = new Date().toISOString().slice(0, 7) + '-01';
  const dAnterior = new Date(); dAnterior.setMonth(dAnterior.getMonth() - 1);
  const periodoAnterior = dAnterior.toISOString().slice(0, 7) + '-01';

  const { data: integ } = await supabase
    .from('integracoes').select('user_id, grupo_id').eq('status', 'ativa');

  const usersUnicos = Array.from(new Map((integ || []).map(i => [i.user_id, i])).values());
  let okSnap = 0, okIns = 0;
  for (const u of usersUnicos) {
    try {
      await supabase.from('dre_snapshots').delete().eq('user_id', u.user_id).eq('periodo', periodoAtual);
      await gerarDre(u.user_id, u.grupo_id, periodoAtual);
      await supabase.from('dre_snapshots').delete().eq('user_id', u.user_id).eq('periodo', periodoAnterior);
      await gerarDre(u.user_id, u.grupo_id, periodoAnterior);
      okSnap++;
      const ins = await gerarInsights(u.user_id, u.grupo_id);
      okIns += ins.length;
    } catch (e) {
      console.error('[dre/insights] erro user', u.user_id, e.message);
    }
  }
  console.log(`✅ DRE: ${okSnap} users · Insights: ${okIns} gerados.`);
});

// ─────────────────────────────────────────────────────────────────
// JOB 1L — Aviso do SORA WRAPPED (mensal). Nos primeiros 7 dias do mês,
// avisa quem já tem dados suficientes que o Wrapped do mês passado está
// pronto. Dedup persistido em users.wrapped_avisado (período YYYY-MM).
// ─────────────────────────────────────────────────────────────────
const W_MIN_DIAS = 30, W_MIN_LANC = 12, W_MIN_GROW = 15;
const W_MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
cron.schedule('0 13 * * *', async () => {
  try {
    const sp = agoraSP();
    if (sp.getDate() > 7) return; // só no comecinho do mês

    const alvo = new Date(sp.getFullYear(), sp.getMonth() - 1, 1); // mês passado
    const ini = alvo.toISOString().slice(0, 10);
    const fim = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 1).toISOString().slice(0, 10);
    const periodo = ini.slice(0, 7);
    const mesNome = W_MESES[alvo.getMonth()];
    console.log(`🎁 Wrapped: avaliando avisos de ${periodo}...`);

    const { data: users, error } = await supabase.from('users')
      .select('id, phone, grupo_ativo, created_at, wrapped_avisado')
      .not('grupo_ativo', 'is', null).not('phone', 'is', null);
    if (error) { console.log('🎁 Wrapped: rode a migration 037 (coluna wrapped_avisado).', error.message); return; }

    let avisados = 0;
    for (const u of users || []) {
      try {
        if (u.wrapped_avisado === periodo) continue;
        if (!u.created_at) continue;
        const diasUso = Math.floor((Date.now() - new Date(u.created_at).getTime()) / 86400000);
        if (diasUso < W_MIN_DIAS) continue;

        const { count: nTx } = await supabase.from('transacoes')
          .select('id', { count: 'exact', head: true })
          .eq('grupo_id', u.grupo_ativo).gte('data', ini).lt('data', fim);
        let elegivel = (nTx || 0) >= W_MIN_LANC;
        if (!elegivel) {
          const { count: nHab } = await supabase.from('registros_habito')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', u.id).eq('concluido', true).gte('data', ini).lt('data', fim);
          elegivel = (nHab || 0) >= W_MIN_GROW;
        }
        if (!elegivel) continue;

        // No Z-API manda o aviso rico; na Meta NÃO duplicamos — o fechamento
        // mensal (resumo_mensal) já convida pro Wrapped (evita mais 1 template).
        if ((process.env.WHATSAPP_PROVIDER || 'zapi').toLowerCase() !== 'meta') {
          await enviarTexto(u.phone,
            `🎁 *Seu Sora Wrapped de ${mesNome} tá pronto!*\n\n` +
            `Seus números viraram um resumo lindo — seu maior vilão de gastos, quanto você ` +
            `economizou, sua sequência... do jeitinho que dá vontade de postar no story. 🐳\n\n` +
            `👉 Ver meu Wrapped: ${APP_URL_RESUMO}/wrapped`);
        }
        await supabase.from('users').update({ wrapped_avisado: periodo }).eq('id', u.id);
        avisados++;
      } catch { /* tolerante por usuário */ }
    }
    console.log(`🎁 Wrapped: ${avisados} aviso(s) enviados.`);
  } catch (e) {
    console.log('🎁 Wrapped aviso falhou:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────
// JOB 1M / 1N — RESUMOS proativos (semanal + fechamento mensal), opt-in.
// Independentes do Wrapped. Dedup persistido (resumo_*_em) à prova de
// restart. Só envia se houve movimento no período.
// ─────────────────────────────────────────────────────────────────
const {
  resumoPeriodo, gerarInsight, montarCorpoSemanal, montarCorpoMensal,
  TITULO_SEMANAL, TITULO_MENSAL, CTA,
} = require('../services/resumoFinanceiro');
const APP_URL_RESUMO = process.env.NEXT_PUBLIC_APP_URL || 'https://forsora.com';
// Capa única (URL pública) usada nos resumos e na boas-vindas. Override via
// SORA_CAPA_URL no Render; default aponta pro /public do site.
const CAPA = process.env.SORA_CAPA_URL || `${APP_URL_RESUMO}/sora-capa.png`;

function addDiasISO(str, n) {
  const [Y, M, D] = str.split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D, 12));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// JOB 1M — Resumo SEMANAL: todo domingo a partir das 09:00 (SP).
cron.schedule('*/15 * * * *', async () => {
  try {
    const sp = agoraSP();
    if (sp.diaSemana !== 7) return;   // só domingo (agoraSP: Dom = 7)
    if (sp.minutos < 9 * 60) return;  // a partir das 09:00

    const { data: usuarios, error } = await supabase.from('users')
      .select('id, name, phone, grupo_ativo, resumo_semanal_em')
      .eq('resumo_semanal', true)
      .not('phone', 'is', null).not('grupo_ativo', 'is', null);
    if (error) { console.log('📅 Resumo semanal: rode a migration 044.', error.message); return; }

    const fim = sp.dataStr;                  // esta segunda (exclusivo)
    const ini = addDiasISO(sp.dataStr, -7);  // segunda passada
    const prevIni = addDiasISO(sp.dataStr, -14);

    let enviados = 0;
    for (const u of usuarios || []) {
      try {
        if (u.resumo_semanal_em === sp.dataStr) continue;                 // já enviou hoje
        if (!(await avisosLigados(u.id))) continue;                       // kill-switch
        await supabase.from('users').update({ resumo_semanal_em: sp.dataStr }).eq('id', u.id); // marca ANTES
        const atual = await resumoPeriodo(u.grupo_ativo, ini, fim);
        if (atual.count === 0) continue;                                  // semana sem movimento
        const anterior = await resumoPeriodo(u.grupo_ativo, prevIni, ini);
        const insight = await gerarInsight({ periodo: 'semana', atual, anterior });
        const txt = `${montarCorpoSemanal({ atual, anterior, insight })}\n\n👉 Ver no painel: ${APP_URL_RESUMO}/dashboard`;
        await enviarProativo(u.phone, {
          texto: txt,
          template: {
            name: 'resumo_semanal',
            // corpo: {{1}} nome · {{2}} gasto · {{3}} recebido | cabeçalho IMAGE = capa
            params: [(u.name || 'tudo bem').split(' ')[0], brl(atual.gastos), brl(atual.receitas)],
            opts: { headerImage: CAPA },
          },
        });
        enviados++;
      } catch { /* tolerante por usuário */ }
    }
    if (enviados) console.log(`📅 Resumo semanal: ${enviados} enviado(s).`);
  } catch (e) { console.log('📅 Resumo semanal falhou:', e.message); }
});

// JOB 1N — Fechamento MENSAL: dia 1 a partir das 09:00 (SP), do mês anterior.
cron.schedule('*/15 * * * *', async () => {
  try {
    const sp = agoraSP();
    if (parseInt(sp.dataStr.slice(8, 10), 10) !== 1) return; // só no dia 1º
    if (sp.minutos < 9 * 60) return;                          // a partir das 09:00

    const mesCorrente = sp.dataStr.slice(0, 7); // 'YYYY-MM' — chave de dedup
    const { data: usuarios, error } = await supabase.from('users')
      .select('id, name, phone, grupo_ativo, meta_mensal, resumo_mensal_em')
      .eq('resumo_mensal', true)
      .not('phone', 'is', null).not('grupo_ativo', 'is', null);
    if (error) { console.log('🧾 Resumo mensal: rode a migration 044.', error.message); return; }

    const [Y, M] = sp.dataStr.split('-').map(Number);                         // M = mês corrente (dia 1)
    const ini = new Date(Date.UTC(Y, M - 2, 1, 12)).toISOString().slice(0, 10);   // 1º do mês passado
    const fim = new Date(Date.UTC(Y, M - 1, 1, 12)).toISOString().slice(0, 10);   // 1º do mês corrente
    const prevIni = new Date(Date.UTC(Y, M - 3, 1, 12)).toISOString().slice(0, 10); // 1º do mês retrasado
    const mesNome = W_MESES[(M - 2 + 12) % 12];

    let enviados = 0;
    for (const u of usuarios || []) {
      try {
        if (u.resumo_mensal_em === mesCorrente) continue;
        if (!(await avisosLigados(u.id))) continue;                       // kill-switch
        await supabase.from('users').update({ resumo_mensal_em: mesCorrente }).eq('id', u.id);
        const atual = await resumoPeriodo(u.grupo_ativo, ini, fim);
        if (atual.count === 0) continue;
        const anterior = await resumoPeriodo(u.grupo_ativo, prevIni, ini);
        const insight = await gerarInsight({ periodo: 'mes', atual, anterior });
        const txt = `${montarCorpoMensal({ mesNome, atual, anterior, metaMensal: u.meta_mensal || 0, insight })}\n\n👉 Ver no painel: ${APP_URL_RESUMO}/dashboard`;
        await enviarProativo(u.phone, {
          texto: txt,
          template: {
            name: 'resumo_mensal',
            params: [(u.name || 'tudo bem').split(' ')[0], mesNome, brl(atual.gastos), brl(atual.receitas), brl(atual.saldo)],
            opts: { headerImage: CAPA }, // cabeçalho IMAGE = capa
          },
        });
        enviados++;
      } catch { /* tolerante por usuário */ }
    }
    if (enviados) console.log(`🧾 Resumo mensal: ${enviados} enviado(s).`);
  } catch (e) { console.log('🧾 Resumo mensal falhou:', e.message); }
});

console.log('⏰ Cron jobs registrados:');
console.log('   • A cada hora  — recorrências, lembretes, parcelas, fatura');
console.log('   • A cada minuto — lembretes de medicamentos (horário exato)');
console.log('   • Todo dia 09h — lembretes de consultas (24h antes + retorno 7d)');
console.log('   • Todo dia 09h — lembretes de dívidas (3d antes / dia / atraso)');
console.log('   • Todo dia 1º  — reset de alertas de limite');
console.log('   • Todo dia 03h — atualização Yahoo Finance');
console.log('   • Todo dia 23h59 — snapshot de patrimônio');
console.log('   • Todo dia 00h05 — snapshot de DRE Negócios');

// ─────────────────────────────────────────────────────────────────
// JOB 1O — RECUPERAÇÃO de pagamento recusado. A cada 15 min, manda o
// WhatsApp de recuperação (login + cupom SORA15) pra quem o checkout
// falhou e ainda não pagou. Dedup à prova de restart (recuperacao_*_em).
// Migration 047. Tolerante caso a migration não tenha rodado.
// ─────────────────────────────────────────────────────────────────
const { processarRecuperacoes } = require('../services/recuperacaoPagamento');
cron.schedule('*/15 * * * *', async () => {
  // DESATIVADO por padrão (incidente de spam no WhatsApp). Religar: setar
  // RECUPERACAO_ATIVA=1 no Render → Environment. As respostas reativas (quando o
  // lead responde) continuam funcionando; só o disparo proativo fica pausado.
  if (process.env.RECUPERACAO_ATIVA !== '1') return;
  try { await processarRecuperacoes(); }
  catch (e) { console.log('💸 Recuperação de pagamento falhou:', e.message); }
});
console.log(`   • A cada 15min — recuperação de pagamento recusado ${process.env.RECUPERACAO_ATIVA === '1' ? '' : '(DESATIVADA)'}`);

// ─────────────────────────────────────────────────────────────────
// JOB 1P — RECUPERAÇÃO de cadastro sem pagamento (abandono no paywall).
// A cada 30 min, manda WhatsApp (login + cupom SORA15) pra quem criou conta,
// nunca ativou plano e tem WhatsApp. Drena em lotes de 50. Migration 056.
// ─────────────────────────────────────────────────────────────────
const { processarRecuperacaoSignup, processarRecuperacaoSignup2 } = require('../services/recuperacaoSignup');
cron.schedule('*/30 * * * *', async () => {
  // DESATIVADO por padrão (incidente de spam no WhatsApp). Religar: RECUPERACAO_ATIVA=1.
  if (process.env.RECUPERACAO_ATIVA !== '1') return;
  try { await processarRecuperacaoSignup(50); }
  catch (e) { console.log('💸 Recuperação de cadastro (1º) falhou:', e.message); }
  try { await processarRecuperacaoSignup2(50); }
  catch (e) { console.log('💸 Recuperação de cadastro (2º) falhou:', e.message); }
});
console.log(`   • A cada 30min — recuperação de cadastro sem pagamento (1º + 2º lembrete) ${process.env.RECUPERACAO_ATIVA === '1' ? '' : '(DESATIVADA)'}`);