# BrasApp96 no Render

O backend agora é um servidor Node que roda **os mesmos arquivos `.gs`** (pasta `apps-script/`, sem alteração) e lê/grava na **mesma planilha** via Google Sheets API. Logins, senhas e dados existentes continuam valendo.

```
apps-script/   Code.gs, login.gs, Financeiro.gs, Eventos.gs (originais)
public/        Index.html (só a função api() mudou: fetch em vez de google.script.run), Logo.html, Logo.png
lib/           runtime.js (emula SpreadsheetApp, Utilities, Cache, Lock, Properties), sheets.js, app.js
scripts/       executar.js → setup e reset de senha do admin (rodam no seu PC, não ficam expostos na web)
server.js · Dockerfile · render.yaml · .env.example
```

## 1. Google Cloud: criar a Service Account (uma vez)

1. Acesse https://console.cloud.google.com → crie um projeto (ex.: `brasapp96`).
2. **APIs e serviços → Biblioteca →** ative **Google Sheets API**.
3. **IAM e administrador → Contas de serviço → Criar conta de serviço** (sem papéis).
4. Abra a conta criada → **Chaves → Adicionar chave → JSON**. Baixa um arquivo `.json`. Guarde e **nunca suba no GitHub**.
5. Copie o e-mail da conta (`...@...iam.gserviceaccount.com`), abra a planilha e **compartilhe com ele como Editor**.

## 2. GitHub

Substitua o conteúdo do repositório `BrasApp96` pelo conteúdo deste zip, **na raiz** (o `Dockerfile` tem que ficar na raiz). Não suba `node_modules` nem `.env` (o `.gitignore` já cuida).

## 3. Render

No serviço que já existe (runtime **Docker**) → **Environment**, crie **uma** variável:

| Variável | Valor |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | conteúdo inteiro do arquivo `.json` da etapa 1 (pode colar com quebras de linha) |

Opcionais, todas com padrão automático: `SPREADSHEET_ID` (padrão: o ID que está no `Code.gs`), `BRASERO_FIN_INICIO` (padrão: data de criação do primeiro usuário, que é a mesma data gravada pelo Apps Script; hoje dá `2026-11-06`) e `BRASERO_SEGREDO_SESSAO` (padrão: derivado da chave da Service Account). Na primeira vez, cada pessoa precisa entrar de novo com o mesmo usuário e senha.

Depois **Manual Deploy → Deploy latest commit**. O app abre na URL `https://<serviço>.onrender.com`.

## 4. Manutenção (no seu computador, com Node 20+)

```bash
npm install
cp .env.example .env      # preencha (GOOGLE_SERVICE_ACCOUNT_JSON numa linha só ou em base64)
npm run reset-admin       # esqueceu a senha do admin → mostra uma senha nova
npm run setup             # planilha nova: cria as abas e o primeiro admin
npm test                  # testa todos os fluxos com uma planilha simulada
```

## Impressora térmica (conta do cliente)

Na tela da comanda, o botão **🖨️ Imprimir** gera a conta (itens, observações, total e total no crédito +5%) em papel 58mm, sem passar pelo servidor. A escolha da impressora fica salva no aparelho. Para trocar, use **Menu → 🖨️ Impressora** ou segure o botão Imprimir.

| Aparelho | Como conectar |
|---|---|
| Android + Google Chrome | Pareie a impressora em Configurações → Bluetooth (PIN costuma ser `0000` ou `1234`). No app: Imprimir → **Bluetooth (recomendado)** → escolha a impressora. |
| Computador Windows/Mac + Chrome ou Edge | Pareie no Bluetooth do sistema e use a mesma opção. |
| Android sem a opção Bluetooth (navegador antigo ou Samsung Internet) | Instale o app **RawBT** na Play Store, configure a impressora nele e escolha **App RawBT**. |
| iPhone | O Safari não acessa Bluetooth. Esta impressora não funciona pelo navegador. |

Os acentos saem removidos (Pão → Pao), porque essas térmicas genéricas não imprimem acento de forma confiável.

## Limites e cuidados

- **Uma instância só.** O controle de concorrência (antigo LockService) fica na memória do servidor. Não aumente o número de instâncias.
- **Plano free hiberna** depois de 15 min sem acesso. O primeiro acesso leva cerca de 1 minuto (a tela espera até 90 s).
- **Cota da Sheets API**: 60 leituras/min. Leituras repetidas em até 2 s usam cache (`SNAPSHOT_TTL_MS`). Para o uso de um restaurante, sobra cota.
- Edições feitas direto na planilha aparecem no app em até 2 s.
- Desative a implantação antiga do Apps Script depois de migrar (veja abaixo).

### ⚠️ Falha de segurança na versão Apps Script

Pelo `google.script.run`, qualquer pessoa com o link `/exec` consegue chamar funções que não terminam em `_`. Isso inclui `emergenciaNovaSenhaAdmin()`, que **devolve uma senha nova de admin**. Nesta versão Node essas funções não ficam expostas. Depois de migrar, **arquive a implantação** do Apps Script em Implantar → Gerenciar implantações → Arquivar. Se for manter o Apps Script no ar, renomeie a função para `emergenciaNovaSenhaAdmin_`.
