// =====================================================================
// BRASERO 96 · LOGIN, USUÁRIOS E SESSÃO
// Senhas guardadas com hash + salt (nunca a senha pura).
// Sessão: token assinado (HMAC) válido por 12 horas, conferido em TODA
// função do servidor através de exigirSessao_().
// =====================================================================

const PERFIS_BRASERO_ = ['Admin', 'Atendente'];
const SO_ADMIN_ = ['Admin'];
const SESSAO_HORAS_ = 12;
const RODADAS_SENHA_ = 400;
const COLS_USUARIOS_ = 9; // Usuario | Nome | Perfil | Senha_Hash | Salt | Ativo | Versao | Criado_Em | Ultimo_Acesso

function erroBrasero_(code, mensagem) {
  const e = new Error(mensagem);
  e.code = code;
  return e;
}

function b64_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function segredoSessao_() {
  const props = PropertiesService.getScriptProperties();
  let segredo = props.getProperty('BRASERO_SEGREDO_SESSAO');
  if (!segredo) {
    segredo = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('BRASERO_SEGREDO_SESSAO', segredo);
  }
  return segredo;
}

function hashSenha_(senha, salt, rodadas) {
  let atual = salt;
  for (let i = 0; i < rodadas; i++)
    atual = b64_(Utilities.computeHmacSha256Signature(atual + '|' + senha, salt));
  return 'v1$' + rodadas + '$' + atual;
}

function iguais_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function senhaConfere_(senha, usuario) {
  const partes = String(usuario.hash || '').split('$');
  if (partes.length !== 3 || partes[0] !== 'v1' || !usuario.salt) return false;
  return iguais_(hashSenha_(senha, usuario.salt, Number(partes[1]) || RODADAS_SENHA_), usuario.hash);
}

function validarSenhaNova_(senha) {
  senha = String(senha || '');
  if (senha.length < 6 || senha.length > 64) throw erroBrasero_('SENHA_FRACA', 'A senha deve ter de 6 a 64 caracteres.');
  return senha;
}

function lerUsuarios_(semCache) {
  const cache = CacheService.getScriptCache();
  if (!semCache) {
    const salvo = cache.get('brasero_usuarios_v1');
    if (salvo) try { return JSON.parse(salvo); } catch (_) {}
  }
  const lista = linhas_(brasero_('usuarios'), COLS_USUARIOS_)
    .map((r, i) => ({
      linha: i + 2,
      usuario: String(r[0] || '').trim().toLowerCase(),
      nome: String(r[1] || '').trim(),
      perfil: String(r[2] || '').trim() === 'Admin' ? 'Admin' : 'Atendente',
      hash: String(r[3] || ''),
      salt: String(r[4] || ''),
      ativo: String(r[5] || 'Sim').trim() !== 'Não',
      versao: Number(r[6]) || 1,
      criadoEm: String(r[7] || ''),
      ultimoAcesso: String(r[8] || '')
    }))
    .filter(u => u.usuario);
  cache.put('brasero_usuarios_v1', JSON.stringify(lista), 120);
  return lista;
}

function limparCacheUsuarios_() {
  CacheService.getScriptCache().remove('brasero_usuarios_v1');
}

function criarToken_(u) {
  const payload = b64_(Utilities.newBlob(JSON.stringify({
    u: u.usuario, v: u.versao, exp: Date.now() + SESSAO_HORAS_ * 3600000
  })).getBytes());
  return payload + '.' + b64_(Utilities.computeHmacSha256Signature(payload, segredoSessao_()));
}

function lerToken_(token) {
  const partes = String(token || '').split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
  const esperado = b64_(Utilities.computeHmacSha256Signature(partes[0], segredoSessao_()));
  if (!iguais_(partes[1], esperado)) return null;
  try {
    const comPad = partes[0] + '='.repeat((4 - partes[0].length % 4) % 4);
    return JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(comPad)).getDataAsString());
  } catch (_) { return null; }
}

function usuarioPublico_(u) {
  return {usuario: u.usuario, nome: u.nome, perfil: u.perfil};
}

