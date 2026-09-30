// Запуск автотестов в Node ≥ 18:  node tests/run-node.js
import { runAll } from './tests.js';

const res = await runAll((r) => {
  console.log(`${r.ok ? '  ok ' : 'FAIL '} ${r.name} (${r.ms} мс)`);
  if (!r.ok) console.log(`       ${r.error}`);
});
console.log(`\n${res.passed} из ${res.results.length} тестов прошли${res.failed ? `, не прошло: ${res.failed}` : ''}`);
process.exit(res.failed ? 1 : 0);
