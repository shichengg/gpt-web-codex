import { useEffect, useState } from 'react';
import type { LauncherSnapshot, McpRegistryDraft, McpServerDraft, SkillSummary, WorkspaceProfile } from './types';

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
  const [profiles, setProfiles] = useState<WorkspaceProfile[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void window.gptWebCodex.snapshot()
      .then((next) => active && setSnapshot(next))
      .catch(() => active && setError('Unable to read launcher status.'));
    return window.gptWebCodex.onSnapshot((next) => active && setSnapshot(next));
  }, []);

  useEffect(() => {
    void refreshWorkspaceData();
  }, []);

  async function refreshWorkspaceData() {
    try {
      const [nextProfiles, nextSkills] = await Promise.all([
        window.gptWebCodex.listProfiles(),
        window.gptWebCodex.listSkills(),
      ]);
      setProfiles(nextProfiles);
      setSkills(nextSkills);
    } catch {
      setError('Unable to load workspace profiles or Skills.');
    }
  }

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
        {view === 'Status' && <Status snapshot={snapshot} onInvoke={invoke} />}
        {view === 'Workspace' && <Workspace profiles={profiles} onChanged={refreshWorkspaceData} />}
        {view === 'Skills' && <Skills profiles={profiles} skills={skills} onChanged={refreshWorkspaceData} />}
        {view === 'MCP' && <Mcp />}
        {view === 'Tasks & Logs' && <TasksAndLogs />}
        {view === 'Settings & Diagnostics' && <Placeholder view="Settings & Diagnostics" />}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </main>
  );
}

function Workspace({ profiles, onChanged }: { profiles: WorkspaceProfile[]; onChanged: () => Promise<void> }) {
  const [id, setId] = useState('workspace');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [skillsRoot, setSkillsRoot] = useState('');
  const [message, setMessage] = useState<string>();

  async function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      setMessage(undefined);
      await window.gptWebCodex.saveProfile({ id, workspaceRoot, skillsRoot, enabledSkillIds: [] });
      await window.gptWebCodex.setActiveProfile(id);
      await onChanged();
      setMessage('Workspace profile saved.');
    } catch {
      setMessage('Unable to save this workspace profile.');
    }
  }

  async function activate(profileId: string) {
    try {
      await window.gptWebCodex.setActiveProfile(profileId);
      await onChanged();
      setMessage('Active workspace profile changed.');
    } catch {
      setMessage('Unable to select this workspace profile.');
    }
  }

  return <section className="panel stack">
    <h2>Workspace profiles</h2>
    <p>Profiles contain only local paths and Skill choices. Runtime credentials are never stored here.</p>
    <form className="stack" onSubmit={(event) => void save(event)}>
      <label>Profile ID<input onChange={(event) => setId(event.target.value)} required value={id} /></label>
      <label>Workspace root<input onChange={(event) => setWorkspaceRoot(event.target.value)} required value={workspaceRoot} /></label>
      <label>Skills root<input onChange={(event) => setSkillsRoot(event.target.value)} required value={skillsRoot} /></label>
      <div className="actions"><button type="submit">Save and select profile</button></div>
    </form>
    {profiles.length > 0 && <ul className="plain-list">
      {profiles.map((profile) => <li key={profile.id}><code>{profile.id}</code> <span>{profile.workspaceRoot}</span>
        <button className="secondary" onClick={() => void activate(profile.id)} type="button">Select</button></li>)}
    </ul>}
    {message && <p>{message}</p>}
  </section>;
}

