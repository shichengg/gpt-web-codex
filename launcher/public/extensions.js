(() => {
  const api = window.gptWebCodex;
  const reference = window.mcpAssistant;
  const nav = document.querySelector('.nav-list');
  const main = document.querySelector('.content-viewport');
  if (!nav || !main || !api) return;

  const group = document.createElement('div');
  group.innerHTML = '<span class="nav-group-label">扩展能力</span><button class="nav-item" data-page="skills"><span class="nav-icon">✦</span><span>Skills</span></button><button class="nav-item" data-page="mcp"><span class="nav-icon">◇</span><span>MCP（可选）</span></button>';
  nav.appendChild(group);

  const skillsPage = document.createElement('section');
  skillsPage.className = 'page';
  skillsPage.dataset.pageView = 'skills';
  skillsPage.innerHTML = '<div class="section-header"><div><span class="section-kicker">扩展能力</span><h2>Skills</h2><p>默认只提供名称和描述，任务需要时才读取完整 SKILL.md。</p></div><button class="primary-button" id="saveSkillDefaults">保存默认项</button></div><article class="panel"><div class="skill-grid" id="skillGrid"><span class="task-muted">正在读取 Skills…</span></div></article>';
  main.appendChild(skillsPage);

  const mcpPage = document.createElement('section');
  mcpPage.className = 'page';
  mcpPage.dataset.pageView = 'mcp';
  mcpPage.innerHTML = '<div class="section-header"><div><span class="section-kicker">扩展能力</span><h2>本地 MCP（可选）</h2><p>支持通用本地 stdio 与本机 HTTP MCP；不配置也不影响其他功能。</p></div></div><article class="panel"><div class="panel-title"><div><h3>添加 MCP 服务</h3><p>选择预设，或填写其他本地 MCP。</p></div><div class="inline-actions"><button class="secondary-button" id="stataPreset">Stata 预设</button><button class="secondary-button" id="zoteroPreset">Zotero 预设</button></div></div><div class="mcp-form"><label>传输方式<select id="mcpTransport"><option value="stdio">本地进程（stdio）</option><option value="streamable-http">本机 HTTP</option></select></label><label>服务 ID<input id="mcpServerId" placeholder="例如 stata / zotero"></label><label>本地命令或 URL<input id="mcpCommand" placeholder="绝对 EXE/Python 路径或 http://127.0.0.1:端口/mcp"></label><label>参数（每行一个）<textarea id="mcpEntrypoint" placeholder="例如 -m 和模块名"></textarea></label><label>允许工具（每行一个）<textarea id="mcpAllowedTools" placeholder="先测试连接，再确定 allowlist"></textarea></label><label><input id="mcpEnabled" type="checkbox" checked> 启用此 MCP 服务</label><label id="mcpTokenField" hidden>HTTP 访问令牌<input id="mcpToken" type="password" autocomplete="off" placeholder="可选，仅保存在主进程"></label><button class="primary-button" id="addMcpServer">添加并保存</button></div><div class="notice blue-notice"><b>安全限制</b><p>stdio 不经过 shell；HTTP 仅允许 127.0.0.1 或 ::1 的 /mcp。禁止远程 URL、脚本宿主与工具通配符。令牌不会写入 registry 或发送到界面。</p></div><div class="mcp-list" id="mcpList"><span class="task-muted">MCP 是可选项，当前未配置。</span></div></article>';
  main.appendChild(mcpPage);

  function show(page) {
    document.querySelectorAll('.page').forEach((item) => { item.classList.toggle('active', item.dataset.pageView === page); });
    document.querySelectorAll('.nav-item').forEach((item) => { item.classList.toggle('active', item.dataset.page === page); });
    const title = page === 'skills' ? 'Skills' : '本地 MCP（可选）';
    document.querySelector('#pageEyebrow').textContent = '扩展能力';
    document.querySelector('#pageTitle').textContent = title;
    document.querySelector('#pageSubtitle').textContent = page === 'skills' ? '按需加载本地 Skill 指令。' : '管理可选的本地 stdio MCP 服务。';
    document.querySelector('.content-viewport').scrollTop = 0;
    if (page === 'skills') loadSkills();
    if (page === 'mcp') loadMcp();
  }
  document.querySelector('#mcpTransport').addEventListener('change', () => {
    document.querySelector('#mcpTokenField').hidden = document.querySelector('#mcpTransport').value !== 'streamable-http';
  });

  document.querySelectorAll('[data-page="skills"],[data-page="mcp"]').forEach((button) => button.addEventListener('click', () => show(button.dataset.page)));

  let selectedSkills = [];
  async function loadSkills() {
    const list = await api.listSkills();
    const grid = document.querySelector('#skillGrid');
    grid.replaceChildren();
    if (!list.length) { grid.innerHTML = '<span class="task-muted">未发现 Skills。推荐目录：.codex/skills/&lt;skill&gt;/SKILL.md</span>'; return; }
    list.forEach((skill) => {
      const row = document.createElement('label');
      row.className = 'skill-card';
      row.innerHTML = `<input type="checkbox" value="${skill.id}"><span><b>${skill.name}</b><code>${skill.id}</code><small>${skill.description}</small></span>`;
      row.querySelector('input').checked = selectedSkills.includes(skill.id);
      row.querySelector('input').addEventListener('change', (event) => { selectedSkills = event.target.checked ? [...selectedSkills, skill.id] : selectedSkills.filter((id) => id !== skill.id); });
      grid.appendChild(row);
    });
  }
  document.querySelector('#saveSkillDefaults').addEventListener('click', async () => { await api.saveSkills(selectedSkills); });

  async function loadMcp() {
    const registry = await api.listMcpRegistry();
    const list = document.querySelector('#mcpList');
    list.replaceChildren();
    if (!registry.servers?.length) { list.innerHTML = '<span class="task-muted">MCP 是可选项，当前未配置。</span>'; return; }
    registry.servers.forEach((server) => {
      const row = document.createElement('div'); row.className = 'mcp-row';
      const copy = document.createElement('span'); copy.textContent = `${server.id} · ${server.enabled === false ? '已停用' : '已启用'} · ${server.transport === 'streamable-http' ? server.url : server.command}`;
      const discover = document.createElement('button'); discover.className = 'secondary-button'; discover.textContent = '测试连接';
      discover.addEventListener('click', async () => {
        discover.disabled = true; discover.textContent = '正在连接…';
        try {
          const tools = await api.discoverMcpTools(server.id);
          const names = tools.map((item) => item.name).filter(Boolean);
          if (!names.length) throw new Error('未发现可用工具');
          const current = await api.listMcpRegistry();
          await api.saveMcpRegistry({ servers: (current.servers || []).map((item) => item.id === server.id ? { ...item, allowedTools: names } : item) });
          copy.textContent = `${server.id} · 连接成功，已启用全部工具`;
        }
        catch (error) { copy.textContent = `${server.id} · 连接失败：${error?.message || '未知错误'}`; }
        finally { discover.disabled = false; discover.textContent = '测试连接'; }
      });
      const edit = document.createElement('button'); edit.className = 'secondary-button'; edit.textContent = '编辑';
      edit.addEventListener('click', () => {
        document.querySelector('#mcpTransport').value = server.transport || 'stdio';
        document.querySelector('#mcpTransport').dispatchEvent(new Event('change'));
        document.querySelector('#mcpServerId').value = server.id;
        document.querySelector('#mcpCommand').value = server.transport === 'streamable-http' ? (server.url || '') : (server.command || '');
        document.querySelector('#mcpEntrypoint').value = (server.args || []).join('\n');
        document.querySelector('#mcpAllowedTools').value = (server.allowedTools || []).join('\n');
        document.querySelector('#mcpEnabled').checked = server.enabled !== false;
        document.querySelector('#addMcpServer').textContent = '更新并保存';
      });
      const remove = document.createElement('button'); remove.className = 'secondary-button'; remove.textContent = '删除';
      remove.addEventListener('click', async () => {
        const current = await api.listMcpRegistry();
        await api.saveMcpRegistry({ servers: (current.servers || []).filter((item) => item.id !== server.id) });
        await loadMcp();
      });
      row.append(copy, discover, edit, remove); list.appendChild(row);
    });
  }
  const stataTools = ['stata_run','stata_run_dofile','stata_session','stata_write_dofile','stata_append_dofile','stata_read_dofile','stata_read_log','stata_install_package','stata_get_results','stata_get_data_info','stata_get_data_schema','stata_status'];
  document.querySelector('#stataPreset').addEventListener('click', () => {
    document.querySelector('#mcpTransport').value = 'stdio';
    document.querySelector('#mcpServerId').value = 'stata';
    document.querySelector('#mcpCommand').value = 'D:\\Python\\Scripts\\stata-gui-mcp.exe';
    document.querySelector('#mcpEntrypoint').value = '';
    document.querySelector('#mcpAllowedTools').value = stataTools.join('\n');
  });
  const zoteroTools = ['search_library','search_annotations','get_item_details','get_item_abstract','get_annotations','get_content','get_collections','search_collections','get_collection_details','get_collection_items','get_subcollections','search_fulltext','get_tags','get_related_items','generate_bibliography','search_by_identifier','get_library_stats','get_item_types','get_creator_types','get_item_type_fields','get_trash_items','get_recently_modified','semantic_search','find_similar','semantic_status','fulltext_database'];
  document.querySelector('#zoteroPreset').addEventListener('click', () => {
    document.querySelector('#mcpTransport').value = 'streamable-http';
    document.querySelector('#mcpServerId').value = 'zotero';
    document.querySelector('#mcpCommand').value = 'http://127.0.0.1:23120/mcp';
    document.querySelector('#mcpEntrypoint').value = '';
    document.querySelector('#mcpAllowedTools').value = zoteroTools.join('\n');
  });
  document.querySelector('#addMcpServer').addEventListener('click', async () => {
    const current = await api.listMcpRegistry();
    const transport = document.querySelector('#mcpTransport').value;
    const commandOrUrl = document.querySelector('#mcpCommand').value.trim();
    const next = { id: document.querySelector('#mcpServerId').value.trim(), transport, command: transport === 'stdio' ? commandOrUrl : '', args: transport === 'stdio' ? document.querySelector('#mcpEntrypoint').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : [], ...(transport === 'streamable-http' ? { url: commandOrUrl } : {}), allowedTools: document.querySelector('#mcpAllowedTools').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), enabled: document.querySelector('#mcpEnabled').checked, timeoutMs: 120000 };
    if (!next.id || !commandOrUrl) return;
    await api.saveMcpRegistry({ servers: [...(current.servers || []).filter((item) => item.id !== next.id), next] });
    const token = document.querySelector('#mcpToken').value.trim();
    if (transport === 'streamable-http' && token) {
      await api.saveMcpCredential({ serverId: next.id, token });
      document.querySelector('#mcpToken').value = '';
    }
    await loadMcp();
    document.querySelector('#addMcpServer').textContent = '添加并保存';
  });

  loadSkills().catch(() => {});
  loadMcp().catch(() => {});
})();
