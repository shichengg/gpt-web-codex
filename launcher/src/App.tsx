import { useEffect, useState } from 'react';
import type { LauncherSnapshot, SkillSummary, WorkspaceProfile } from './types';

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
        {!['Status', 'Workspace', 'Skills'].includes(view) && <Placeholder view={view as Exclude<View, 'Status' | 'Workspace' | 'Skills'>} />}
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

function Placeholder({ view }: { view: Exclude<View, 'Status' | 'Workspace' | 'Skills'> }) {
  const descriptions: Record<Exclude<View, 'Status' | 'Workspace' | 'Skills'>, string> = {
    MCP: 'Manage validated local stdio MCP server entries.',
    'Tasks & Logs': 'Review bounded task activity and redacted runtime logs.',
    'Settings & Diagnostics': 'Run local checks and export redacted diagnostics.',
  };
  return <section className="panel"><p>{descriptions[view]}</p></section>;
}
