'use strict';

// Read-only diagnostic: queries loadCodeAssist and fetchAvailableModels with
// every vault account. It does not consume generation quota.

const accounts = require('../lib/accounts');

(async () => {
  await accounts.bootstrap();
  const list = accounts.listAccounts();
  if (!list.length) {
    console.log('No accounts in the vault. Run: npm run accounts -- add');
    return;
  }

  for (const account of list) {
    console.log(`\n=== ${account.email || account.id} | project: ${account.project || accounts.DEFAULT_PROJECT}`);
    try {
      await accounts.refreshAccountMeta(account);
    } catch (err) {
      console.log(`error: ${err.message}`);
      continue;
    }
    for (const id of accounts.SUPPORTED_MODELS) {
      const q = account.quota?.[id];
      if (!q) {
        console.log(`${id}: no data`);
      } else if (q.remainingFraction != null) {
        const pct = Math.round(q.remainingFraction * 100);
        console.log(`${id}: ${pct}% remaining${q.resetTime ? ` | reset ${q.resetTime}` : ''}`);
      } else {
        console.log(`${id}: 0% remaining${q.resetTime ? ` | reset ${q.resetTime}` : ''}`);
      }
    }
  }
})();