// Confere o token enviado pela tela. Lança erro SESSAO ou PERMISSAO.
function exigirSessao_(dados, perfis) {
  const t = lerToken_(dados && dados.token);
  if (!t || !(Number(t.exp) > Date.now())) throw erroBrasero_('SESSAO', 'Sua sessão expirou. Entre novamente.');
  const u = lerUsuarios_().find(x => x.usuario === t.u);
  if (!u || !u.ativo || u.versao !== t.v) throw erroBrasero_('SESSAO', 'Sessão encerrada. Entre novamente.');
  if (perfis && !perfis.includes(u.perfil))
    throw erroBrasero_('PERMISSAO', 'Seu usuário não tem permissão para esta ação.');
  return {usuario: u.usuario, nome: u.nome || u.usuario, perfil: u.perfil, admin: u.perfil === 'Admin', exp: Number(t.exp)};
}

// ---------------------------------------------------------------------
// Funções chamadas pela tela
// ---------------------------------------------------------------------

function loginBrasero(dados) {
  try {
    dados = dados || {};
    const usuario = String(dados.usuario || '').trim().toLowerCase().slice(0, 40);
    const senha = String(dados.senha || '');
    if (!usuario || !senha) return falha_('LOGIN', 'Informe usuário e senha.');
    const cache = CacheService.getScriptCache(), chave = 'brasero_falhas_' + usuario;
    const falhas = Number(cache.get(chave)) || 0;
    if (falhas >= 5) return falha_('BLOQUEADO', 'Muitas tentativas erradas. Aguarde 10 minutos e tente de novo.');
    const u = lerUsuarios_().find(x => x.usuario === usuario);
    if (!u || !u.ativo || !senhaConfere_(senha, u)) {
      cache.put(chave, String(falhas + 1), 600);
      return falha_('LOGIN', 'Usuário ou senha incorretos.');
    }
    cache.remove(chave);
    try {
      const aba = brasero_('usuarios');
      if (String(aba.getRange(u.linha, 1).getValue()).trim().toLowerCase() === u.usuario)
        aba.getRange(u.linha, 9).setValue(agora_());
    } catch (_) {}
    return {ok: true, token: criarToken_(u), expira: Date.now() + SESSAO_HORAS_ * 3600000, usuario: usuarioPublico_(u)};
  } catch (e) { return retornoErro_(e); }
}

// Confere a sessão ao abrir o app e renova o token quando falta pouco para expirar.
function sessaoBrasero(dados) {
  try {
    const s = exigirSessao_(dados);
    const resposta = {ok: true, usuario: {usuario: s.usuario, nome: s.nome, perfil: s.perfil}, expira: s.exp};
    if (s.exp - Date.now() < 6 * 3600000) {
      const u = lerUsuarios_().find(x => x.usuario === s.usuario);
      resposta.token = criarToken_(u);
      resposta.expira = Date.now() + SESSAO_HORAS_ * 3600000;
    }
    return resposta;
  } catch (e) { return retornoErro_(e); }
}

function usuariosBrasero(dados) {
  try {
    exigirSessao_(dados, SO_ADMIN_);
    return {ok: true, usuarios: lerUsuarios_(true).map(u => ({
      usuario: u.usuario, nome: u.nome, perfil: u.perfil, ativo: u.ativo,
      criadoEm: u.criadoEm, ultimoAcesso: u.ultimoAcesso
    }))};
  } catch (e) { return retornoErro_(e); }
}

function salvarUsuarioBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    const sessao = exigirSessao_(dados, SO_ADMIN_);
    const aba = brasero_('usuarios'), lista = lerUsuarios_(true);
    const usuario = String(dados.usuario || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(usuario))
      return falha_('USUARIO_INVALIDO', 'Usuário: de 3 a 30 letras minúsculas, números, ponto, hífen ou _ (sem espaço).');
    const nome = textoCardapio_(dados.nome, 'Nome', 60);
    const perfil = PERFIS_BRASERO_.includes(dados.perfil) ? dados.perfil : null;
    if (!perfil) return falha_('PERFIL_INVALIDO', 'Selecione o perfil.');
    const ativo = dados.ativo !== false;
    const existente = lista.find(u => u.usuario === usuario);
    if (dados.novo && existente) return falha_('DUPLICADO', 'Já existe um usuário com esse login.');
    if (!dados.novo && !existente) return falha_('NAO_ENCONTRADO', 'Usuário não encontrado. Atualize a lista.');

    const adminsAtivos = lista.filter(u => u.perfil === 'Admin' && u.ativo && u.usuario !== usuario).length;
    if ((perfil !== 'Admin' || !ativo) && adminsAtivos === 0)
      return falha_('ULTIMO_ADMIN', 'É preciso manter pelo menos um administrador ativo.');

    if (existente) {
      let versao = existente.versao, hash = existente.hash, salt = existente.salt;
      const senha = String(dados.senha || '');
      if (senha) { validarSenhaNova_(senha); salt = Utilities.getUuid(); hash = hashSenha_(senha, salt, RODADAS_SENHA_); }
      if (senha || perfil !== existente.perfil || ativo !== existente.ativo) versao++;
      aba.getRange(existente.linha, 1, 1, 7).setValues([[usuario, nome, perfil, hash, salt, ativo ? 'Sim' : 'Não', versao]]);
    } else {
      const senha = validarSenhaNova_(dados.senha);
      const salt = Utilities.getUuid();
      aba.appendRow([usuario, nome, perfil, hashSenha_(senha, salt, RODADAS_SENHA_), salt, ativo ? 'Sim' : 'Não', 1, agora_(), '']);
    }
    limparCacheUsuarios_();
    return {ok: true, proprio: usuario === sessao.usuario};
  });
}

function trocarSenhaBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    const sessao = exigirSessao_(dados);
    const u = lerUsuarios_(true).find(x => x.usuario === sessao.usuario);
    if (!senhaConfere_(String(dados.senhaAtual || ''), u)) return falha_('SENHA_ATUAL', 'Senha atual incorreta.');
    const nova = validarSenhaNova_(dados.novaSenha);
    const salt = Utilities.getUuid();
    u.versao++;
    brasero_('usuarios').getRange(u.linha, 4, 1, 4).setValues([[hashSenha_(nova, salt, RODADAS_SENHA_), salt, u.ativo ? 'Sim' : 'Não', u.versao]]);
    limparCacheUsuarios_();
    return {ok: true, token: criarToken_(u), expira: Date.now() + SESSAO_HORAS_ * 3600000};
  });
}

