'use strict';
process.env.TZ = 'America/Fortaleza';
process.env.BRASERO_SEGREDO_SESSAO = 'segredo-de-teste-123';
process.env.SNAPSHOT_TTL_MS = '0';
const assert = require('assert');
const {criarMock} = require('./mock-sheets');
const {criarRuntime, criarApp} = require('../lib/app');

const serialDe = (d, m, a, h, mi) => (Date.UTC(a, m - 1, d, h, mi) - Date.UTC(1899, 11, 30)) / 864e5;
const mock = criarMock([
  {title: 'cardapio', linhas: [['ID', 'Nome', 'Categoria', 'Preco', 'Status', 'Ordem_Exibicao'],
    ['PRD-001', 'Espetinho de carne', 'Espetos', 12, 'Ativo', 1]]},
  {title: 'rascunhos_abertos', linhas: [['Cliente_Mesa', 'Itens_JSON', 'Revision', 'Status', 'Atendente', 'Observacoes_JSON', 'Criado_Em_ISO', 'Atualizado_Em_ISO']]},
  {title: 'comandas_fechadas', linhas: [['ID', 'Data', 'Mesa', 'Produto', 'Categoria', 'Qtd', 'Preco', 'Subtotal', 'Forma', 'Atendente', 'Observacao_Item'],
    ['CMD-legado-0001', {serial: serialDe(1, 11, 2026, 20, 5)}, 'MESA 1', 'Espetinho de carne', 'Espetos', 2, 12, 24, 'PIX', 'Ana', '']]},
  {title: 'resumo_fechamentos', linhas: [['ID', 'Data', 'Mesa', 'Qtd', 'Total', 'Forma', 'Obs', 'Atendente', 'Pagamentos_JSON'],
    ['CMD-legado-0001', {serial: serialDe(1, 11, 2026, 20, 5)}, 'MESA 1', 2, 24, 'PIX', '', 'Ana', '']]}
]);

