'use strict';

// Instala a extensão do omp que sobe o provider automaticamente e exibe os
// avisos de troca de conta.

const fs = require('fs');
const os = require('os');
const path = require('path');

const repoDir = path.resolve(__dirname, '..');
const stateDir = process.env.AGY_STATE_DIR || path.join(os.homedir(), '.provider-agy');
const agentDir =
  process.env.PI_CODING_AGENT_DIR ||
  path.join(process.env.PI_CONFIG_DIR || path.join(os.homedir(), '.omp'), 'agent');
const extensionsDir = path.join(agentDir, 'extensions');
const source = path.join(repoDir, 'omp-extension', 'provider-agy.ts');
const dest = path.join(extensionsDir, 'provider-agy.ts');

if (!fs.existsSync(source)) {
  console.error(`extensão não encontrada: ${source}`);
  process.exit(1);
}

fs.mkdirSync(extensionsDir, { recursive: true });
fs.copyFileSync(source, dest);

fs.mkdirSync(stateDir, { recursive: true });
const configFile = path.join(stateDir, 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch {}
config.providerDir = repoDir;
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

console.log(`extensão instalada em ${dest}`);
console.log(`pasta do provider registrada em ${configFile}`);
console.log('reinicie o omp; na próxima sessão o provider sobe sozinho.');
console.log('os avisos de troca de conta aparecem na TUI do omp.');
