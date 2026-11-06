'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const {Runtime} = require('./runtime');
const crypto = require('crypto');
const {criarClienteSheets, lerCredenciais} = require('./sheets');

function criarRuntime(opcoes = {}) {
  const cred = opcoes.sheets ? null : lerCredenciais();
  // Sem BRASERO_SEGREDO_SESSAO no ambiente: segredo estável derivado da chave privada da Service Account.
  const padroes = cred ? {BRASERO_SEGREDO_SESSAO: crypto.createHash('sha256').update('brasapp96-sessao|' + cred.private_key).digest('hex')} : {};
  const rt = new Runtime({
    sheets: opcoes.sheets,
    padroes,
    planilhaId: process.env.SPREADSHEET_ID,
    snapshotTtlMs: process.env.SNAPSHOT_TTL_MS ? Math.max(0, Number(process.env.SNAPSHOT_TTL_MS) || 0) : 2000
  });
  if (!rt.sheets) rt.sheets = criarClienteSheets(rt.planilhaId, cred);
  return rt;
}

function paginaInicial() {
  const pub = path.join(__dirname, '..', 'public');
  const logo = fs.readFileSync(path.join(pub, 'Logo.html'), 'utf8');
  return fs.readFileSync(path.join(pub, 'Index.html'), 'utf8').split('<?!= incluirLogo_() ?>').join(logo);
}

function criarApp(rt) {
  const html = paginaInicial();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN'});
    next();
  });
  app.get(['/', '/index.html'], (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(html));
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.get(['/Logo.png', '/favicon.ico'], (req, res) => res.type('png').sendFile(path.join(__dirname, '..', 'public', 'Logo.png'), {maxAge: '7d'}));

  app.post('/api/:funcao', express.json({limit: '512kb'}), async (req, res) => {
    const funcao = req.params.funcao;
    if (!rt.publicas.has(funcao)) return res.status(404).json({mensagem: 'Função não encontrada.'});
    const dados = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    try {
      res.set('Cache-Control', 'no-store').json((await rt.executar(funcao, [dados])) ?? null);
    } catch (e) {
      console.error('[api]', funcao, e);
      res.status(500).json({mensagem: e?.message || 'Erro no servidor.'});
    }
  });
  app.use((err, req, res, next) => res.status(err.status || 400).json({mensagem: 'Requisição inválida.'}));
  return app;
}

module.exports = {criarRuntime, criarApp};