(async () => {
  const rt = criarRuntime({sheets: mock});
  // Setup (equivale a rodar prepararEstruturaBraseroV6 no editor)
  const log = await rt.executar('prepararEstruturaBraseroV6', []);
  const senhaAdmin = /senha: (\S+)/.exec(log)[1];
  assert.ok(['usuarios', 'financeiro', 'eventos', 'contas_pagar', 'fechamento_caixa'].every(t => mock.abas.some(a => a.title === t)));
  assert.strictEqual(rt.propsDefinidas.get('BRASERO_FIN_INICIO'), require('../lib/runtime').formatarData(new Date(), 'America/Fortaleza', 'yyyy-MM-dd'));
  process.env.BRASERO_FIN_INICIO = '2026-01-01';
  rt.props.delete('BRASERO_FIN_INICIO');
  assert.strictEqual(await rt.executar('prepararEstruturaBraseroV6', []).then(m => /Nada novo/.test(m)), true);

  const srv = criarApp(rt).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  let token = '';
  const api = async (f, d = {}) => {
    const r = await fetch(`${base}/api/${f}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...d, token})});
    return {status: r.status, ...(await r.json())};
  };
  const ok = async (f, d) => { const r = await api(f, d); assert.strictEqual(r.ok, true, f + ' → ' + JSON.stringify(r)); return r; };

  // Segurança: funções de manutenção não ficam expostas
  assert.strictEqual((await api('emergenciaNovaSenhaAdmin')).status, 404);
  assert.strictEqual((await api('prepararEstruturaBraseroV6')).status, 404);
  assert.strictEqual((await api('hashSenha_')).status, 404);
  assert.strictEqual((await api('menuBrasero')).code, 'SESSAO');
  assert.strictEqual((await api('loginBrasero', {usuario: 'admin', senha: 'errada'})).code, 'LOGIN');

  token = (await ok('loginBrasero', {usuario: 'admin', senha: senhaAdmin})).token;
  await ok('sessaoBrasero');
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('data:image/webp;base64') && !html.includes('<?') && html.includes("fetch('api/'"));

  // Cardápio
  await ok('salvarProdutoBrasero', {nome: 'Coca-Cola lata', categoria: 'Bebidas', preco: 6.5, status: 'Ativo'});
  const menu = (await ok('menuBrasero')).cardapio;
  assert.deepStrictEqual(menu.map(p => p.id), ['PRD-001', 'PRD-002']);
  const coca = menu[1];
  await ok('salvarProdutoBrasero', {id: coca.id, revision: coca.revision, nome: 'Coca-Cola lata', categoria: 'Bebidas', preco: 7, status: 'Ativo'});
  assert.strictEqual((await api('salvarProdutoBrasero', {id: coca.id, revision: coca.revision, nome: 'X', categoria: 'Bebidas', preco: 7})).code, 'CONFLITO_CARDAPIO');

  // Comanda: abrir, editar, conflito, fechar com pagamento misto
  let r = await ok('salvarRascunhoBrasero', {clienteMesa: 'mesa 5', itens: {'PRD-001': 3, 'PRD-002': 2}, observacoes: {'PRD-001': 'bem passado'}, criadoEm: new Date().toISOString()});
  const rev1 = r.revision;
  assert.strictEqual((await api('salvarRascunhoBrasero', {clienteMesa: 'MESA 5', itens: {'PRD-001': 1}, revision: 'velha'})).code, 'CONFLITO');
  r = await ok('salvarRascunhoBrasero', {clienteMesa: 'MESA 5', itens: {'PRD-001': 3, 'PRD-002': 2}, revision: rev1});
  assert.strictEqual((await ok('rascunhosBrasero')).rascunhos[0].observacoes['PRD-001'], 'bem passado');
  await ok('salvarRascunhoBrasero', {clienteMesa: 'MESA 9', itens: {'PRD-002': 1}});
  // total produtos 3*12 + 2*7 = 50 → 30 PIX + 20 crédito (+5% = 1,00) = 51
  const fechar = {idFechamento: 'CMD-teste-0000001', clienteMesa: 'MESA 5', revision: r.revision,
    pagamentos: [{forma: 'PIX', base: 30}, {forma: 'Cartão Crédito', base: 20}], formaPagamento: 'PIX + Cartão Crédito', totalExibido: 51};
  const f = await ok('fecharComandaBrasero', fechar);
  assert.strictEqual(f.total, 51);
  assert.strictEqual((await ok('fecharComandaBrasero', fechar)).jaGravada, true);
  const rasc = (await ok('rascunhosBrasero')).rascunhos;
  assert.deepStrictEqual(rasc.map(x => x.clienteMesa), ['MESA 9']);
  await ok('excluirRascunhoBrasero', {clienteMesa: 'MESA 9', revision: rasc[0].revision});
  assert.strictEqual((await ok('rascunhosBrasero')).rascunhos.length, 0);

  // Data gravada como data real na planilha (igual Apps Script)
  const resumo = mock.abas.find(a => a.title === 'resumo_fechamentos');
  assert.strictEqual(resumo.cells[2][1].fmt.type, 'DATE_TIME');
  assert.strictEqual(typeof resumo.cells[2][1].v, 'number');

  // Histórico (inclui a linha legada com data serial)
  const hist = await ok('fechadasBrasero', {inicio: '2026-11-01', fim: '2026-12-31'});
  assert.strictEqual(hist.quantidade, 2, JSON.stringify(hist));
  assert.strictEqual(hist.totalPeriodo, 75);
  assert.ok(hist.fechadas.find(c => c.id === 'CMD-legado-0001').dataHora === '01/11/2026 20:05:00');
  assert.deepStrictEqual((await ok('maisVendidosBrasero')).ids, ['PRD-001', 'PRD-002']);
  await ok('relatorioCompletoBrasero', {inicio: '2026-11-01', fim: '2026-11-30'});

  // Financeiro
  await ok('lancarFinanceiroBrasero', {tipo: 'Saída', valor: 10, forma: 'Dinheiro', categoria: 'Gelo', descricao: '-gelo'});
  await ok('lancarFinanceiroBrasero', {tipo: 'Entrada', valor: 100, forma: 'Dinheiro', categoria: 'Saldo inicial'});
  const painel = await ok('financeiroPainelBrasero');
  // Caixa: 100 - 10 (sem vendas em dinheiro) | Banco: 24 + 30 + 21 = 75
  assert.deepStrictEqual(painel.saldos, {caixa: 90, banco: 75, total: 165});
  const gelo = painel.movimentos.find(m => m.categoria === 'Gelo');
  assert.strictEqual(gelo.descricao, '-gelo');
  assert.strictEqual(gelo.data, require('../lib/runtime').formatarData(new Date(), 'America/Fortaleza', 'yyyy-MM-dd'));
  await ok('transferirContaBrasero', {origem: 'Caixa', valor: 50});
  await ok('estornarLancamentoBrasero', {id: gelo.id, motivo: 'lançado errado'});
  const caixa = await ok('caixaBrasero');
  assert.strictEqual(caixa.esperado, 50);
  await ok('registrarFechamentoCaixaBrasero', {contado: 48, esperadoVisto: 50});
  assert.strictEqual((await ok('caixaBrasero')).historico[0].diferenca, -2);
  await ok('saidasHojeBrasero');

  // Contas a pagar
  await ok('salvarContaPagarBrasero', {descricao: 'Aluguel', categoria: 'Fixas', valor: 1500, vencimento: '2026-11-10', repetirMeses: 3});
  let contas = (await ok('contasPagarBrasero')).contas;
  assert.strictEqual(contas.length, 3);
  assert.deepStrictEqual(contas.map(c => c.vencimento), ['2026-11-10', '2026-12-10', '2027-01-10']);
  const pg = await ok('pagarContaBrasero', {id: contas[0].id, forma: 'PIX'});
  await ok('cancelarContaPagarBrasero', {id: contas[2].id});
  await ok('salvarContaPagarBrasero', {id: contas[1].id, descricao: 'Aluguel dez', categoria: 'Fixas', valor: 1600, vencimento: '2026-12-10'});
  await ok('estornarLancamentoBrasero', {id: pg.lancamentoId, motivo: 'teste estorno'});
  contas = (await ok('contasPagarBrasero')).contas;
  assert.strictEqual(contas.find(c => c.id === contas[0].id).status, 'Aberta');

  // Eventos
  const ev = await ok('salvarEventoBrasero', {nome: 'Aniversário', cliente: 'João', telefone: '(85) 99999-0000', data: '2026-12-20',
    pessoas: 40, tipo: 'Rodízio', valorTotal: 2000, custoPrevisto: 1200, nmdo: 300, status: 'Confirmado'});
  await ok('lancarFinanceiroBrasero', {tipo: 'Entrada', valor: 500, forma: 'PIX', categoria: 'Sinal evento', eventoId: ev.id});
  const evs = await ok('eventosBrasero');
  assert.strictEqual(evs.eventos[0].aReceber, 1500);
  assert.strictEqual(evs.eventos[0].data, '2026-12-20');
  await ok('salvarEventoBrasero', {id: ev.id, nome: 'Aniversário 2', cliente: 'João', data: '2026-12-21', pessoas: 40, tipo: 'Rodízio', valorTotal: 2000, status: 'Confirmado'});
  assert.strictEqual((await ok('eventoDetalheBrasero', {id: ev.id})).lancamentos.length, 1);

  // Usuários
  await ok('salvarUsuarioBrasero', {novo: true, usuario: 'maria', nome: 'Maria', perfil: 'Atendente', senha: 'maria123'});
  assert.strictEqual((await ok('usuariosBrasero')).usuarios.length, 2);
  const tokenAdmin = token;
  token = (await ok('loginBrasero', {usuario: 'maria', senha: 'maria123'})).token;
  assert.strictEqual((await api('financeiroPainelBrasero')).code, 'PERMISSAO');
  assert.strictEqual((await api('lancarFinanceiroBrasero', {tipo: 'Entrada', valor: 1, forma: 'PIX', categoria: 'x'})).code, 'PERMISSAO');
  const hoje = await ok('fechadasBrasero', {inicio: '2020-01-01', fim: '2030-01-01'});
  assert.strictEqual(hoje.inicio, hoje.fim);
  token = (await ok('trocarSenhaBrasero', {senhaAtual: 'maria123', novaSenha: 'nova4567'})).token;
  await ok('menuBrasero');
  token = tokenAdmin;
  await ok('salvarUsuarioBrasero', {usuario: 'maria', nome: 'Maria', perfil: 'Atendente', ativo: false});
  assert.strictEqual((await api('loginBrasero', {usuario: 'maria', senha: 'nova4567'})).code, 'LOGIN');
  assert.strictEqual((await api('salvarUsuarioBrasero', {usuario: 'admin', nome: 'Adm', perfil: 'Atendente'})).code, 'ULTIMO_ADMIN');

  // Bloqueio após 5 erros
  for (let i = 0; i < 5; i++) await api('loginBrasero', {usuario: 'admin', senha: 'x'});
  assert.strictEqual((await api('loginBrasero', {usuario: 'admin', senha: senhaAdmin})).code, 'BLOQUEADO');

  // Reset de senha do admin (script local)
  const nova = /admin: (\S+)/.exec(await rt.executar('emergenciaNovaSenhaAdmin', []))[1];
  assert.ok((await ok('loginBrasero', {usuario: 'admin', senha: nova})).token);
  assert.strictEqual((await api('menuBrasero', {token: tokenAdmin})).code, 'SESSAO'); // versão mudou

  // Concorrência: 10 rascunhos em paralelo não se atropelam
  token = (await ok('loginBrasero', {usuario: 'admin', senha: nova})).token;
  await Promise.all(Array.from({length: 10}, (_, i) => ok('salvarRascunhoBrasero', {clienteMesa: 'MESA ' + (20 + i), itens: {'PRD-001': 1}})));
  assert.strictEqual((await ok('rascunhosBrasero')).rascunhos.length, 10);

  // Edição externa na planilha é enxergada (TTL 0)
  mock.abas.find(a => a.title === 'cardapio').cells[1][1].v = 'Espeto editado na planilha';
  assert.strictEqual((await ok('menuBrasero')).cardapio[0].nome, 'Espeto editado na planilha');

  srv.close();
  console.log(`OK · todos os fluxos passaram (${mock.stats.leituras} leituras, ${mock.stats.escritas} escritas na API)`);
})().catch(e => { console.error(e); process.exit(1); });
