// =============================================================================
// EVAL do interpretador local (interpretarRapido) — frase → ação esperada.
//
// É um "checklist automático": roda o parser que já existe contra uma lista de
// frases e confere se a ação que saiu é a certa. NÃO toca em produção, não chama
// IA, não gasta nada — só LÊ o parser e dá uma nota.
//
// Rodar:   node evals/interpretador.eval.js
// Sai com código != 0 se algo falhar (dá pra usar como gate de CI no futuro).
//
// Como ler um caso:  { msg, expect }
//   expect = null          → a frase DEVE cair pra IA (parser devolve null)
//   expect = { ...campos } → o parser devolve um objeto com ESSES campos
//                            (match parcial: só checa os campos que estão em expect)
// =============================================================================

const { interpretarRapido, parsePeriodoExtenso } = require('../src/handlers/interpretador');

const CASOS = [
  // ── VALOR COM PREFIXO "R$" — o formato que vem do ÁUDIO ───────────────────
  //
  // ⚠️ ESTE BLOCO É O RELATO DE 03/09/2026, e nasceu de um bug em produção.
  // Um cliente disse que a Sora não registrava por ÁUDIO. Por texto funcionava.
  // A causa: o Whisper escreve valor falado como "R$ 3,00", e a normalização do
  // interpretador só tirava a moeda DEPOIS do número ("10 reais" → "10").
  // Com o prefixo intacto, a regra de SALVAR (que espera número nu) não casava
  // e a frase caía numa regra de CONSULTA: o cliente recebia "Nenhum gasto
  // encontrado para mercado com inter".
  //
  // Medido na época: 9 de 11 formatos de fala NÃO viravam lançamento, caindo de
  // três jeitos diferentes (buscar, resumo e null). Estes casos existem pra que
  // nenhum deles volte em silêncio.
  { msg: 'Gastei R$ 3,00 no mercado com Inter', expect: { acao: 'salvar', tipo: 'Gasto', valor: 3, categoria: 'Mercado', carteira_nome: 'inter' } },
  // ⚠️ O PONTO FINAL DO ÁUDIO. O Whisper encerra a frase com ponto, e ele ficava
  // colado no nome: `carteira_nome: "inter."`. O resolver não casava com a conta
  // "Inter" e a Sora perguntava de qual conta foi — mesmo o usuário tendo dito.
  // Relato de 03/09/2026. Por texto nunca aparecia: ninguém digita ponto ali.
  { msg: 'Gastei R$ 3,00 no mercado com Inter.', expect: { acao: 'salvar', valor: 3, carteira_nome: 'inter' } },
  // ⚠️ "usando" como separador de CONTA. Antes só valiam no|na|pelo|pela|com,
  // então isto devolvia `carteira_nome: null` — e SEM conta citada o handler usa
  // a conta PADRÃO. Foi o "registrou a conta como mercado pago" do relato: não
  // era leitura errada de "inter", era a conta padrão entrando no lugar.
  // O "conta" que sobra é removido pelo resolverCarteiraReal (passo sem-ruído).
  { msg: 'gastei 3 reais no mercado usando a conta inter', expect: { acao: 'salvar', valor: 3, carteira_nome: 'conta inter' } },
  { msg: 'gastei 3 reais no mercado via inter', expect: { acao: 'salvar', carteira_nome: 'inter' } },
  { msg: 'gastei 3 reais no mercado através de inter', expect: { acao: 'salvar', carteira_nome: 'inter' } },
  { msg: 'Gastei R$3,00 no mercado',          expect: { acao: 'salvar', tipo: 'Gasto', valor: 3, categoria: 'Mercado' } },
  { msg: 'Gastei R$ 3 no mercado',            expect: { acao: 'salvar', tipo: 'Gasto', valor: 3, categoria: 'Mercado' } },
  // ⚠️ Milhar: o prefixo sai, mas o formato BR tem de sobreviver — 1.250,00
  // precisa chegar como 1250, não como 1,25. É o `parseValor` que garante isso.
  { msg: 'Gastei R$ 1.250,00 no aluguel',     expect: { acao: 'salvar', tipo: 'Gasto', valor: 1250, categoria: 'Aluguel' } },
  { msg: 'Paguei R$ 89,90 na Netflix',        expect: { acao: 'salvar', tipo: 'Gasto', valor: 89.9, categoria: 'Assinaturas' } },
  { msg: 'Recebi R$ 2.000,00 de salário',     expect: { acao: 'salvar', valor: 2000 } },
  // ⚠️ E as CONSULTAS não podem ter virado lançamento junto: a correção mexeu na
  // normalização, que TODA regra abaixo consome.
  { msg: 'quanto gastei no mercado',          expect: { acao: 'buscar' } },
  { msg: 'meus gastos',                       expect: { acao: 'resumo' } },

  // ── Registrar gasto (salvar) ──────────────────────────────────────────────
  { msg: 'gastei 50 no mercado',              expect: { acao: 'salvar', tipo: 'Gasto', valor: 50, categoria: 'Mercado' } },
  { msg: 'paguei 30 no uber',                 expect: { acao: 'salvar', tipo: 'Gasto', valor: 30, categoria: 'Transporte' } },
  { msg: 'gastei 200 na farmacia',            expect: { acao: 'salvar', tipo: 'Gasto', categoria: 'Saúde' } },
  // Guardas de regressão (categorização de comida — bugs corrigidos jul/2026)
  // Salgado/lanche cai em "Lanches", a SUBcategoria de Alimentação da taxonomia
  // v3 (sql/084). O eval ainda cobrava o pai "Alimentação", de antes da v3, e
  // virou 3 falhas fixas no placar — eval que sempre falha para de ser sinal.
  { msg: 'gastei 9,50 com uma coxinha',       expect: { acao: 'salvar', valor: 9.5, categoria: 'Lanches' } },
  { msg: 'gastei 12 com um pastel',           expect: { acao: 'salvar', categoria: 'Lanches' } },
  { msg: 'gastei 8 num cachorro quente',      expect: { acao: 'salvar', categoria: 'Lanches' } }, // NÃO pode ser Pet
  { msg: 'gastei 100 na academia',            expect: { acao: 'salvar', categoria: 'Academia' } },
  // Valor NO FIM (introduzido por "por/de") — forma natural (bug jul/2026: caía no Grow "não entendi")
  { msg: 'Comprei um hambúrguer no ifood por 8,29 reais', expect: { acao: 'salvar', tipo: 'Gasto', valor: 8.29, categoria: 'Alimentação' } },
  { msg: 'paguei o uber por 15',              expect: { acao: 'salvar', tipo: 'Gasto', valor: 15, categoria: 'Transporte' } },
  { msg: 'paguei o almoço de 25',             expect: { acao: 'salvar', tipo: 'Gasto', valor: 25, categoria: 'Alimentação' } },
  { msg: 'comprei um presente de 50',         expect: { acao: 'salvar', tipo: 'Gasto', valor: 50 } },
  { msg: 'paguei a conta de luz',             expect: null }, // "de" sem número → NÃO vira gasto (cai pra IA/agenda)
  // DESCRIÇÃO = só o ITEM (sem artigo, sem loja, sem "compra de") — bug jul/2026.
  // categoria aqui é a do PARSER ('Encomendas' p/ marketplace); o handler ainda
  // refina pela mensagem inteira e vira a subcategoria real ("Mercado Livre").
  { msg: 'Comprei uma resistência no mercado livre por 28,90', expect: { acao: 'salvar', valor: 28.90, observacao: 'resistência', categoria: 'Encomendas' } },
  { msg: 'paguei compra de coberta no mercado livre por 120',  expect: { acao: 'salvar', valor: 120, observacao: 'coberta', categoria: 'Encomendas' } },
  { msg: 'Comprei um hambúrguer no ifood por 8,29 reais',      expect: { acao: 'salvar', observacao: 'hambúrguer' } },
  { msg: 'gastei 9,50 com uma coxinha',                        expect: { acao: 'salvar', observacao: 'coxinha' } },
  { msg: 'gastei 50 no mercado',                               expect: { acao: 'salvar', observacao: 'mercado' } },

  // ── "cancela" sozinho = desfazer o ÚLTIMO LANÇAMENTO (não cancelar assinatura) ──
  { msg: 'cancela',                           expect: { acao: 'apagar' } },
  { msg: 'cancelar',                          expect: { acao: 'apagar' } },
  { msg: 'cancela isso',                      expect: { acao: 'apagar' } },
  { msg: 'cancela esse gasto',                expect: { acao: 'apagar' } },
  // Guardas: cancelar plano/assinatura/resumo NÃO pode virar apagar
  { msg: 'quero cancelar minha assinatura',   expect: { acao: 'cancelar_plano' } },
  { msg: 'cancelar plano',                    expect: { acao: 'cancelar_plano' } },
  { msg: 'cancelar resumos',                  expect: { acao: 'config_resumos', valor: false } },

  // ── Registrar receita ─────────────────────────────────────────────────────
  { msg: 'recebi 3000 de salário',            expect: { acao: 'salvar', tipo: 'Recebimento', valor: 3000 } },
  { msg: 'ganhei 500',                        expect: { acao: 'salvar', tipo: 'Recebimento', valor: 500 } },

  // ── Resumo por período ────────────────────────────────────────────────────
  { msg: 'quanto gastei esse mês',            expect: { acao: 'resumo', periodo: 'mes' } },          // era buscar "mês" (bug)
  { msg: 'quanto gastei hoje',                expect: { acao: 'resumo', periodo: 'hoje' } },
  { msg: 'gastos dessa semana',               expect: { acao: 'resumo', periodo: 'semana' } },       // era buscar "dessa" (bug)
  { msg: 'quanto gastei semana passada',      expect: { acao: 'resumo', periodo: 'semana_passada' } },
  { msg: 'quanto gastei mês passado',         expect: { acao: 'resumo', periodo: 'mes_passado' } },
  { msg: 'quanto gastei esse ano',            expect: { acao: 'resumo', periodo: 'ano' } },
  { msg: 'resumo',                            expect: { acao: 'resumo', periodo: 'mes' } },
  { msg: 'meus gastos',                       expect: { acao: 'resumo', periodo: 'mes' } },
  { msg: 'no que gasto mais',                 expect: { acao: 'resumo', periodo: 'mes' } },           // era buscar "que mais" (bug)
  { msg: 'onde tô gastando demais',           expect: { acao: 'resumo', periodo: 'mes' } },           // era buscar "onde tô demais" (bug)

  // ── Buscar por assunto (+ período opcional) ───────────────────────────────
  { msg: 'gastos com alimentação',            expect: { acao: 'buscar', termo: 'alimentação' } },     // era cortado p/ "alimentaçã"
  { msg: 'quanto gastei com mercado',         expect: { acao: 'buscar', termo: 'mercado' } },
  { msg: 'meus gastos de uber',               expect: { acao: 'buscar', termo: 'uber' } },
  { msg: 'gastos com uber hoje',              expect: { acao: 'buscar', termo: 'uber', periodo: 'hoje' } },
  { msg: 'quanto gastei com mercado mês passado', expect: { acao: 'buscar', termo: 'mercado', periodo: 'mes_passado' } },

  // ── Saldo ─────────────────────────────────────────────────────────────────
  { msg: 'meu saldo',                         expect: { acao: 'ver_saldos' } },
  { msg: 'ver saldo',                         expect: { acao: 'ver_saldos' } },

  // ── Confirmar conta variável (previsto) ───────────────────────────────────
  { msg: 'confirmar luz 243',                 expect: { acao: 'confirmar_previsto', termo: 'luz', valor: 243 } },
  { msg: 'confirma agua 89,90',               expect: { acao: 'confirmar_previsto', termo: 'agua', valor: 89.9 } },

  // ── Recorrências / fixos ──────────────────────────────────────────────────
  { msg: 'todo mês 1000 aluguel dia 5',       expect: { acao: 'set_recorrente', valor: 1000, dia: 5 } },
  { msg: 'todo mês 50 spotify dia 10',        expect: { acao: 'set_recorrente', valor: 50, dia: 10 } },

  // ── LISTAR recorrências (consulta, ≠ cadastro) ────────────────────────────
  // Gastos fixos → só despesas
  { msg: 'quais meus gastos fixos desse mês?', expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  { msg: 'quais gastos fixos desse mês?',      expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  { msg: 'meus gastos fixos',                  expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  { msg: 'contas fixas',                       expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  { msg: 'minhas contas fixas do mês',         expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  { msg: 'listar despesas fixas',              expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  // Receitas fixas → só entradas
  { msg: 'quais minhas receitas fixas?',       expect: { acao: 'listar_recorrencias', filtro: 'Receita' } },
  { msg: 'minhas entradas fixas',              expect: { acao: 'listar_recorrencias', filtro: 'Receita' } },
  // Sem qualificar → tudo
  { msg: 'quais minhas recorrências desse mês', expect: { acao: 'listar_recorrencias', filtro: null } },
  { msg: 'minhas recorrências',                expect: { acao: 'listar_recorrencias', filtro: null } },
  { msg: 'recorrências',                       expect: { acao: 'listar_recorrencias', filtro: null } },
  { msg: 'ver recorrencias',                   expect: { acao: 'listar_recorrencias', filtro: null } },

  // ⚠️ O que NÃO pode virar listagem — o regex nunca chuta.
  // Cadastro tem valor E dia: não pode ser engolido pela consulta.
  { msg: 'todo mês 1200 aluguel dia 5',       expect: { acao: 'set_recorrente' } },
  { msg: 'gastei 50 no mercado',              expect: { acao: 'salvar' } },
  // ⚠️ ESTES DOIS ERAM O BUG, REGISTRADO COMO "COMPORTAMENTO ATUAL".
  //
  // O comentário que estava aqui dizia: "a regra genérica de gast\w+ captura
  // QUALQUER frase com gasto e devolve resumo do mês (…) corrigir exige mexer
  // na regra ampla, que é risco à parte". A regra FOI corrigida (set/2026):
  // as regras de gasto agora exigem um SINAL DE PERGUNTA e, sem ele, devolvem
  // `null` pra a IA entender a frase inteira.
  //
  // ⚠️ Então o esperado mudou de `resumo` pra `null` porque o COMPORTAMENTO
  // ficou certo — não porque o eval foi afrouxado pra passar. Medido em 24
  // frases: as 10 consultas legítimas seguem consulta, e as 14 outras
  // intenções (cadastrar/editar/apagar/planejar/perguntar o que é) pararam de
  // ser sequestradas. Um resumo do mês era a pior resposta possível pra
  // "quero cadastrar um gasto fixo".
  { msg: 'paguei o aluguel que é meu maior gasto fixo', expect: null },
  { msg: 'quero cadastrar um gasto fixo',     expect: null },
  // ── Regressão da regra de gastos: o que TEM de continuar consulta ──
  { msg: 'meus gastos',                       expect: { acao: 'resumo' } },
  { msg: 'gastos do mes passado',             expect: { acao: 'resumo' } },
  { msg: 'no que gasto mais',                 expect: { acao: 'resumo' } },
  { msg: 'me mostra meus gastos',             expect: { acao: 'resumo' } },
  { msg: 'gastos com alimentacao',            expect: { acao: 'buscar' } },
  // ⚠️ "quero" NÃO pode excluir por si: aqui ele vem com "ver", que é pergunta
  // de verdade. Foi por isso que a correção exige sinal POSITIVO em vez de
  // manter uma lista de verbos proibidos.
  { msg: 'quero ver meus gastos',             expect: { acao: 'resumo' } },
  // ── E o que NÃO pode mais virar consulta ──
  { msg: 'apaga o gasto do mercado',          expect: null },
  { msg: 'editar o gasto de ontem',           expect: null },
  { msg: 'o que e um gasto fixo',             expect: null },
  { msg: 'quero gastar menos esse mes',       expect: null },
  // ⚠️ ESTE SEGUE PRA IA aqui, mas é capturado DEPOIS pelo quick-capture do
  // Grow: `preciso + <verbo>ar` é gatilho de tarefa (RE_TAREFA_NL). Ou seja,
  // "preciso registrar um gasto" vira TAREFA pra quem tem Grow. Conferido, e
  // registrado aqui de propósito — é leitura defensável da frase, e melhor que
  // o resumo do mês que ela virava antes. Se um dia incomodar, o lugar de
  // tratar é o RE_NAO_TAREFA do grow.js, não esta regra.
  { msg: 'preciso registrar um gasto',        expect: null },

  // ── Cartão / parcelas / fatura ────────────────────────────────────────────
  { msg: 'comprei fone no nubank crédito em 3x de 150', expect: { acao: 'compra_parcelada' } },
  { msg: 'pagar fatura',                      expect: { acao: 'pagar_fatura' } },

  // ── COMPRA PARCELADA: as formas que a pessoa REALMENTE usa ────────────────
  //
  // ⚠️ ESTE BLOCO É O RELATO DE set/2026 — "não salva compra parcelada nem por
  // texto nem por áudio" — e o modo de falha era SILENCIOSO: a frase escapava
  // da regra e virava UMA despesa no valor da PARCELA. Quem mandou "3x de
  // 79,80" via R$ 79,80 lançado e achava que estava tudo certo.
  //
  // Medido no parser antigo: 8 destas 10 falhavam. Cada caso abaixo é um
  // defeito distinto, não variação decorativa.

  // 1. ACENTO NO NOME DO CARTÃO — o relato literal. `[\w\s]` não casa "ú", e a
  //    frase inteira caía fora. Sem acento funcionava; com acento, não.
  { msg: 'Comprei uma cama no itaú crédito em 3x de 79,80',
    expect: { acao: 'compra_parcelada', carteira: 'itaú crédito', numParcelas: 3, valorParcela: 79.8, valorTotal: 239.4 } },
  { msg: 'Comprei uma cama no itau credito em 3x de 79,80',
    expect: { acao: 'compra_parcelada', numParcelas: 3, valorParcela: 79.8 } },

  // 2. "x" SEPARADO E SINÔNIMOS DA UNIDADE.
  { msg: 'comprei fone no nubank credito em 3 x de 150',
    expect: { acao: 'compra_parcelada', numParcelas: 3, valorParcela: 150 } },
  { msg: 'comprei sofá no mercado pago crédito em 6 vezes de 300',
    expect: { acao: 'compra_parcelada', numParcelas: 6, valorParcela: 300, valorTotal: 1800 } },
  { msg: 'comprei mesa no nubank crédito em 4 parcelas de 125',
    expect: { acao: 'compra_parcelada', numParcelas: 4, valorParcela: 125 } },
  //    ⚠️ "TRÊS" COM ACENTO — este caso existe porque a quebra deliberada do
  //    achatamento passou despercebida sem ele: todo o resto do vocabulário
  //    ("x", "vezes", "parcelas", "no", "de") é ASCII, então só o número por
  //    extenso acentuado exercita de fato a normalização.
  { msg: 'comprei geladeira no nubank crédito em três parcelas de 200',
    expect: { acao: 'compra_parcelada', numParcelas: 3, valorParcela: 200, valorTotal: 600 } },
  { msg: 'comprei tv no itaú crédito em três vezes de 100',
    expect: { acao: 'compra_parcelada', carteira: 'itaú crédito', numParcelas: 3, valorParcela: 100 } },

  // 3. CARTÃO DEPOIS DA CLÁUSULA, e "parcelado em" no meio.
  { msg: 'comprei uma geladeira em 12x de 250 no itaú crédito',
    expect: { acao: 'compra_parcelada', carteira: 'itaú crédito', numParcelas: 12, valorParcela: 250 } },
  { msg: 'comprei tênis no nubank crédito parcelado em 4x de 99,90',
    expect: { acao: 'compra_parcelada', numParcelas: 4, valorParcela: 99.9 } },

  // 4. ⚠️ VALOR TOTAL × VALOR DA PARCELA — o erro mais caro possível aqui.
  //    "em 10x de 300" é parcela (total 3000). "de 3000 … em 10x" é TOTAL
  //    (parcela 300). Trocar um pelo outro multiplica/divide o lançamento por N.
  { msg: 'comprei celular de 3000 no itaú crédito em 10x',
    expect: { acao: 'compra_parcelada', numParcelas: 10, valorParcela: 300, valorTotal: 3000 } },
  //    Frase do usuário do relato, por extenso e sem cartão citado.
  { msg: 'Comprei 50 reais em roupas dividir em duas parcelas',
    expect: { acao: 'compra_parcelada', numParcelas: 2, valorParcela: 25, valorTotal: 50, carteira: null, categoria: 'Vestuário' } },
  //    ⚠️ "2 camisas de 30" — pegar o PRIMEIRO número acharia a quantidade e
  //    lançaria R$ 2,00. O total certo é 30.
  { msg: 'comprei 2 camisas de 30 no nubank crédito em 3x',
    expect: { acao: 'compra_parcelada', numParcelas: 3, valorTotal: 30, valorParcela: 10 } },

  // 5. ⚠️ O QUE NÃO PODE VIRAR PARCELAMENTO. A cláusula exige a unidade
  //    (x|vezes|parcelas) justamente pra "em N <coisa>" não ser sequestrado.
  { msg: 'comprei pão em 2 padarias',          expect: null },
  //    "1x" é compra à vista — tratar como parcelamento criaria transação
  //    não-paga numa fatura futura.
  { msg: 'comprei uma tv em 1x de 500 no nubank crédito', expect: null },
  //    Sem cartão E sem valor não dá pra lançar nada: vai pra IA.
  { msg: 'comprei em 3x',                      expect: null },

  // 6. ⚠️ NÃO PODE ROUBAR O "SEM CARTÃO" (parcelamento vira dívida) nem os
  //    comandos de consulta/pagamento de parcela — eles vêm antes e continuam.
  { msg: 'comprei uma tv sem cartão em 3x de 200',
    expect: { acao: 'criar_divida', tipo: 'parcelamento', parcelas_total: 3, valor_parcela: 200 } },
  { msg: 'parcelei o notebook com joão em 5x de 300',
    expect: { acao: 'criar_divida', tipo: 'parcelamento', credor: 'joão' } },
  { msg: 'quitar parcelas da tv',              expect: { acao: 'antecipar_parcela' } },
  // Listar compras parceladas (comando novo + variações naturais)
  { msg: 'parcelas',                          expect: { acao: 'listar_parcelas' } },
  { msg: 'minhas parcelas',                   expect: { acao: 'listar_parcelas' } },
  { msg: 'como estão minhas parcelas',        expect: { acao: 'listar_parcelas' } },
  { msg: 'quantas parcelas tenho pra pagar',  expect: { acao: 'listar_parcelas' } },
  { msg: 'compras parceladas',                expect: { acao: 'listar_parcelas' } },
  { msg: 'parcelas em aberto',                expect: { acao: 'listar_parcelas' } },
  { msg: 'antecipar parcela do fone',         expect: { acao: 'antecipar_parcela', termo: 'fone' } }, // verbo continua ganhando
  // Gastos por cartão / conta (comando novo)
  { msg: 'gastos dos meus cartões',           expect: { acao: 'gastos_carteiras' } },
  { msg: 'quanto gastei nas contas',          expect: { acao: 'gastos_carteiras' } },
  { msg: 'gastos por cartão e conta',         expect: { acao: 'gastos_carteiras' } },
  { msg: 'quanto gastei no cartão',           expect: { acao: 'gastos_carteiras' } },

  // ── Contas bancárias ──────────────────────────────────────────────────────
  { msg: 'adicionar 200 no inter',           expect: { acao: 'adicionar_saldo', valor: 200 } },
  { msg: 'transferir 200 do nubank pro inter', expect: { acao: 'transferir', valor: 200 } },
  // AJUSTAR = conta que já existe → alterar_saldo (NUNCA set_wallet "conta criada").
  { msg: 'Ajustar mercado pago para 700',    expect: { acao: 'alterar_saldo', nome: 'mercado pago', valor: 700 } },
  { msg: 'ajustar nubank 850',               expect: { acao: 'alterar_saldo', nome: 'nubank', valor: 850 } },
  { msg: 'ajusta o saldo do inter pra 300',  expect: { acao: 'alterar_saldo', nome: 'inter', valor: 300 } },
  { msg: 'corrigir mercado pago para 621,25', expect: { acao: 'alterar_saldo', nome: 'mercado pago', valor: 621.25 } },
  // Guarda: criar conta continua sendo set_wallet
  { msg: 'nubank 1000',                      expect: { acao: 'set_wallet', nome: 'nubank', valor: 1000 } },

  // ── Limites ───────────────────────────────────────────────────────────────
  { msg: 'limite 2000',                       expect: { acao: 'set_meta', valor: 2000 } },
  { msg: 'meus limites',                      expect: { acao: 'meus_limites' } },

  // ── Dívidas / grupos / comandos simples ───────────────────────────────────
  { msg: 'minhas dívidas',                    expect: { acao: 'listar_dividas' } },
  { msg: 'criar grupo Família',               expect: { acao: 'criar_grupo' } },
  { msg: 'ajuda',                             expect: { acao: 'ajuda' } },
  { msg: 'painel',                            expect: { acao: 'painel' } },
  { msg: 'excluir última',                    expect: { acao: 'apagar' } },

  // ── Grow (roteia p/ handler do Grow) ──────────────────────────────────────
  { msg: 'comi 2 ovos e pão',                 expect: { acao: 'grow_refeicao' } },

  // ── DEVE CAIR PRA IA (parser devolve null — linguagem livre/coloquial) ─────
  { msg: 'como tá meu mês',                   expect: null },
  { msg: 'quanto eu tenho',                   expect: null },
  { msg: 'tô com quanto',                     expect: null },
  { msg: 'me mostra o que saiu de mercado',   expect: null },
  { msg: 'qual a capital da frança',          expect: null },
  { msg: 'bom dia',                           expect: null },
  // ── "QUANTO GASTEI COM X EM <PERÍODO>" ─────────────────────────────────
  //
  // ⚠️ O PERÍODO TEM DE SAIR DE DENTRO DO TERMO. A regra casava o assunto até
  // o fim da frase, então "quanto gastei com mercado livre em setembro" ia
  // procurar por "mercado livre em setembro" — nome que não existe em
  // transação nenhuma. A resposta era "nenhum gasto encontrado", e parecia
  // que a Sora não sabia responder quando na verdade ela procurou errado.
  { msg: 'Quanto gastei com mercado livre em setembro?', expect: { acao: 'buscar', termo: 'mercado livre' } },
  { msg: 'quanto gastei com ifood esse mês?', expect: { acao: 'buscar', termo: 'ifood', periodo: 'mes' } },
  { msg: 'quanto gastei com uber mês passado?', expect: { acao: 'buscar', termo: 'uber', periodo: 'mes_passado' } },
  { msg: 'quanto gastei com farmácia nos últimos 3 meses?', expect: { acao: 'buscar', termo: 'farmácia' } },
  { msg: 'quanto gastei com netflix em julho e agosto?', expect: { acao: 'buscar', termo: 'netflix' } },
  { msg: 'quanto gastei com alimentação em março?', expect: { acao: 'buscar', termo: 'alimentação' } },
  // Abreviação só depois de preposição — ver a nota em ABREV_PT.
  { msg: 'quanto gastei com padaria em ago?', expect: { acao: 'buscar', termo: 'padaria' } },

  // ⚠️ SEM PERÍODO CITADO, NADA MUDA. É a metade que prova que o parser novo
  //    não sequestrou as buscas que já funcionavam.
  { msg: 'quanto gastei com mercado?', expect: { acao: 'buscar', termo: 'mercado' } },
  { msg: 'gastos com alimentação', expect: { acao: 'buscar', termo: 'alimentação' } },

  // ⚠️ E O QUE NÃO É PERGUNTA DE PERÍODO CONTINUA ONDE ESTAVA.
  { msg: 'quanto gastei esse mês?', expect: { acao: 'resumo', periodo: 'mes' } },
  { msg: 'no que gasto mais?', expect: { acao: 'resumo' } },
  { msg: 'quero cadastrar um gasto fixo', expect: null },
];

// Match parcial: cada campo de `expect` precisa bater no resultado.
function bate(expect, got) {
  if (expect === null) return got === null || got === undefined;
  if (!got) return false;
  for (const k of Object.keys(expect)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(expect[k])) return false;
  }
  return true;
}

let ok = 0;
const falhas = [];
for (const { msg, expect } of CASOS) {
  const got = interpretarRapido(msg);
  const passou = bate(expect, got);
  if (passou) ok++; else falhas.push({ msg, expect, got });
  const alvo = expect === null ? '→ IA' : (expect.acao || '(campos)');
  console.log(`${passou ? '  ok ' : 'FALHA'}  ${alvo.padEnd(18)} « ${msg} »`);
}

// ── PERÍODO POR EXTENSO: as DATAS ───────────────────────────────────────────
//
// Os casos acima conferem a AÇÃO e o TERMO, que não dependem de hoje. As datas
// dependem — então aqui elas são calculadas a partir da data de hoje, e não
// cravadas. Cravar faria o eval passar hoje e falhar em outubro.
console.log('\n── período por extenso (datas) ──');
const [Y, M] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).split('-').map(Number);
const primeiro = (ano, mes) => new Date(Date.UTC(ano + Math.floor((mes - 1) / 12), ((mes - 1) % 12 + 12) % 12, 1, 3)).toISOString();
const dia = (d) => (d ? d.toISOString() : null);

const CASOS_PERIODO = [
  // frase, início esperado, fim esperado, rótulo
  ['gastei com x em setembro', primeiro(9 > M ? Y - 1 : Y, 9), primeiro(9 > M ? Y - 1 : Y, 10), 'EM SETEMBRO'],
  // ⚠️ MÊS QUE AINDA NÃO CHEGOU É DO ANO PASSADO. Perguntar quanto se gastou
  //    num mês futuro não é pergunta que alguém faz; devolver R$ 0,00 seria
  //    resposta boba pra uma pergunta que era sobre o passado.
  ['gastei com x em dezembro', primeiro(12 > M ? Y - 1 : Y, 12), primeiro(12 > M ? Y : Y + 1, 1), 'EM DEZEMBRO'],
  // Dois meses viram UM intervalo contíguo, não dois pedaços.
  ['gastei com x em julho e agosto', primeiro(7 > M ? Y - 1 : Y, 7), primeiro(8 > M ? Y - 1 : Y, 9), 'EM JULHO E AGOSTO'],
  // Ordem invertida dá o mesmo intervalo — quem fala não ordena.
  ['gastei com x em agosto e julho', primeiro(7 > M ? Y - 1 : Y, 7), primeiro(8 > M ? Y - 1 : Y, 9), 'EM JULHO E AGOSTO'],
  // "Últimos N" INCLUI o mês corrente.
  ['gastei com x nos últimos 3 meses', primeiro(Y, M - 2), primeiro(Y, M + 1), 'NOS ÚLTIMOS 3 MESES'],
  ['gastei com x nos últimos 6 meses', primeiro(Y, M - 5), primeiro(Y, M + 1), 'NOS ÚLTIMOS 6 MESES'],
  ['gastei com x nos últimos 12 meses', primeiro(Y, M - 11), primeiro(Y, M + 1), 'NOS ÚLTIMOS 12 MESES'],
];

for (const [frase, ini, fim, rotulo] of CASOS_PERIODO) {
  const r = parsePeriodoExtenso(frase);
  const bateu = r && dia(r.inicio) === ini && dia(r.fim) === fim && r.label === rotulo;
  if (bateu) ok += 1;
  else falhas.push({ msg: frase, expect: { inicio: ini, fim, label: rotulo }, got: r && { inicio: dia(r.inicio), fim: dia(r.fim), label: r.label } });
  console.log(`${bateu ? '  ok ' : 'FALHA'}  ${String(rotulo).padEnd(22)} « ${frase} »`);
}

// ⚠️ ABREVIAÇÃO SOLTA NÃO É MÊS. "mar", "set" e "ago" são palavras comuns:
//    sem preposição na frente, "gastei no mar" viraria um filtro de março.
const NAO_E_PERIODO = [
  'quanto gastei no mar',
  'quanto gastei com passeio de mar',
  'quanto gastei com mercado',
  'quanto gastei esse mês',
];
for (const frase of NAO_E_PERIODO) {
  const r = parsePeriodoExtenso(frase);
  const bateu = r === null;
  if (bateu) ok += 1;
  else falhas.push({ msg: frase, expect: null, got: r && r.label });
  console.log(`${bateu ? '  ok ' : 'FALHA'}  ${'(sem período)'.padEnd(22)} « ${frase} »`);
}

const total = CASOS.length + CASOS_PERIODO.length + NAO_E_PERIODO.length;
console.log(`\n${ok}/${total} certas` + (falhas.length ? ` · ${falhas.length} FALHA(S) ❌` : ' · tudo passou ✅'));

if (falhas.length) {
  console.log('\n── Falhas (o que veio ≠ o esperado) ──');
  for (const f of falhas) {
    console.log(`  « ${f.msg} »`);
    console.log(`    esperado: ${JSON.stringify(f.expect)}`);
    console.log(`    veio:     ${JSON.stringify(f.got)}`);
  }
  process.exit(1);
}
