'use strict';

// Installs the omp extension that starts the provider automatically and shows
// account switch notices.

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
  console.error(`extension not found: ${source}`);
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

console.log(`extension installed at ${dest}`);
console.log(`provider directory registered in ${configFile}`);
console.log('restart omp; the provider will start automatically on the next session.');
console.log('account switch notices appear in the omp TUI.');
