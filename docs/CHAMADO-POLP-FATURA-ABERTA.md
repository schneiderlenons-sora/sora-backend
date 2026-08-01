Oi, tudo bem? Preciso de ajuda com o cartão de crédito no Open Finance.

O problema é o seguinte: eu não consigo descobrir, pela API de vocês, quanto está a fatura ATUAL do cartão (a que ainda não fechou). Testei em uma conta Nubank nossa e o app do banco mostrava 3.423,57. Nenhum dado que a API devolve bate com esse valor.

O mais perto que eu chego é o limite usado, que veio 4.061,99. Ou seja, 638,42 a mais do que a fatura real. Imagino que essa diferença sejam parcelas de faturas futuras, que já ocupam o limite mas ainda não entraram nessa fatura. Só que eu não consigo descontar essas parcelas, porque nenhuma informação que vocês mandam me permite saber quais são.

Vou detalhar os quatro pontos que travam isso, na ordem do que mais me atrapalha:

1) A fatura aberta não aparece em lugar nenhum

Quando eu listo as faturas do cartão, vêm 12, e todas já fecharam e foram pagas. A mais recente fechou em 07/07 e venceu em 14/07. Só que na data da consulta (01/08) já existia uma fatura aberta, que fecha em 07/08 e vence em 14/08 — e ela não vem na lista.

Essa fatura aberta está disponível em algum outro endpoint? Se não estiver, como vocês recomendam que eu mostre o valor parcial dela pro cliente?

2) A lista de parcelamentos vem repetida, com valores que se contradizem

A mesma compra aparece várias vezes, com o número de parcelas pagas diferente em cada uma. Por exemplo, uma compra no Mercado Livre aparece três vezes:

uma dizendo 52,20 em 5x com 3 parcelas pagas
outra dizendo 52,23 em 5x com 1 parcela paga
outra dizendo 52,19 em 5x com 5 parcelas pagas

Isso se repete em pelo menos mais seis compras (Amazon, Shein, entre outras). Como as três se contradizem, eu não tenho como saber quantas parcelas faltam de verdade.

Essas linhas repetidas são a mesma compra ou são compras diferentes? Se for a mesma, qual delas está com o número certo de parcelas pagas? E existe algum identificador que me permita juntar as repetidas?

3) A parcela vem com a data da compra, e sem dizer em qual fatura ela entra

Nas transações do cartão, cada parcela chega com a data em que a compra foi feita, não com a data em que ela vai ser cobrada. E as transações da fatura que ainda está aberta vêm sem o campo que identifica a fatura (40 das 170 que recebi estavam assim).

Com isso eu não tenho como saber em qual fatura cada parcela vai cair: pela data, todas caem no mês da compra; pelo vínculo, não tem vínculo nenhum.

Existe algum campo que diga em qual fatura a parcela será cobrada? E esse campo de fatura só é preenchido depois que ela fecha — isso é assim por escolha de vocês ou é limitação do banco?

4) Os limites do cartão vêm com nomes que não batem

Quando eu consulto os limites, vêm duas linhas e nenhuma delas é do tipo "limite total". O limite total do cartão (5.063,10, que confere com o app) aparece dentro de uma linha chamada "Limite saque nacional e saque internacional", o que não faz muito sentido.

Além disso, o valor de limite usado (4.061,99) não bate com o limite total menos o disponível. Ele bate com o limite personalizado (4.750,00) menos o disponível (688,01).

Nesse banco, qual das linhas eu devo ler como limite total do cartão? E o limite usado é sempre calculado em cima do limite personalizado quando ele existe? Isso está documentado em algum lugar?

Pra fechar: qualquer uma dessas três coisas já resolveria pro meu lado.

Vocês passarem a mostrar a fatura aberta com o valor acumulado até agora.
Ou preencherem o campo de fatura nas transações do ciclo atual e nas parcelas futuras.
Ou corrigirem a repetição na lista de parcelamentos, com o número de parcelas pagas confiável.

Hoje eu mostro pro cliente a soma das compras do período com um aviso de que é parcial. Funciona, mas fica sempre abaixo do valor real quando a pessoa tem compra parcelada.

Se ajudar, eu mando os identificadores da conexão e do cartão pra vocês olharem direto no ambiente de vocês. É uma conta de teste nossa, com autorização do titular.
