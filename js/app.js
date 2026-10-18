/* DB-Link SCADA Bridge - UI controller, IndexedDB project manager, PWA wiring. */
(function () {
  'use strict';
  const E = window.ScadaEngine;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = E.esc;
  const attr = (s) => esc(s).replace(/"/g, '&quot;');

  /* ================= IndexedDB ================= */
  const DB_NAME = 'dblink-scada';
  let db = null;
  const mem = { projects: {}, meta: {} }; // fallback when IndexedDB is unavailable

  function openDB() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => { db = req.result; resolve(); };
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch (e) { resolve(); }
    });
  }
  function tx(store, mode, fn) {
    return new Promise((resolve) => {
      if (!db) return resolve(fn(null));
      try {
        const t = db.transaction(store, mode); const os = t.objectStore(store);
        const r = fn(os);
        if (r && r.onsuccess !== undefined) { r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(undefined); }
        else t.oncomplete = () => resolve(r);
      } catch (e) { resolve(undefined); }
    });
  }
  const dbAll = () => db ? tx('projects', 'readonly', (os) => os.getAll()) : Promise.resolve(Object.values(mem.projects));
  const dbPut = (p) => { if (!db) { mem.projects[p.id] = p; return Promise.resolve(); } return tx('projects', 'readwrite', (os) => os.put(p)); };
  const dbDel = (id) => { if (!db) { delete mem.projects[id]; return Promise.resolve(); } return tx('projects', 'readwrite', (os) => os.delete(id)); };
  const metaGet = (k) => db ? tx('meta', 'readonly', (os) => os.get(k)).then((r) => r && r.value) : Promise.resolve(mem.meta[k]);
  const metaSet = (k, v) => { if (!db) { mem.meta[k] = v; return Promise.resolve(); } return tx('meta', 'readwrite', (os) => os.put({ key: k, value: v })); };

  /* ================= state ================= */
  let projects = [];
  let P = null; // active project
  let saveTimer = null;

  const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const row = (tag, tagType, col, sqlType, pk, nullable) => ({ tag, tagType, col, sqlType, pk: !!pk, nullable: nullable !== false });

  function demoProject() {
    return {
      id: 'demo-agac-dxb-pump-stn-01', name: 'AGAC-DXB-PUMP-STN-01', client: 'Dubai District Cooling (Demo)', engineer: 'SCADA Engineer',
      table: 'tbl_PumpStation_Telemetry', dbEngine: 'mssql',
      conn: { server: 'SQLSRV01', database: 'ScadaDB', auth: 'win', dsn: 'DBLink_ODBC', user: 'scada_writer', pass: '', timeout: 5, minPool: 2, maxPool: 20, failover: 'SQLSRV02', historian: 'HISTSRV01', histUser: 'wwUser', sampleTag: 'PT_101_PV', engine: 'mssql' },
      est: { tags: 500, mode: 'cyclic', scan: 1, unit: 's', days: 365, changePct: 15, rowBytes: 46, indexPct: 30, batch: 100 },
      tags: [
        row('PT_101_PV', 'I/O Real', 'DischargePressure_bar', 'FLOAT'),
        row('FT_102_TOT', 'I/O Real', 'FlowTotal_m3', 'FLOAT'),
        row('TT_201_Out', 'I/O Real', 'OutletTemp_C', 'FLOAT'),
        row('LT_301_PV', 'I/O Real', 'WetWellLevel_m', 'FLOAT'),
        row('PMP_01_Speed_PV', 'I/O Integer', 'Pump01_Speed_rpm', 'INT'),
        row('PMP_01_Run_Stat', 'I/O Discrete', 'Pump01_Running', 'BIT', false, false),
        row('VLV_01_Open_Stat', 'I/O Discrete', 'Valve01_Open', 'BIT'),
        row('ALM_High_Press_Msg', 'Memory Message', 'HighPressure_Msg', 'NVARCHAR(255)')
      ],
      updated: Date.now()
    };
  }
  function blankProject(name) {
    const d = demoProject();
    return { id: uid(), name, client: '', engineer: '', table: 'tbl_Telemetry', dbEngine: 'mssql', conn: Object.assign({}, d.conn), est: Object.assign({}, d.est), tags: [row('NewTag_01', 'I/O Real', 'NewTag_01', 'FLOAT')], updated: Date.now() };
  }

  function save(immediate) {
    P.updated = Date.now();
    clearTimeout(saveTimer);
    const go = () => dbPut(JSON.parse(JSON.stringify(P)));
    if (immediate) return go();
    saveTimer = setTimeout(go, 300);
  }

  /* ================= helpers ================= */
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800);
  }
  function copy(text) {
    const done = () => toast('Copied to clipboard');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    function fallback() {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed'); }
      ta.remove();
    }
  }
  function downloadText(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  const slug = (s) => String(s || 'project').replace(/[^A-Za-z0-9_-]+/g, '_');

  const KW = {
    qs: 'IF|THEN|ELSE|ENDIF|AND|OR|NOT|SQLConnect|SQLInsert|SQLUpdate|SQLSelect|SQLDisconnect|SQLSetStatement|SQLAppendStatement|SQLExecute|SQLErrorMsg|SQLFirst|LogMessage|StringFromReal|StringFromIntg|StringReplace',
    cs: 'using|public|static|class|const|string|int|bool|double|object|new|try|catch|finally|while|if|return|void|out|ref|readonly|null|this',
    sql: 'SELECT|FROM|WHERE|INSERT|INTO|VALUES|CREATE|TABLE|INDEX|CLUSTERED|NONCLUSTERED|PRIMARY|KEY|CONSTRAINT|DEFAULT|NOT|NULL|AND|OR|IN|ORDER|BY|GROUP|PROCEDURE|OR|ALTER|AS|BEGIN|END|TRY|CATCH|DECLARE|SET|ON|GO|WHILE|DELETE|TOP|BREAK|IF|THROW|EXEC|WITH|IDENTITY|UNIQUE|USING|GENERATED|ALWAYS|ENGINE|OPENQUERY|DATEADD|GETDATE|SYSUTCDATETIME|BIGINT|INT|INTEGER|BIT|FLOAT|DATETIME2|NVARCHAR|VARCHAR|BOOLEAN|NUMBER|DOUBLE|TIMESTAMP|TIMESTAMPTZ|DATETIME|TINYINT'
  };
  function highlight(code, lang) {
    const kw = lang === 'cs' ? KW.cs + '|SqlConnection|SqlCommand|SqlException|SqlDbType|CommandType|Interlocked|ThreadPool|Exception|DBNull|ConcurrentQueue|Queue' : lang === 'qs' ? KW.qs : KW.sql;
    const re = new RegExp('(\\{[\\s\\S]*?\\}(?=\\n|$)|//.*|--.*|"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\n]|\'\')*\'|\\b(?:' + kw + ')\\b|\\b\\d+(?:\\.\\d+)?\\b)', 'gi');
    return esc(code).replace(re, (m) => {
      if (lang === 'qs' && m[0] === '{') return '<span class="tk-c">' + m + '</span>';
      if (m.startsWith('//') || m.startsWith('--')) return '<span class="tk-c">' + m + '</span>';
      if (m[0] === '"' || m[0] === "'") return '<span class="tk-s">' + m + '</span>';
      if (/^\d/.test(m)) return '<span class="tk-n">' + m + '</span>';
      return '<span class="tk-k">' + m + '</span>';
    });
  }
  function codeBlock(id, code, lang) {
    return '<div class="row no-print" style="justify-content:flex-end;margin-bottom:6px"><button class="btn small" data-copy="' + id + '">Copy</button></div><pre class="codeblock" id="' + id + '" data-raw="' + attr(code) + '">' + highlight(code, lang) + '</pre>';
  }
  function bindCopy(root) {
    $$('[data-copy]', root).forEach((b) => b.addEventListener('click', () => copy($('#' + b.dataset.copy).dataset.raw)));
  }
  const field = (label, id, val, extra) => '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" value="' + attr(val == null ? '' : val) + '" ' + (extra || '') + '></div>';
  const opts = (list, sel) => list.map((o) => '<option' + (o === sel ? ' selected' : '') + '>' + esc(o) + '</option>').join('');

  /* ================= Module 1: mapper ================= */
  function renderMapper() {
    const el = $('#mod-mapper');
    el.innerHTML =
      '<div class="card"><h2>Bind List &amp; Tag-to-Column Mapper</h2><p class="hint">Map Wonderware tags to SQL columns. Every edit is validated instantly and saved to this device.</p>' +
      '<div class="row">' + field('Project name', 'pName', P.name) + field('SQL table', 'pTable', P.table) + field('Client', 'pClient', P.client) + field('Engineer', 'pEng', P.engineer) +
      '<div class="field"><label for="pDialect">Database engine</label><select id="pDialect">' + [['mssql', 'SQL Server'], ['postgres', 'PostgreSQL'], ['mysql', 'MySQL'], ['oracle', 'Oracle']].map((d) => '<option value="' + d[0] + '"' + (P.dbEngine === d[0] ? ' selected' : '') + '>' + d[1] + '</option>').join('') + '</select></div></div></div>' +
      '<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Mappings (<span id="mapCount"></span>)</h3><div class="row"><span id="mapSummary"></span><button class="btn small" id="addRow">+ Add row</button></div></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Wonderware tag</th><th>Tag type</th><th>Column</th><th>SQL type</th><th>PK</th><th>Null</th><th>Validation</th><th></th></tr></thead><tbody id="mapBody"></tbody></table></div></div>' +
      '<div class="grid g2"><div class="card"><h3>Import (CSV / DBLoad dump)</h3><p class="hint">Paste Tagname,Type[,Column,SqlType,PK,Nullable] rows or InTouch DBDump sections (:IOReal, :IODisc, :IOInt, :IOMsg, :MemReal...).</p>' +
      '<textarea id="csvIn" class="code" placeholder="Tagname,Type\nPT_101_PV,Real\nPMP_01_Run_Stat,Discrete\n"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="btn primary small" id="impAppend">Append</button><button class="btn small" id="impReplace">Replace all</button><button class="btn small" id="impFile">Load JSON file</button><input type="file" id="impFileInput" accept=".json,.csv,.txt" hidden></div><div id="impMsg" class="hint"></div></div>' +
      '<div class="card"><h3>Export</h3><p class="hint">Clean mapping schema for reuse or review.</p><div class="row"><button class="btn small" id="expCsv">Download CSV</button><button class="btn small" id="expJson">Download JSON</button><button class="btn small" id="expCopy">Copy CSV</button></div>' +
      '<h3 style="margin-top:16px">Project</h3><div class="row"><button class="btn small" id="dupProj">Duplicate</button><button class="btn small danger" id="delProj">Delete project</button></div></div></div>';

    const body = $('#mapBody');
    function rows() {
      body.innerHTML = P.tags.map((m, i) =>
        '<tr data-i="' + i + '"><td>' + (i + 1) + '</td>' +
        '<td><input data-f="tag" value="' + attr(m.tag) + '" aria-label="Tagname"></td>' +
        '<td><select data-f="tagType">' + opts(E.TAG_TYPES, m.tagType) + '</select></td>' +
        '<td><input data-f="col" value="' + attr(m.col) + '" aria-label="Column"></td>' +
        '<td><select data-f="sqlType">' + opts(E.SQL_TYPES, m.sqlType) + '</select></td>' +
        '<td class="chk"><input type="checkbox" data-f="pk"' + (m.pk ? ' checked' : '') + ' aria-label="Primary key"></td>' +
        '<td class="chk"><input type="checkbox" data-f="nullable"' + (m.nullable ? ' checked' : '') + ' aria-label="Nullable"></td>' +
        '<td class="vcell"></td><td><button class="btn small danger" data-del="' + i + '" aria-label="Delete row">&times;</button></td></tr>').join('');
      validate();
    }
    function validate() {
      const res = E.validate(P.tags);
      $$('tr', body).forEach((tr, i) => {
        tr.className = 'lvl-' + res[i].level;
        $('.vcell', tr).innerHTML = res[i].issues.map((s) => '<div class="issue ' + s.level + '">' + (s.level === 'ok' ? '&#10003; ' : s.level === 'warn' ? '&#9888; ' : '&#10007; ') + esc(s.msg) + '</div>').join('');
      });
      const e = res.filter((r) => r.level === 'err').length; const w = res.filter((r) => r.level === 'warn').length;
      $('#mapCount').textContent = P.tags.length;
      $('#mapSummary').innerHTML = '<span class="pill err">' + e + ' errors</span> <span class="pill warn">' + w + ' warnings</span> <span class="pill ok">' + (res.length - e - w) + ' valid</span>';
    }
    rows();

    body.addEventListener('input', (ev) => {
      const t = ev.target; const f = t.dataset.f; if (!f) return;
      const i = +t.closest('tr').dataset.i; const m = P.tags[i];
      m[f] = t.type === 'checkbox' ? t.checked : t.value;
      if (f === 'tagType' && ev.type === 'input' && t.tagName === 'SELECT') { m.sqlType = E.defaultSql(m.tagType); $('[data-f=sqlType]', t.closest('tr')).value = m.sqlType; }
      if (f === 'pk' && m.pk) { m.nullable = false; $('[data-f=nullable]', t.closest('tr')).checked = false; }
      validate(); save();
    });
    body.addEventListener('click', (ev) => {
      const d = ev.target.closest('[data-del]'); if (!d) return;
      P.tags.splice(+d.dataset.del, 1); save(); rows();
    });
    $('#addRow').onclick = () => { const n = P.tags.length + 1; P.tags.push(row('NewTag_' + String(n).padStart(2, '0'), 'I/O Real', 'NewTag_' + String(n).padStart(2, '0'), 'FLOAT')); save(); rows(); };

    [['pName', 'name'], ['pTable', 'table'], ['pClient', 'client'], ['pEng', 'engineer']].forEach(([id, k]) => $('#' + id).addEventListener('input', (e) => { P[k] = e.target.value; save(); if (k === 'name') renderProjectSelect(); }));
    $('#pDialect').onchange = (e) => { P.dbEngine = e.target.value; P.conn.engine = e.target.value; save(); };

    function doImport(replace) {
      const r = E.parseTagCSV($('#csvIn').value);
      if (!r.rows.length) { $('#impMsg').textContent = r.errors.join(' ') || 'No rows found.'; return; }
      P.tags = replace ? r.rows : P.tags.concat(r.rows); save(); rows();
      $('#impMsg').textContent = 'Imported ' + r.rows.length + ' rows' + (r.errors.length ? ' (' + r.errors.length + ' skipped)' : '') + '.';
      toast('Imported ' + r.rows.length + ' tags');
    }
    $('#impAppend').onclick = () => doImport(false);
    $('#impReplace').onclick = () => doImport(true);
    $('#impFile').onclick = () => $('#impFileInput').click();
    $('#impFileInput').onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          if (/\.json$/i.test(f.name)) {
            const o = JSON.parse(rd.result); const list = Array.isArray(o) ? o : o.tags;
            if (!Array.isArray(list)) throw new Error('no tags array');
            if (o.table) P.table = o.table; P.tags = list.map((t) => row(String(t.tag), E.TAG_TYPES.includes(t.tagType) ? t.tagType : 'I/O Real', String(t.col || E.toColumn(t.tag)), E.SQL_TYPES.includes(t.sqlType) ? t.sqlType : 'FLOAT', t.pk, t.nullable));
            save(); renderMapper(); toast('JSON loaded');
          } else { $('#csvIn').value = rd.result; doImport(true); }
        } catch (err) { $('#impMsg').textContent = 'Could not read file: ' + err.message; }
      };
      rd.readAsText(f);
    };
    $('#expCsv').onclick = () => downloadText(slug(P.name) + '_bindlist.csv', E.toCSV(P.tags), 'text/csv');
    $('#expJson').onclick = () => downloadText(slug(P.name) + '_bindlist.json', JSON.stringify({ project: P.name, table: P.table, engine: P.dbEngine, tags: P.tags }, null, 2), 'application/json');
    $('#expCopy').onclick = () => copy(E.toCSV(P.tags));
    $('#dupProj').onclick = async () => { const c = JSON.parse(JSON.stringify(P)); c.id = uid(); c.name = P.name + '_copy'; await dbPut(c); await loadProjects(c.id); toast('Project duplicated'); };
    $('#delProj').onclick = async () => {
      if (!confirm('Delete project "' + P.name + '"? This cannot be undone.')) return;
      await dbDel(P.id); await loadProjects(); toast('Project deleted');
    };
  }

  /* ================= Module 2: connections + estimator ================= */
  function renderConn() {
    const c = P.conn; const e = P.est;
    const el = $('#mod-conn');
    el.innerHTML =
      '<div class="card"><h2>Connection String &amp; DSN Architect</h2><p class="hint">Copy-ready strings for InTouch SQL Access Manager, ArchestrA ADO.NET and the AVEVA Historian linked server. Passwords are not stored; placeholders are used.</p>' +
      '<div class="row">' + field('SQL server', 'cServer', c.server) + field('Database', 'cDb', c.database) + field('ODBC DSN name', 'cDsn', c.dsn) +
      '<div class="field"><label for="cAuth">Authentication</label><select id="cAuth"><option value="win"' + (c.auth === 'win' ? ' selected' : '') + '>Windows (SSPI)</option><option value="sql"' + (c.auth === 'sql' ? ' selected' : '') + '>SQL login</option></select></div>' +
      field('SQL user', 'cUser', c.user) + '</div><div class="row" style="margin-top:8px">' +
      field('Timeout (s)', 'cTimeout', c.timeout, 'type="number" min="1"') + field('Min pool', 'cMin', c.minPool, 'type="number" min="0"') + field('Max pool', 'cMax', c.maxPool, 'type="number" min="1"') + field('Failover partner', 'cFail', c.failover) +
      field('Historian server', 'cHist', c.historian) + field('Historian user', 'cHUser', c.histUser) + '</div></div>' +
      '<div id="connOut"></div>' +
      '<div class="card" id="estimator"><h3>Database storage &amp; bandwidth estimator</h3><p class="hint">Estimates only: validate against a pilot table (sp_spaceused) before sizing production disks.</p>' +
      '<div class="row">' + field('Tag count', 'eTags', e.tags, 'type="number" min="1"') +
      '<div class="field"><label for="eMode">Logging mode</label><select id="eMode"><option value="cyclic"' + (e.mode === 'cyclic' ? ' selected' : '') + '>Cyclic</option><option value="delta"' + (e.mode === 'delta' ? ' selected' : '') + '>Delta / deadband</option></select></div>' +
      field('Scan / log rate', 'eScan', e.scan, 'type="number" min="0.001" step="any"') +
      '<div class="field"><label for="eUnit">Unit</label><select id="eUnit"><option value="s"' + (e.unit === 's' ? ' selected' : '') + '>seconds</option><option value="ms"' + (e.unit === 'ms' ? ' selected' : '') + '>milliseconds</option></select></div>' +
      field('Change % (delta mode)', 'eChg', e.changePct, 'type="number" min="0" max="100"') + field('Retention (days)', 'eDays', e.days, 'type="number" min="1"') +
      field('Bytes per row', 'eRow', e.rowBytes, 'type="number" min="8"') + field('Index overhead %', 'eIdx', e.indexPct, 'type="number" min="0"') + field('Rows per batch', 'eBatch', e.batch, 'type="number" min="1"') + '</div>' +
      '<div class="grid g3" style="margin-top:12px" id="eOut"></div><div id="eNote" class="alert"></div></div>';

    function conns() {
      const out = E.genConnections(Object.assign({}, c, { engine: P.dbEngine }));
      $('#connOut').innerHTML = out.map((o, i) => '<div class="card"><h3>' + esc(o.title) + '</h3>' + codeBlock('cs' + i, o.body, i === 3 ? 'sql' : 'cs') + '</div>').join('');
      bindCopy($('#connOut'));
    }
    conns();
    const map = { cServer: 'server', cDb: 'database', cDsn: 'dsn', cAuth: 'auth', cUser: 'user', cTimeout: 'timeout', cMin: 'minPool', cMax: 'maxPool', cFail: 'failover', cHist: 'historian', cHUser: 'histUser' };
    Object.keys(map).forEach((id) => $('#' + id).addEventListener('input', (ev) => { c[map[id]] = ev.target.value; save(); conns(); }));

    function est() {
      const r = E.estimateStorage(e);
      const fmt = (n, d) => (isFinite(n) ? n : 0).toLocaleString(undefined, { maximumFractionDigits: d == null ? 1 : d });
      const st = (v, l) => '<div class="stat"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>';
      $('#eOut').innerHTML = st(fmt(r.rowsPerSec, 1), 'rows / second') + st(fmt(r.rowsDay, 0), 'rows / day') + st(fmt(r.mbDay, 1) + ' MB', 'growth / day') + st(fmt(r.gbYear, 2) + ' GB', 'growth / year') +
        st(fmt(r.gbRetention, 2) + ' GB', 'at ' + e.days + '-day retention') + st(fmt(r.iops, 1), 'est. write IOPS') + st(fmt(r.mbps, 3) + ' MB/s', 'network load');
      const note = $('#eNote');
      if (r.rowsPerSec > 2000) { note.className = 'alert err'; note.textContent = 'Over 2,000 rows/s: use batched inserts or table-valued parameters, or log through the Historian and report from there.'; }
      else if (r.rowsPerSec > 500) { note.className = 'alert'; note.textContent = 'Above 500 rows/s: batch rows, keep indexes minimal, and schedule retention deletes in small batches.'; }
      else { note.className = 'alert ok'; note.textContent = 'Load is modest for a properly indexed SQL Server table.'; }
    }
    est();
    const emap = { eTags: 'tags', eScan: 'scan', eChg: 'changePct', eDays: 'days', eRow: 'rowBytes', eIdx: 'indexPct', eBatch: 'batch', eMode: 'mode', eUnit: 'unit' };
    Object.keys(emap).forEach((id) => $('#' + id).addEventListener('input', (ev) => { e[emap[id]] = ev.target.value; save(); est(); }));
  }

  /* ================= Module 3: code generator ================= */
  let codeTab = 'qs'; let ddlDialect = 'mssql';
  function renderCode() {
    const el = $('#mod-code');
    const tabs = [['qs', 'InTouch QuickScript'], ['cs', 'ArchestrA .NET'], ['ddl', 'SQL DDL & procs'], ['hist', 'Historian queries']];
    el.innerHTML = '<div class="card"><h2>Script &amp; SQL Code Generator</h2><p class="hint">Generated from the active mapping (' + P.tags.length + ' tags, table <code>' + esc(P.table) + '</code>). Edit the mapping in Module 1 and the code updates.</p>' +
      '<div class="tabs" role="tablist">' + tabs.map((t) => '<button role="tab" data-t="' + t[0] + '" class="' + (codeTab === t[0] ? 'active' : '') + '">' + t[1] + '</button>').join('') + '</div>' +
      (codeTab === 'ddl' ? '<div class="row" style="margin-bottom:8px"><div class="field" style="max-width:220px"><label for="dlg">Dialect</label><select id="dlg">' + [['mssql', 'SQL Server'], ['postgres', 'PostgreSQL'], ['mysql', 'MySQL'], ['oracle', 'Oracle']].map((d) => '<option value="' + d[0] + '"' + (ddlDialect === d[0] ? ' selected' : '') + '>' + d[1] + '</option>').join('') + '</select></div></div>' : '') +
      '<div id="codeStatus"></div><div id="codeOut"></div><div class="row no-print" style="margin-top:8px"><button class="btn small" id="dlCode">Download file</button></div></div>';
    const errs = E.validate(P.tags).filter((r) => r.level === 'err').length;
    let code; let lang; let ext;
    if (codeTab === 'qs') { code = E.genQuickScript(P); lang = 'qs'; ext = 'qs.txt'; }
    else if (codeTab === 'cs') { code = E.genArchestra(P); lang = 'cs'; ext = 'cs'; }
    else if (codeTab === 'ddl') { code = E.genDDL(P, ddlDialect); lang = 'sql'; ext = 'sql'; }
    else { code = E.genHistorian(P); lang = 'sql'; ext = 'historian.sql'; }
    let status = '';
    if (errs) status += '<div class="alert err">' + errs + ' mapping error(s) in Module 1: generated code may not compile or run. Fix them first.</div>';
    if (codeTab === 'qs') {
      const lits = (code.match(/"(?:[^"\\\n]|\\.)*"/g) || []).map((s) => s.length - 2);
      const mx = Math.max.apply(null, lits.concat([0]));
      status += '<div class="alert ' + (mx > E.INTOUCH_LIMIT ? 'err' : 'ok') + '">Longest string literal: <b>' + mx + '</b> of ' + E.INTOUCH_LIMIT + ' characters. Long statements are split with SQLSetStatement / SQLAppendStatement.</div>';
    }
    $('#codeStatus').innerHTML = status;
    $('#codeOut').innerHTML = codeBlock('codeMain', code, lang);
    bindCopy(el);
    $('#dlCode').onclick = () => downloadText(slug(P.name) + '_' + ext, code);
    $$('.tabs button', el).forEach((b) => b.onclick = () => { codeTab = b.dataset.t; renderCode(); });
    const dl = $('#dlg'); if (dl) dl.onchange = (e) => { ddlDialect = e.target.value; renderCode(); };
  }

  /* ================= Module 4: simulator ================= */
  let simTimer = null; let simVals = {}; let simNoise = true;
  function renderSim() {
    const el = $('#mod-sim');
    el.innerHTML = '<div class="card"><h2>Live Payload Simulator &amp; Query Sandbox</h2><p class="hint">Simulated tag values only: nothing is sent to a database. Use it to review the exact statement your script will build.</p>' +
      '<div class="row"><button class="btn primary" id="simToggle">' + (simTimer ? 'Stop' : 'Start') + ' simulation</button><button class="btn" id="simStep">Single step</button>' +
      '<label class="row" style="gap:6px"><input type="checkbox" id="simNoise"' + (simNoise ? ' checked' : '') + '> Analog noise</label><span class="hint" id="simTs"></span></div>' +
      '<div class="live" id="simLive" style="margin-top:12px"></div></div>' +
      '<div class="grid g2"><div class="card"><h3>Resolved INSERT</h3><div id="simIns"></div></div><div class="card"><h3>Resolved SELECT</h3><div id="simSel"></div></div></div>' +
      '<div class="card"><h3>SQL optimisation &amp; troubleshooting checklist</h3><ul class="checklist" id="checks">' +
      E.CHECKLIST.map((c, i) => '<li><label><input type="checkbox" data-ck="' + i + '"><span><b>' + esc(c.t) + '.</b> ' + esc(c.d) + '</span></label></li>').join('') + '</ul></div>';
    const draw = () => {
      $('#simLive').innerHTML = P.tags.map((m, i) => {
        const v = simVals[m.tag]; const disc = m.sqlType === 'BIT' || m.tagType === 'I/O Discrete';
        return '<div class="tagbox"><div class="n">' + esc(m.tag) + '</div>' +
          (disc ? '<div class="val"><span class="led' + (v ? ' on' : '') + '"></span>' + (v ? 'ON' : 'OFF') + '</div><button class="btn small" data-tg="' + i + '">Toggle</button>'
            : '<div class="val">' + esc(v) + '</div><div class="n">' + esc(m.sqlType) + '</div>') + '</div>';
      }).join('');
      $('#simIns').innerHTML = codeBlock('simI', E.resolveInsert(P, simVals), 'sql');
      $('#simSel').innerHTML = codeBlock('simS', E.resolveSelect(P), 'sql');
      $('#simTs').textContent = 'Last sample ' + new Date().toLocaleTimeString();
      bindCopy(el);
    };
    const step = (toggle) => { P.tags.forEach((m) => { simVals[m.tag] = E.simulateValue(m, simVals[m.tag], { noise: simNoise, toggle: false }); }); draw(); };
    if (!Object.keys(simVals).length) P.tags.forEach((m) => { simVals[m.tag] = E.simulateValue(m, undefined, { noise: false }); });
    draw();
    $('#simToggle').onclick = () => {
      if (simTimer) { clearInterval(simTimer); simTimer = null; } else simTimer = setInterval(() => { if (!$('#simLive')) { clearInterval(simTimer); simTimer = null; return; } step(); }, 1000);
      $('#simToggle').textContent = (simTimer ? 'Stop' : 'Start') + ' simulation';
    };
    $('#simStep').onclick = () => step();
    $('#simNoise').onchange = (e) => { simNoise = e.target.checked; };
    $('#simLive').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-tg]'); if (!b) return;
      const m = P.tags[+b.dataset.tg]; simVals[m.tag] = E.simulateValue(m, simVals[m.tag], { toggle: true }); draw();
    });
    try { const saved = JSON.parse(localStorage.getItem('dblink-checks') || '{}'); $$('[data-ck]', el).forEach((c) => { c.checked = !!saved[c.dataset.ck]; }); } catch (e) { /* storage unavailable */ }
    $('#checks').addEventListener('change', () => { try { const o = {}; $$('[data-ck]').forEach((c) => { o[c.dataset.ck] = c.checked; }); localStorage.setItem('dblink-checks', JSON.stringify(o)); } catch (e) { /* ignore */ } });
  }

  /* ================= Module 5: FAT/SAT + icons ================= */
  function fatMarkdown() {
    const v = E.validate(P.tags); const c = P.conn; const date = new Date().toISOString().slice(0, 10);
    const L = [];
    L.push('# Database Integration Design Specification (FDS) & QA Checklist');
    L.push('');
    L.push('**Document ref:** Annexure-SCT-HR-001 (QA/HSE compliance)  ');
    L.push('**Organisation:** Al Gurg Automation and Controls  ');
    L.push('**Project:** ' + P.name + '  ');
    L.push('**Client:** ' + (P.client || '-') + '  ');
    L.push('**Engineer:** ' + (P.engineer || '-') + '  ');
    L.push('**Date:** ' + date + '  ');
    L.push('**Revision:** A');
    L.push('');
    L.push('## 1. Connection matrix');
    L.push('');
    L.push('| Interface | Provider / driver | Server | Database | Auth | Notes |');
    L.push('|---|---|---|---|---|---|');
    L.push('| InTouch SQL Access Manager | ODBC System DSN `' + c.dsn + '` (32-bit) | ' + c.server + ' | ' + c.database + ' | ' + (c.auth === 'sql' ? 'SQL login' : 'Windows') + ' | SysWOW64 odbcad32.exe |');
    L.push('| ArchestrA AppEngine | ADO.NET SqlClient | ' + c.server + ' | ' + c.database + ' | ' + (c.auth === 'sql' ? 'SQL login' : 'Windows') + ' | Pool ' + c.minPool + '-' + c.maxPool + ', timeout ' + c.timeout + ' s, failover ' + (c.failover || 'none') + ' |');
    L.push('| AVEVA Historian | Linked server INSQL | ' + c.historian + ' | Runtime | SQL login (' + c.histUser + ') | OPENQUERY / wwRetrievalMode |');
    L.push('');
    L.push('## 2. Bind list');
    L.push('');
    L.push('Target table: `' + P.table + '` (' + P.dbEngine + ')');
    L.push('');
    L.push('| # | Tag | Tag type | Column | SQL type | PK | Nullable | Validation |');
    L.push('|---|---|---|---|---|---|---|---|');
    P.tags.forEach((m, i) => L.push('| ' + (i + 1) + ' | ' + m.tag + ' | ' + m.tagType + ' | ' + m.col + ' | ' + m.sqlType + ' | ' + (m.pk ? 'Y' : '') + ' | ' + (m.nullable ? 'Y' : 'N') + ' | ' + v[i].level.toUpperCase() + ' |'));
    L.push('');
    L.push('## 3. FAT / SAT test checklist');
    L.push('');
    L.push('| ID | Test | Expected result | FAT | SAT |');
    L.push('|---|---|---|---|---|');
    [['DB-01', 'ODBC DSN created with 32-bit odbcad32.exe and test connection succeeds', 'Connection OK'],
      ['DB-02', 'SQLConnect returns 0 at application start', 'ResultCode 0, no log errors'],
      ['DB-03', 'SQLInsert via bind list writes one row per trigger', 'Row count increments by 1'],
      ['DB-04', 'All ' + P.tags.length + ' mapped tags present with correct values', 'Values match SCADA within tolerance'],
      ['DB-05', 'Discrete tags stored as 0/1', 'BIT values match tag state'],
      ['DB-06', 'Messages longer than column width handled', 'No truncation error; logged'],
      ['DB-07', 'Database server unavailable during logging', 'AppEngine scan unaffected; reconnect succeeds'],
      ['DB-08', 'SQL statements over 131 characters execute', 'SQLSetStatement/SQLAppendStatement succeed'],
      ['DB-09', 'Retention job deletes in batches', 'Log size stable, no blocking'],
      ['DB-10', 'Historian cyclic retrieval returns expected rows', 'Row count = interval / resolution'],
      ['DB-11', 'Alarm history query returns last 7 days', 'Matches alarm summary'],
      ['DB-12', 'Failover to partner server (if configured)', 'Logging resumes automatically']
    ].forEach((t) => L.push('| ' + t.join(' | ') + ' | [ ] | [ ] |'));
    L.push('');
    L.push('## 4. HSE / QA notes');
    L.push('');
    L.push('- No credentials stored in scripts; use Windows authentication or a least-privilege SQL login (INSERT/EXECUTE only).');
    L.push('- Changes to production databases follow the approved change-control procedure.');
    L.push('- Backups verified before commissioning.');
    L.push('');
    L.push('## 5. Sign-off');
    L.push('');
    L.push('| Role | Name | Signature | Date |');
    L.push('|---|---|---|---|');
    ['Prepared by (SCADA Engineer)', 'Reviewed by (Lead Engineer)', 'Client representative', 'QA / HSE'].forEach((r) => L.push('| ' + r + ' | | | |'));
    return L.join('\n');
  }
  function mdToHtml(md) {
    const lines = md.split('\n'); let out = ''; let i = 0;
    const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    while (i < lines.length) {
      const l = lines[i];
      if (/^# /.test(l)) { out += '<h1 style="font-size:20px">' + inline(l.slice(2)) + '</h1>'; i++; }
      else if (/^## /.test(l)) { out += '<h2 style="margin-top:16px">' + inline(l.slice(3)) + '</h2>'; i++; }
      else if (/^\|/.test(l)) {
        const t = []; while (i < lines.length && /^\|/.test(lines[i])) { t.push(lines[i]); i++; }
        const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        out += '<table style="margin:6px 0"><thead><tr>' + cells(t[0]).map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
          t.slice(2).map((r) => '<tr>' + cells(r).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
      } else if (/^- /.test(l)) {
        out += '<ul>'; while (i < lines.length && /^- /.test(lines[i])) { out += '<li>' + inline(lines[i].slice(2)) + '</li>'; i++; } out += '</ul>';
      } else if (l.trim() === '') i++;
      else { out += '<p style="margin:2px 0">' + inline(l) + '</p>'; i++; }
    }
    return out;
  }

  function renderDocs() {
    const el = $('#mod-docs');
    el.innerHTML = '<div class="card"><h2>FAT/SAT Documentation</h2><p class="hint">Database Integration Design Specification and QA checklist built from the active project. Header fields come from Module 1.</p>' +
      '<div class="row no-print"><button class="btn primary" id="fatMd">Download Markdown</button><button class="btn" id="fatHtml">Download HTML</button><button class="btn" id="fatPrint">Print / Save as PDF</button></div></div>' +
      '<div class="card" id="fatPreview" style="background:#fff;color:#111"></div>' +
      '<div class="card no-print"><h3>PWA icon &amp; splash pack</h3><p class="hint">Generates the PNG icons referenced by <code>manifest.webmanifest</code> and <code>index.html</code>. Save them into an <code>icons/</code> folder next to <code>index.html</code>.</p>' +
      '<div class="icon-grid" id="iconGrid"></div><div class="row" style="margin-top:12px"><button class="btn primary" id="icoZip">Download all as ZIP</button><button class="btn" id="icoAll">Download PNGs individually</button><span class="hint" id="icoMsg"></span></div></div>';
    const md = fatMarkdown();
    const html = mdToHtml(md);
    $('#fatPreview').innerHTML = html;
    const doc = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(P.name) + ' - FDS</title><style>body{font:13px/1.5 Arial,sans-serif;margin:24px;color:#111}table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #444;padding:4px 6px;text-align:left;vertical-align:top}th{background:#e5e7eb}code{font-family:Consolas,monospace}</style></head><body>' + html + '</body></html>';
    $('#fatMd').onclick = () => downloadText(slug(P.name) + '_FDS.md', md, 'text/markdown');
    $('#fatHtml').onclick = () => downloadText(slug(P.name) + '_FDS.html', doc, 'text/html');
    $('#fatPrint').onclick = () => window.print();

    const grid = $('#iconGrid');
    window.IconGenerator.ICONS.forEach((ic) => {
      const f = document.createElement('figure'); const c = document.createElement('canvas');
      window.IconGenerator.render(c, ic.size, ic);
      c.title = 'Click to download ' + ic.name; c.style.cursor = 'pointer';
      c.onclick = () => c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = ic.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); });
      f.appendChild(c); f.appendChild(document.createTextNode(ic.name + ' (' + ic.size + ')')); grid.appendChild(f);
    });
    $('#icoZip').onclick = async () => { await window.IconGenerator.downloadZip(); toast('ZIP downloaded'); };
    $('#icoAll').onclick = () => window.IconGenerator.downloadAll((n, t) => { $('#icoMsg').textContent = n + ' / ' + t; });
  }

  /* ================= navigation / project select ================= */
  const renderers = { mapper: renderMapper, conn: renderConn, code: renderCode, sim: renderSim, docs: renderDocs };
  let current = 'mapper';
  function show(mod) {
    current = mod;
    $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.mod === mod));
    $$('.module').forEach((s) => s.classList.toggle('active', s.id === 'mod-' + mod));
    if (mod !== 'sim' && simTimer) { clearInterval(simTimer); simTimer = null; }
    renderers[mod]();
    window.scrollTo(0, 0);
  }
  function renderProjectSelect() {
    const s = $('#projectSelect');
    s.innerHTML = projects.map((p) => '<option value="' + attr(p.id) + '"' + (P && p.id === P.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
  }
  async function loadProjects(selectId) {
    projects = (await dbAll()) || [];
    projects.sort((a, b) => (a.created || 0) - (b.created || 0) || a.name.localeCompare(b.name));
    if (!projects.length) { const d = demoProject(); await dbPut(d); projects = [d]; }
    const want = selectId || (await metaGet('active'));
    P = projects.find((p) => p.id === want) || projects[0];
    await metaSet('active', P.id);
    simVals = {};
    renderProjectSelect(); show(current);
  }

  /* ================= PWA wiring ================= */
  function initPWA() {
    const badge = $('#netBadge');
    const upd = () => { const on = navigator.onLine; badge.textContent = on ? 'ONLINE' : 'OFFLINE READY'; badge.className = 'badge ' + (on ? 'online' : 'offline'); };
    window.addEventListener('online', upd); window.addEventListener('offline', upd); upd();

    let deferred = null; const btn = $('#installBtn');
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; btn.hidden = false; });
    btn.onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; btn.hidden = true; };
    window.addEventListener('appinstalled', () => { btn.hidden = true; toast('App installed'); });

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        const prompt = (w) => { $('#updateBar').hidden = false; $('#updateBtn').onclick = () => w.postMessage({ type: 'SKIP_WAITING' }); };
        if (reg.waiting && navigator.serviceWorker.controller) prompt(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const w = reg.installing; if (!w) return;
          w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) prompt(w); });
        });
      }).catch(() => {});
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded) return; reloaded = true; location.reload(); });
    }
  }

  /* ================= boot ================= */
  async function boot() {
    await openDB();
    initPWA();
    $$('.nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.mod)));
    $('#projectSelect').addEventListener('change', async (e) => { await metaSet('active', e.target.value); await loadProjects(e.target.value); });
    $('#newProjectBtn').addEventListener('click', async () => {
      const name = prompt('New project name:', 'NEW-PROJECT-01'); if (!name) return;
      const p = blankProject(name.trim()); p.created = Date.now(); await dbPut(p); await loadProjects(p.id); show('mapper'); toast('Project created');
    });
    const qp = new URLSearchParams(location.search); const m = qp.get('mod');
    if (m && renderers[m]) current = m;
    await loadProjects();
    if (qp.get('new') === '1') $('#newProjectBtn').click();
    if (location.hash === '#estimator') { const x = $('#estimator'); if (x) x.scrollIntoView(); }
  }
  boot();
})();