function Skills({ profiles, skills, onChanged }: { profiles: WorkspaceProfile[]; skills: SkillSummary[]; onChanged: () => Promise<void> }) {
  const active = profiles[0];
  const [enabled, setEnabled] = useState<string[]>(active?.enabledSkillIds ?? []);
  const [message, setMessage] = useState<string>();

  useEffect(() => setEnabled(active?.enabledSkillIds ?? []), [active]);

  function toggle(skillId: string) {
    setEnabled((current) => current.includes(skillId) ? current.filter((id) => id !== skillId) : [...current, skillId]);
  }

  async function save() {
    try {
      await window.gptWebCodex.saveSkills(enabled);
      await onChanged();
      setMessage('Skill defaults saved for the active workspace.');
    } catch {
      setMessage('Unable to save Skill defaults.');
    }
  }

  if (!active) return <section className="panel"><p>Save and select a workspace profile before reviewing its Skills.</p></section>;
  return <section className="panel stack">
    <h2>Skills defaults</h2>
    <p>Enable the Skills that should be selected by default for this workspace.</p>
    {skills.map((skill) => <article className="skill" key={skill.id}>
      <label><input checked={enabled.includes(skill.id)} onChange={() => toggle(skill.id)} type="checkbox" /> <strong>{skill.name}</strong> <code>{skill.id}</code></label>
      <p>{skill.description}</p><pre>{skill.preview}</pre>
      <button className="secondary" onClick={() => void window.gptWebCodex.openSkillFolder(skill.id)} type="button">Open folder</button>
    </article>)}
    {skills.length === 0 && <p>No valid direct-child Skills were found in this profile’s Skills root.</p>}
    <div className="actions"><button onClick={() => void save()} type="button">Save defaults</button></div>
    {message && <p>{message}</p>}
  </section>;
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

function Mcp() {
  const [id, setId] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [servers, setServers] = useState<McpServerDraft[]>([]);
  const [message, setMessage] = useState<string>();

  function addServer(event: React.FormEvent) {
    event.preventDefault();
    const next: McpServerDraft = {
      id: id.trim(),
      command: command.trim(),
      args: parseLines(args),
      allowedTools: parseLines(allowedTools),
      timeoutMs: Number(timeoutMs),
    };
    if (!next.id || !next.command || next.allowedTools.length === 0 || !Number.isInteger(next.timeoutMs)) {
      setMessage('Enter an ID, local command, at least one allowed tool, and an integer timeout.');
      return;
    }
    if (servers.some((server) => server.id === next.id)) {
      setMessage('Each MCP server needs a unique ID.');
      return;
    }
    setServers((current) => [...current, next]);
    setId('');
    setCommand('');
    setArgs('');
    setAllowedTools('');
    setTimeoutMs('30000');
    setMessage('Server entry added to the unsaved registry.');
  }

  async function save() {
    try {
      const draft: McpRegistryDraft = { servers };
      await window.gptWebCodex.saveMcpRegistry(draft);
      setMessage('Local MCP registry saved. The runtime will reload this validated registry.');
    } catch {
      setMessage('The registry was not saved. Check the local command, tools, and timeout.');
    }
  }

  return <section className="panel stack">
    <h2>Local stdio MCP registry</h2>
    <p>Only explicit local stdio commands and named tools are accepted. URLs, wildcard tools, credentials, and environment settings are not supported.</p>
    <form className="stack" onSubmit={addServer}>
      <label>Server ID<input onChange={(event) => setId(event.target.value)} required value={id} /></label>
      <label>Local command<input onChange={(event) => setCommand(event.target.value)} required value={command} /></label>
      <label>Arguments (one per line)<textarea onChange={(event) => setArgs(event.target.value)} value={args} /></label>
      <label>Allowed tools (one per line)<textarea onChange={(event) => setAllowedTools(event.target.value)} required value={allowedTools} /></label>
      <label>Timeout (ms)<input min="1000" onChange={(event) => setTimeoutMs(event.target.value)} required type="number" value={timeoutMs} /></label>
      <div className="actions"><button type="submit">Add server</button></div>
    </form>
    {servers.length > 0 && <ul className="plain-list">
      {servers.map((server) => <li key={server.id}><code>{server.id}</code> <span>{server.command} · {server.allowedTools.join(', ')}</span>
        <button className="secondary" onClick={() => setServers((current) => current.filter((item) => item.id !== server.id))} type="button">Remove</button></li>)}
    </ul>}
    <div className="actions"><button onClick={() => void save()} type="button">Save local registry</button></div>
    {message && <p>{message}</p>}
  </section>;
}

function TasksAndLogs() {
  const [taskId, setTaskId] = useState('');
  const [message, setMessage] = useState<string>();
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => window.gptWebCodex.onLog((entry) => {
    const safe = rendererSafeText(entry);
    setLogs((current) => [safe, ...current].slice(0, 64));
  }), []);

  async function cancel() {
    try {
      await window.gptWebCodex.cancelTask(taskId.trim());
      setMessage('Cancellation requested for the task.');
    } catch {
      setMessage('Unable to cancel this task. Enter its bounded task ID.');
    }
  }

  return <section className="panel stack">
    <h2>Tasks and logs</h2>
    <p>Only recent redacted runtime activity is shown here. Chat content and credentials are not retained.</p>
    <label>Task ID<input onChange={(event) => setTaskId(event.target.value)} value={taskId} /></label>
    <div className="actions"><button disabled={!taskId.trim()} onClick={() => void cancel()} type="button">Cancel task</button></div>
    {message && <p>{message}</p>}
    <h3>Recent runtime logs</h3>
    {logs.length === 0 ? <p>No recent runtime activity.</p> : <ul className="plain-list">{logs.map((entry, index) => <li key={`${index}-${entry}`}><pre>{entry}</pre></li>)}</ul>}
  </section>;
}

function parseLines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function rendererSafeText(value: unknown): string {
  const text = typeof value === 'string' ? value : 'Invalid runtime activity entry';
  const redacted = text
    .replace(/\b(token|api_key|password)\s*=\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [REDACTED]');
  return redacted.length <= 4096 ? redacted : `${redacted.slice(0, 4095)}…`;
}

function Placeholder({ view }: { view: 'Settings & Diagnostics' }) {
  const descriptions: Record<'Settings & Diagnostics', string> = {
    'Settings & Diagnostics': 'Run local checks and export redacted diagnostics.',
  };
  return <section className="panel"><p>{descriptions[view]}</p></section>;
}
