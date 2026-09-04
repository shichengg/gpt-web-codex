import { loadConfig } from './config.js';

if (process.argv.includes('--help')) {
  console.log('GPT Web Codex connector: configure CODEX_WORKSPACE_ROOT and CODEX_CONNECTOR_TOKEN, then start the bridge.');
} else {
  loadConfig(process.env);
  console.error('Connector startup wiring is provided by the host integration.');
}
