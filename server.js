'use strict';
process.env.TZ = process.env.TZ || 'America/Fortaleza';
const {criarRuntime, criarApp} = require('./lib/app');

const rt = criarRuntime();
const porta = Number(process.env.PORT) || 10000;
criarApp(rt).listen(porta, '0.0.0.0', () => console.log(`BrasApp96 no ar na porta ${porta} · planilha ${rt.planilhaId}`));
