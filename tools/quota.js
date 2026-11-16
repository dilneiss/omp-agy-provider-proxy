'use strict';

// Diagnóstico read-only: consulta loadCodeAssist e fetchAvailableModels com as
// contas do cofre. Não gasta quota de geração.

const accounts = require('../lib/accounts');

(async () => {
  await accounts.bootstrap();
  const list = accounts.listAccounts();
  if (!list.length) {
    console.log('Nenhuma conta no cofre. Rode: npm run accounts -- add');
    return;
  }

  for (const account of list) {
    console.log(`\n=== ${account.email || account.id} | projeto: ${account.project || accounts.DEFAULT_PROJECT}`);
    try {
      await accounts.refreshAccountMeta(account);
    } catch (err) {
      console.log(`erro: ${err.message}`);
      continue;
    }
    for (const id of accounts.SUPPORTED_MODELS) {
      const q = account.quota?.[id];
      if (!q) {
        console.log(`${id}: sem informação`);
      } else if (q.remainingFraction != null) {
        const pct = Math.round(q.remainingFraction * 100);
        console.log(`${id}: ${pct}% restante${q.resetTime ? ` | reset ${q.resetTime}` : ''}`);
      } else {
        console.log(`${id}: 0% restante${q.resetTime ? ` | reset ${q.resetTime}` : ''}`);
      }
    }
  }
})();
