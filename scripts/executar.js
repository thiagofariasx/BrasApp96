'use strict';
// Roda no SEU computador (com o .env preenchido) as funções de manutenção que não ficam expostas na web:
//   npm run setup        → prepararEstruturaBraseroV6 (cria abas e o primeiro admin)
//   npm run reset-admin  → emergenciaNovaSenhaAdmin   (nova senha para o usuário admin)
process.env.TZ = process.env.TZ || 'America/Fortaleza';
const {criarRuntime} = require('../lib/app');

const permitidas = ['prepararEstruturaBraseroV6', 'prepararEstruturaBraseroV5', 'emergenciaNovaSenhaAdmin'];
const funcao = process.argv[2];
if (!permitidas.includes(funcao)) {
  console.error('Uso: node scripts/executar.js ' + permitidas.join(' | '));
  process.exit(1);
}

(async () => {
  const rt = criarRuntime();
  console.log(await rt.executar(funcao, []));
  if (rt.propsDefinidas.size) {
    console.log('\n>>> Cadastre estas variáveis de ambiente no Render (Environment) e no seu .env:');
    for (const [k, v] of rt.propsDefinidas) console.log(`${k}=${v}`);
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
