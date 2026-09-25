// =============================================================================
// Registrar venda pelo WhatsApp.
//
// "vendi 3 bolos por 90 pra dona Maria" → venda + lançamento no caixa + baixa
// no estoque, sem abrir o painel. É a diferença entre o dono registrar tudo e
// registrar quando lembra.
//
// A interpretação é local-first (services/vendaTexto, com eval). Aqui só se
// resolve produto/cliente contra o banco e se grava — pela MESMA porta que o
// balcão usa (lancamentos_negocio + venda_itens), pra não existir venda que o
// DRE não enxerga.
//
// SÓ DISPARA PARA QUEM TEM EMPRESA FÍSICA/HÍBRIDA CADASTRADA. Num usuário
// pessoal, "vendi meu celular por 500" é uma RECEITA, não uma venda de loja —
// interceptar isso quebraria o fluxo de finanças pessoais.
// =============================================================================
const supabase = require('../db/supabase');
const { interpretarVenda } = require('../services/vendaTexto');
const { enviarTexto } = require('../services/mensageiro');
const { empresasDoUsuario, empresaAssumida, papelPermite } = require('../services/acessoEmpresa');

const hojeSP = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const fmt = (c) => new Intl.NumberFormat('pt-BR',
  { style: 'currency', currency: 'BRL' }).format((Number(c) || 0) / 100);

/** Normaliza pra casar "Bolo de Cenoura" com "bolo de cenoura". */
const chave = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/s\b/g, '').trim();

/** Casa o termo com um produto cadastrado: exato → contém → contido. */
function acharProduto(produtos, termo) {
  if (!termo) return null;
  const t = chave(termo);
  if (!t) return null;
  return produtos.find(p => chave(p.nome) === t)
      || produtos.find(p => chave(p.nome).includes(t))
      || produtos.find(p => t.includes(chave(p.nome)))
      || null;
}

/**
 * @returns {boolean} true se tratou a mensagem (o webhook para aqui)
 */