// =====================================================================
// INSTALAÇÃO · executar UMA vez pelo editor (Executar ▶ prepararEstruturaBraseroV6)
// Cria as abas novas, o segredo da sessão e o primeiro administrador.
// A senha do admin aparece no "Registro de execução".
// =====================================================================
function prepararEstruturaBraseroV6() {
  const ss = SpreadsheetApp.openById(BRASERO_CONFIG.PLANILHA_ID);
  const abas = {
    usuarios: ['Usuario', 'Nome', 'Perfil', 'Senha_Hash', 'Salt', 'Ativo', 'Versao', 'Criado_Em', 'Ultimo_Acesso'],
    financeiro: ['ID', 'Data', 'Tipo', 'Conta', 'Categoria', 'Descricao', 'Valor', 'Forma', 'Evento_ID', 'Conta_Pagar_ID',
      'Origem', 'Status', 'Usuario', 'Criado_Em', 'Estornado_Por', 'Estornado_Em', 'Motivo_Estorno'],
    eventos: ['ID', 'Nome', 'Cliente', 'Telefone', 'Data', 'Pessoas', 'Tipo_Cobranca', 'Valor_Pessoa', 'Valor_Total',
      'Status', 'Observacao', 'Usuario', 'Criado_Em', 'Atualizado_Em', 'Pacote', 'Custo_Previsto', 'NMDO', 'Cortesia'],
    contas_pagar: ['ID', 'Descricao', 'Categoria', 'Valor', 'Vencimento', 'Status', 'Pago_Em', 'Lancamento_ID',
      'Usuario', 'Criado_Em', 'Observacao', 'Forma_Pagamento'],
    fechamento_caixa: ['ID', 'Data', 'Esperado', 'Contado', 'Diferenca', 'Observacao', 'Usuario', 'Criado_Em', 'Lancamento_ID']
  };
  const colunasTexto = {financeiro: [2], eventos: [5], contas_pagar: [5, 7], fechamento_caixa: [2]};
  const colunasValor = {financeiro: [7], eventos: [8, 9, 16, 17], contas_pagar: [4], fechamento_caixa: [3, 4, 5]};
  const log = [];
  for (const [nome, cabecalho] of Object.entries(abas)) {
    let aba = ss.getSheetByName(nome);
    if (!aba) {
      aba = ss.insertSheet(nome);
      aba.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]).setFontWeight('bold');
      aba.setFrozenRows(1);
      log.push('Aba criada: ' + nome);
    } else {
      const atual = aba.getRange(1, 1, 1, cabecalho.length).getValues()[0];
      cabecalho.forEach((titulo, i) => {
        const valor = String(atual[i] || '').trim();
        if (valor && valor !== titulo) throw Error(`Cabeçalho diferente em ${nome}, coluna ${i + 1}: "${valor}" (esperado "${titulo}")`);
        if (!valor) aba.getRange(1, i + 1).setValue(titulo);
      });
    }
    (colunasTexto[nome] || []).forEach(c => aba.getRange(2, c, aba.getMaxRows() - 1, 1).setNumberFormat('@'));
    (colunasValor[nome] || []).forEach(c => aba.getRange(2, c, aba.getMaxRows() - 1, 1).setNumberFormat('"R$" #,##0.00'));
  }
  segredoSessao_();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BRASERO_FIN_INICIO')) {
    props.setProperty('BRASERO_FIN_INICIO', hojeIso_());
    log.push('Financeiro começa a contar vendas a partir de: ' + hojeIso_());
  }
  limparCacheUsuarios_();
  if (!lerUsuarios_(true).length) {
    const senha = 'Brasa' + Utilities.getUuid().replace(/-/g, '').slice(0, 6);
    const salt = Utilities.getUuid();
    brasero_('usuarios').appendRow(['admin', 'Administrador', 'Admin', hashSenha_(senha, salt, RODADAS_SENHA_), salt, 'Sim', 1, agora_(), '']);
    limparCacheUsuarios_();
    log.push('PRIMEIRO ACESSO → usuário: admin   senha: ' + senha + '   (troque a senha depois de entrar)');
  }
  const mensagem = 'Estrutura V6 conferida.\n' + (log.join('\n') || 'Nada novo para criar.');
  console.log(mensagem);
  return mensagem;
}

// EMERGÊNCIA · esqueceu a senha do admin? Execute esta função pelo editor
// (só quem é dono do projeto consegue). Ela cria/reativa o usuário "admin"
// como Administrador com uma senha nova, mostrada no Registro de execução.
function emergenciaNovaSenhaAdmin() {
  const aba = brasero_('usuarios');
  const senha = 'Brasa' + Utilities.getUuid().replace(/-/g, '').slice(0, 6);
  const salt = Utilities.getUuid(), hash = hashSenha_(senha, salt, RODADAS_SENHA_);
  const u = lerUsuarios_(true).find(x => x.usuario === 'admin');
  if (u) aba.getRange(u.linha, 2, 1, 6).setValues([[u.nome || 'Administrador', 'Admin', hash, salt, 'Sim', u.versao + 1]]);
  else aba.appendRow(['admin', 'Administrador', 'Admin', hash, salt, 'Sim', 1, agora_(), '']);
  limparCacheUsuarios_();
  CacheService.getScriptCache().remove('brasero_falhas_admin');
  const mensagem = 'Nova senha do usuário admin: ' + senha + '   (troque depois de entrar)';
  console.log(mensagem);
  return mensagem;
}
