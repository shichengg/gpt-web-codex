import { useEffect, useState } from 'react';
import type { LauncherSnapshot } from './types';

const views = ['Status', 'Workspace', 'Skills', 'MCP', 'Tasks & Logs', 'Settings & Diagnostics'] as const;
type View = (typeof views)[number];

const initialSnapshot: LauncherSnapshot = {
  state: 'stopped',
  workspace: null,
  message: 'Loading launcher status…',
};

export default function App() {
  const [view, setView] = useState<View>('Status');
  const [snapshot, setSnapshot] = useState<LauncherSnapshot>(initialSnapshot);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void window.gptWebCodex.snapshot()
      .then((next) => active && setSnapshot(next))
      .catch(() => active && setError('Unable to read launcher status.'));
    return window.gptWebCodex.onSnapshot((next) => active && setSnapshot(next));
  }, []);

  async function invoke(action: 'start' | 'stop') {
    try {
      setError(undefined);
      setSnapshot(await window.gptWebCodex[action]());
    } catch {
      setError(`Unable to ${action} the local runtime.`);
    }
  }

  return (
    <main className="launcher-shell">
      <aside aria-label="Launcher views" className="sidebar">
        <div className="brand">GPT Web Codex</div>
        {views.map((item) => (
          <button className={view === item ? 'active' : ''} key={item} onClick={() => setView(item)} type="button">
            {item}
          </button>
        ))}
      </aside>
      <section className="content">
        <header>
          <div>
            <p className="eyebrow">{view}</p>
            <h1>{view}</h1>
          </div>
          <span className={`status status-${snapshot.state}`}>{snapshot.state}</span>
        </header>
        {view === 'Status' ? <Status snapshot={snapshot} onInvoke={invoke} /> : <Placeholder view={view} />}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </main>
  );
}

function Status({ snapshot, onInvoke }: { snapshot: LauncherSnapshot; onInvoke: (action: 'start' | 'stop') => Promise<void> }) {
  return (
    <section className="panel">
      <h2>Connection status</h2>
      <dl>
        <dt>Workspace</dt><dd>{snapshot.workspace ?? 'No workspace selected'}</dd>
        <dt>Runtime</dt><dd>{snapshot.message ?? 'Awaiting status'}</dd>
      </dl>
      <div className="actions">
        <button onClick={() => void onInvoke('start')} type="button">Start runtime</button>
        <button className="secondary" onClick={() => void onInvoke('stop')} type="button">Stop runtime</button>
      </div>
    </section>
  );
}

function Placeholder({ view }: { view: Exclude<View, 'Status'> }) {
  const descriptions: Record<Exclude<View, 'Status'>, string> = {
    Workspace: 'Choose the one local workspace that the runtime may access.',
    Skills: 'Review and save explicit per-workspace Skill defaults.',
    MCP: 'Manage validated local stdio MCP server entries.',
    'Tasks & Logs': 'Review bounded task activity and redacted runtime logs.',
    'Settings & Diagnostics': 'Run local checks and export redacted diagnostics.',
  };
  return <section className="panel"><p>{descriptions[view]}</p></section>;
}