async function capturaVenda(mensagem, { phone, user }) {
  const v = interpretarVenda(mensagem);
  if (!v) return false;

  // Empresa: só loja física/híbrida. Infoproduto vende pela plataforma.
  //
  // ⚠️ ALCANÇADAS, não só as próprias (migration 173): é justamente pelo zap
  // que o vendedor convidado registra a venda — era o pedido do relato ("cada
  // um pelo seu próprio WhatsApp, na mesma empresa"). Filtrar por `user_id`
  // fazia a mensagem dele voltar como finança pessoal.
  // O papel 'leitura' (o contador) fica de fora: ele vê o DRE, não lança venda.
  const alcancadas = (await empresasDoUsuario(user.id))
    .filter(e => (e.tipo === 'fisico' || e.tipo === 'hibrido') && papelPermite(e.papel, 'operador'));

  // `empresaAssumida` devolve null com 2+ lojas e nenhuma marcada como padrão
  // — ela não escolhe no lugar de ninguém.
  //
  // ⚠️ MAS AQUI NÃO DÁ PRA RECUSAR A VENDA. Medido em 25/09/2026: 3 clientes
  // estão nessa situação (um deles com as 6 lojas do relato), e hoje a Sora
  // registra na primeira loja. Passar a responder "escolha a principal"
  // QUEBRARIA a venda por WhatsApp desses três — e a tela onde se marca o
  // padrão só existe na fase 3. Regressão travando venda é pior que o
  // problema que ela resolve.
  //
  // Então mantém-se o comportamento de hoje (a primeira), mas o silêncio
  // acaba: a confirmação NOMEIA a loja em que caiu. Um palpite errado passa a
  // ser visível no mesmo segundo, em vez de sujar o caixa por semanas.
  const empresa = empresaAssumida(alcancadas) || alcancadas[0];
  if (!empresa) return false;
  const precisaDizerALoja = alcancadas.length > 1;

  // Produto cadastrado dá preço, custo e baixa de estoque. Sem ele a venda
  // ainda vale — item avulso é melhor que venda não registrada.
  let produtos = [];
  try {
    const { data } = await supabase.from('produtos_negocio')
      .select('id, nome, preco, custo, eh_servico')
      .eq('empresa_id', empresa.id).eq('ativo', true);
    produtos = data || [];
  } catch { /* sem a 106 */ }
  const prod = acharProduto(produtos, v.produto);

  const precoUnit = v.valor_unitario
    ?? (v.valor != null ? Math.round(v.valor / (v.quantidade || 1)) : (prod?.preco || 0));
  const total = v.valor ?? Math.round(precoUnit * (v.quantidade || 1));

  if (!total) {
    await enviarTexto(phone,
      `Entendi a venda de *${v.produto || 'item'}*, mas não sei o valor.\n\n` +
      `Manda assim: "vendi ${v.quantidade || 1} ${v.produto || 'bolo'} por 50".`);
    return true;
  }

  // Cliente: casa pelo nome; não cria cadastro sozinho (encheria a base de
  // "dona", "seu joão da esquina" e variações da mesma pessoa).
  let clienteId = null, clienteNome = v.cliente || null;
  if (v.cliente) {
    try {
      const { data: cli } = await supabase.from('clientes_negocio')
        .select('id, nome').eq('empresa_id', empresa.id).eq('ativo', true)
        .ilike('nome', `%${v.cliente}%`).limit(1).maybeSingle();
      if (cli) { clienteId = cli.id; clienteNome = cli.nome; }
    } catch { /* segue com o nome solto */ }
  }

  const data = hojeSP();
  const custoUnit = prod?.custo || 0;
  const item = {
    produto_id: prod?.id || null,
    nome: prod?.nome || v.produto || 'Venda',
    quantidade: v.quantidade || 1,
    preco_unit: precoUnit,
    custo_unit: custoUnit,
    subtotal: total,
  };

  const { data: venda, error } = await supabase.from('vendas_negocio').insert({
    empresa_id: empresa.id,
    cliente_id: clienteId,
    cliente_nome: clienteNome,
    data, total, desconto: 0,
    custo_total: Math.round(custoUnit * (v.quantidade || 1)),
    forma_pagamento: v.forma || null,
    status: v.aPrazo ? 'pendente' : 'pago',
    vencimento: v.aPrazo ? data : null,
  }).select().single();
  if (error) {
    await enviarTexto(phone, 'Não consegui registrar a venda agora. Tenta de novo em instantes?');
    return true;
  }

  await supabase.from('venda_itens').insert({ ...item, venda_id: venda.id });

  // O DINHEIRO: mesma porta do balcão. À vista = pago; fiado = pendente, que
  // é exatamente a conta a receber.
  const { data: lanc } = await supabase.from('lancamentos_negocio').insert({
    empresa_id: empresa.id,
    user_id: user.id,
    tipo: 'entrada',
    categoria: prod?.eh_servico ? 'servicos' : 'vendas',
    descricao: item.nome,
    valor: total,
    data,
    status: v.aPrazo ? 'pendente' : 'pago',
    vencimento: v.aPrazo ? data : null,
    pago_em: v.aPrazo ? null : data,
    forma_pagamento: v.forma || null,
    contraparte: clienteNome,
    venda_id: venda.id,
  }).select().maybeSingle();
  if (lanc) await supabase.from('vendas_negocio').update({ lancamento_id: lanc.id }).eq('id', venda.id);

  // Baixa de estoque só pra produto cadastrado que não é serviço.
  let sobrou = null;
  if (prod && !prod.eh_servico) {
    try {
      const { baixarVenda } = require('../services/estoque');
      const r = await baixarVenda({
        empresaId: empresa.id, vendaId: venda.id,
        itens: [{ produto_id: prod.id, quantidade: v.quantidade || 1 }], data,
      });
      sobrou = r?.[0]?.saldo ?? null;
    } catch { /* estoque é secundário; a venda já está gravada */ }
  }

  // Resposta curta: quem está no balcão lê de relance.
  const linhas = [
    `✅ Venda registrada — *${fmt(total)}*`,
    `${v.quantidade || 1}× ${item.nome}${clienteNome ? ` · ${clienteNome}` : ''}`,
  ];
  // ⚠️ Com mais de uma loja alcançada, DIZER EM QUAL caiu. É o que transforma
  // um palpite errado em algo corrigível na hora (ver o bloco da empresa).
  if (precisaDizerALoja) linhas.push(`Loja: *${empresa.nome}*`);
  if (v.aPrazo) linhas.push(`_Fiado_ — entrou em contas a receber, não no caixa de hoje.`);
  if (sobrou != null) linhas.push(`Estoque de ${item.nome}: ${sobrou}`);
  if (!prod && v.produto) linhas.push(`_Item avulso: cadastre "${v.produto}" pra acompanhar margem e estoque._`);

  await enviarTexto(phone, linhas.join('\n'));
  return true;
}

module.exports = { capturaVenda, acharProduto };
