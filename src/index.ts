import { loadConfig } from './config.js';
import { startRuntime } from './runtime.js';

if (process.argv.includes('--help')) {
  console.log('GPT Web Codex connector: configure CODEX_WORKSPACE_ROOT and CODEX_CONNECTOR_TOKEN, then start the bridge.');
} else {
  const runtime = await startRuntime(loadConfig(process.env));
  process.stdout.write(`${JSON.stringify({ type: 'runtime-ready', url: runtime.url })}\n`);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
