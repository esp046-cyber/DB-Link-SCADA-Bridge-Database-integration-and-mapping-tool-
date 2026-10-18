/* DB-Link SCADA Bridge - engine: validator, parsers, code generators, estimators.
   Pure functions, no DOM access (testable in Node). */
(function (root) {
  'use strict';

  const TAG_TYPES = ['I/O Real', 'I/O Integer', 'I/O Discrete', 'Memory Message', 'ArchestrA Attribute'];
  const SQL_TYPES = ['FLOAT', 'INT', 'BIT', 'NVARCHAR(255)', 'DATETIME2'];
  const INTOUCH_LIMIT = 131; // max characters in an InTouch QuickScript string literal
  const INTOUCH_TAG_LIMIT = 32;

  /* ---------- helpers ---------- */
  const isIdent = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s || '');
  const q = (s) => '[' + String(s).replace(/]/g, ']]') + ']';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const csvCell = (v) => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

  /* ---------- type compatibility ---------- */
  // [level, message]; level: ok | warn | err
  const COMPAT = {
    'I/O Real': {
      FLOAT: ['ok', 'Real maps cleanly to FLOAT (8-byte IEEE 754).'],
      INT: ['warn', 'Real to INT truncates fractional values; scaling or rounding is lost.'],
      BIT: ['err', 'Real cannot map to BIT: analog values collapse to 0/1. Use FLOAT or a discrete tag.'],
      'NVARCHAR(255)': ['warn', 'Real stored as text: breaks numeric aggregation and range indexes. Prefer FLOAT.'],
      DATETIME2: ['err', 'Real cannot map to DATETIME2.']
    },
    'I/O Integer': {
      FLOAT: ['warn', 'Integer widened to FLOAT: valid but wastes space and risks precision on large counters.'],
      INT: ['ok', 'Integer maps cleanly to INT (32-bit).'],
      BIT: ['warn', 'Integer to BIT loses all values except 0/non-zero.'],
      'NVARCHAR(255)': ['warn', 'Integer stored as text: no numeric indexing; use INT.'],
      DATETIME2: ['err', 'Integer cannot map to DATETIME2.']
    },
    'I/O Discrete': {
      FLOAT: ['warn', 'Discrete stored as FLOAT: use BIT.'],
      INT: ['warn', 'Discrete stored as INT: acceptable, but BIT is smaller and clearer.'],
      BIT: ['ok', 'Discrete maps cleanly to BIT.'],
      'NVARCHAR(255)': ['warn', 'Discrete stored as text: use BIT.'],
      DATETIME2: ['err', 'Discrete cannot map to DATETIME2.']
    },
    'Memory Message': {
      FLOAT: ['err', 'Message (string) cannot map to FLOAT.'],
      INT: ['err', 'Message (string) cannot map to INT.'],
      BIT: ['err', 'Message (string) cannot map to BIT.'],
      'NVARCHAR(255)': ['ok', 'Message maps to NVARCHAR(255). InTouch message tags are limited to 131 characters.'],
      DATETIME2: ['warn', 'Message to DATETIME2 requires a parseable date string; conversion errors likely.']
    },
    'ArchestrA Attribute': {
      FLOAT: ['warn', 'Confirm the attribute is Float/Double in the IDE; numeric attributes of other types will cast.'],
      INT: ['warn', 'Confirm the attribute is Integer in the IDE.'],
      BIT: ['warn', 'Confirm the attribute is Boolean in the IDE.'],
      'NVARCHAR(255)': ['ok', 'String attributes map to NVARCHAR(255).'],
      DATETIME2: ['ok', 'Time attributes map to DATETIME2 (use UTC to avoid DST gaps).']
    }
  };

  function validateRow(m, all) {
    const issues = [];
    const c = (COMPAT[m.tagType] || {})[m.sqlType];
    if (c) issues.push({ level: c[0], msg: c[1] });
    else issues.push({ level: 'err', msg: 'Unknown tag or SQL type combination.' });
    if (!m.tag) issues.push({ level: 'err', msg: 'Tagname is empty.' });
    if (!isIdent(m.col)) issues.push({ level: 'err', msg: 'Column name must be a valid identifier (letters, digits, underscore; no leading digit).' });
    if (m.tag && m.tag.length > INTOUCH_TAG_LIMIT && /^I\/O|^Memory/.test(m.tagType)) issues.push({ level: 'warn', msg: 'InTouch tagnames are limited to ' + INTOUCH_TAG_LIMIT + ' characters.' });
    if (m.pk && m.nullable) issues.push({ level: 'err', msg: 'A primary key column cannot be nullable.' });
    if (m.pk && /^NVARCHAR/.test(m.sqlType)) issues.push({ level: 'warn', msg: 'NVARCHAR primary key: wide, fragmenting clustered key. Prefer an IDENTITY surrogate plus a time index.' });
    if (m.pk && m.sqlType === 'FLOAT') issues.push({ level: 'warn', msg: 'FLOAT primary key: equality on floating point is unreliable.' });
    if (m.col && all.filter((x) => (x.col || '').toLowerCase() === m.col.toLowerCase()).length > 1) issues.push({ level: 'err', msg: 'Duplicate column name.' });
    if (m.tag && all.filter((x) => (x.tag || '').toLowerCase() === m.tag.toLowerCase()).length > 1) issues.push({ level: 'warn', msg: 'Tag is mapped more than once.' });
    return issues;
  }

  function validate(tags) {
    return tags.map((m) => {
      const issues = validateRow(m, tags);
      const level = issues.some((i) => i.level === 'err') ? 'err' : issues.some((i) => i.level === 'warn') ? 'warn' : 'ok';
      return { level, issues };
    });
  }

  /* ---------- CSV / JSON import-export ---------- */
  function parseCSVLine(line) {
    const out = []; let cur = ''; let inq = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inq) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inq = false;
        else cur += ch;
      } else if (ch === '"') inq = true;
      else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function guessTagType(raw) {
    const s = (raw || '').toLowerCase();
    if (/discrete|bool|bit/.test(s)) return 'I/O Discrete';
    if (/real|float|double|analog/.test(s)) return 'I/O Real';
    if (/int|long|short|word/.test(s)) return 'I/O Integer';
    if (/message|string|text|msg/.test(s)) return 'Memory Message';
    if (/attr|archestra|\./.test(s)) return 'ArchestrA Attribute';
    return 'I/O Real';
  }
  const defaultSql = (tt) => ({ 'I/O Real': 'FLOAT', 'I/O Integer': 'INT', 'I/O Discrete': 'BIT', 'Memory Message': 'NVARCHAR(255)', 'ArchestrA Attribute': 'FLOAT' }[tt]);
  const toColumn = (tag) => { let c = String(tag).replace(/[^A-Za-z0-9_]/g, '_'); if (/^\d/.test(c)) c = 'T_' + c; return c; };

  /* Accepts the InTouch DBLoad/DBDump ":IOReal" style sections, or a plain CSV
     (Tagname, Type, [Column], [SqlType], [PK], [Nullable]) with optional header. */
  function parseTagCSV(text) {
    const rows = []; const errors = [];
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let section = null;
    lines.forEach((line, idx) => {
      const sec = line.match(/^:(\w+)/);
      if (sec) {
        const s = sec[1].toLowerCase();
        if (/^io(real|int|disc|msg)/.test(s) || /^mem(real|int|disc|msg)/.test(s)) {
          section = /real/.test(s) ? 'I/O Real' : /int/.test(s) ? 'I/O Integer' : /disc/.test(s) ? 'I/O Discrete' : 'Memory Message';
        } else section = null;
        return;
      }
      const cells = parseCSVLine(line);
      if (/^tag(name)?$/i.test(cells[0])) return; // header
      if (!cells[0]) { errors.push('Line ' + (idx + 1) + ': empty tagname.'); return; }
      let tagType; let rest;
      if (section) { tagType = section; rest = cells.slice(1); }
      else {
        tagType = TAG_TYPES.includes(cells[1]) ? cells[1] : guessTagType(cells[1]);
        rest = cells.slice(2);
      }
      const tag = cells[0];
      const col = rest[0] && isIdent(rest[0]) ? rest[0] : toColumn(tag);
      const sqlType = SQL_TYPES.includes(rest[1]) ? rest[1] : defaultSql(tagType);
      const truthy = (v) => /^(1|true|yes|y)$/i.test(v || '');
      rows.push({ tag, tagType, col, sqlType, pk: truthy(rest[2]), nullable: rest[3] === undefined || rest[3] === '' ? true : truthy(rest[3]) });
    });
    return { rows, errors };
  }

  function toCSV(tags) {
    const head = 'Tagname,TagType,Column,SqlType,PrimaryKey,Nullable';
    return [head].concat(tags.map((t) => [t.tag, t.tagType, t.col, t.sqlType, t.pk ? 1 : 0, t.nullable ? 1 : 0].map(csvCell).join(','))).join('\r\n');
  }

  /* ---------- 131-character chunker ---------- */
  const qsEscape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // Split SQL into pieces whose escaped form fits in a QuickScript literal.
  function chunkSQL(sql, limit) {
    limit = limit || INTOUCH_LIMIT;
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    const parts = []; let cur = '';
    // tokens keep trailing separators so pieces break on spaces/commas, never inside a word
    const tokens = flat.match(/[^ ,()]+[ ,()]*|[ ,()]+/g) || [];
    const fits = (s) => qsEscape(s).length <= limit;
    tokens.forEach((tok) => {
      if (fits(cur + tok)) { cur += tok; return; }
      if (cur) { parts.push(cur); cur = ''; }
      while (!fits(tok)) { // single token longer than limit: hard split
        let n = tok.length; while (n > 1 && !fits(tok.slice(0, n))) n--;
        parts.push(tok.slice(0, n)); tok = tok.slice(n);
      }
      cur = tok;
    });
    if (cur) parts.push(cur);
    return parts;
  }

  /* ---------- InTouch QuickScript ---------- */
  function tagExpr(m) {
    if (m.tagType === 'I/O Real' || m.tagType === 'ArchestrA Attribute' && m.sqlType === 'FLOAT') return 'StringFromReal(' + m.tag + ', 3, "f")';
    if (m.tagType === 'I/O Integer' || m.sqlType === 'INT') return 'StringFromIntg(' + m.tag + ', 10)';
    if (m.sqlType === 'BIT') return null; // handled with IF
    return null;
  }

  function genQuickScript(p) {
    const tags = p.tags; const t = p.table || 'tbl_Telemetry';
    const dsn = (p.conn && p.conn.dsn) || 'DBLink_ODBC';
    const cols = tags.map((m) => m.col);
    const L = [];
    L.push('{ ======================================================================');
    L.push('  DB-Link SCADA Bridge : InTouch SQL Access (QuickScript)');
    L.push('  Project : ' + p.name + '    Table : ' + t);
    L.push('  Create memory tags first: SQLConn (Integer), SQLResult (Integer),');
    L.push('  SQLMsg (Message), SQLBusy (Discrete), SQLLogNow (Discrete trigger).');
    L.push('  NOTE: every string literal in QuickScript is limited to ' + INTOUCH_LIMIT + ' characters;');
    L.push('  long statements below are split with SQLSetStatement / SQLAppendStatement.');
    L.push('  ====================================================================== }');
    L.push('');
    L.push('{ ---- 1. Application script: ON STARTUP -------------------------------- }');
    L.push('SQLConn = 0;');
    L.push('SQLResult = SQLConnect(SQLConn, "DSN=' + dsn + ';");');
    L.push('IF SQLResult <> 0 THEN');
    L.push('  SQLMsg = "SQLConnect failed: " + SQLErrorMsg(SQLResult);');
    L.push('  LogMessage(SQLMsg);');
    L.push('ENDIF;');
    L.push('');
    L.push('{ ---- 2. SQLInsert via Bind List (simple, no length issue) ------------- }');
    L.push('{ Bind list "BL_' + t + '" is defined in SQL Access Manager:');
    tags.forEach((m) => L.push('    ' + m.col.padEnd(24) + ' <- ' + m.tag));
    L.push('}');
    L.push('SQLResult = SQLInsert(SQLConn, "' + t + '", "BL_' + t + '");');
    L.push('IF SQLResult <> 0 THEN');
    L.push('  SQLMsg = "SQLInsert failed (" + StringFromIntg(SQLResult, 10) + "): " + SQLErrorMsg(SQLResult);');
    L.push('  LogMessage(SQLMsg);');
    L.push('ENDIF;');
    L.push('');
    L.push('{ ---- 3. SQLUpdate (latest-values row) --------------------------------- }');
    L.push('SQLResult = SQLUpdate(SQLConn, "' + t + '", "BL_' + t + '", "Id = 1");');
    L.push('IF SQLResult <> 0 THEN');
    L.push('  LogMessage("SQLUpdate failed: " + SQLErrorMsg(SQLResult));');
    L.push('ENDIF;');
    L.push('');
    L.push('{ ---- 4. SQLSelect ----------------------------------------------------- }');
    L.push('SQLResult = SQLSelect(SQLConn, "' + t + '", "BL_' + t + '", "LogTime > DATEADD(hour,-1,GETDATE())", "LogTime DESC");');
    L.push('IF SQLResult <> 0 THEN');
    L.push('  LogMessage("SQLSelect failed: " + SQLErrorMsg(SQLResult));');
    L.push('ELSE');
    L.push('  SQLFirst(SQLConn);');
    L.push('ENDIF;');
    L.push('');
    L.push('{ ---- 5. Long INSERT built from live tag values (131-char safe) -------- }');
    L.push('{ Condition script: SQLLogNow  On True }');
    L.push('IF SQLBusy == 0 THEN');
    L.push('  SQLBusy = 1;');
    const head = 'INSERT INTO ' + t + ' (' + cols.join(', ') + ') VALUES (';
    chunkSQL(head).forEach((c, i) => {
      L.push('  ' + (i === 0 ? 'SQLResult = SQLSetStatement' : 'SQLResult = SQLAppendStatement') + '(SQLConn, "' + qsEscape(c) + '");');
    });
    L.push('  IF SQLResult <> 0 THEN LogMessage("Statement build failed: " + SQLErrorMsg(SQLResult)); ENDIF;');
    tags.forEach((m, i) => {
      const sep = i < tags.length - 1 ? ', ' : ')';
      L.push('  { ' + m.col + ' <- ' + m.tag + ' }');
      if (m.sqlType === 'BIT') {
        L.push('  IF ' + m.tag + ' THEN SQLResult = SQLAppendStatement(SQLConn, "1' + sep + '");');
        L.push('  ELSE SQLResult = SQLAppendStatement(SQLConn, "0' + sep + '"); ENDIF;');
      } else if (m.sqlType === 'NVARCHAR(255)') {
        L.push('  SQLResult = SQLAppendStatement(SQLConn, "N\'" + StringReplace(' + m.tag + ', "\'", "\'\'", 1) + "\'' + sep + '");');
      } else if (m.sqlType === 'DATETIME2') {
        L.push('  SQLResult = SQLAppendStatement(SQLConn, "\'" + ' + m.tag + ' + "\'' + sep + '");');
      } else {
        L.push('  SQLResult = SQLAppendStatement(SQLConn, ' + tagExpr(m) + ' + "' + sep + '");');
      }
    });
    L.push('  SQLResult = SQLExecute(SQLConn, "");');
    L.push('  IF SQLResult <> 0 THEN');
    L.push('    SQLMsg = "SQLExecute failed (" + StringFromIntg(SQLResult, 10) + "): " + SQLErrorMsg(SQLResult);');
    L.push('    LogMessage(SQLMsg);');
    L.push('  ENDIF;');
    L.push('  SQLBusy = 0;');
    L.push('ENDIF;');
    L.push('');
    L.push('{ ---- 6. Long static SELECT, chunked by the generator ------------------ }');
    const sel = 'SELECT ' + cols.join(', ') + ' FROM ' + t + ' WHERE LogTime >= DATEADD(minute, -15, GETDATE()) ORDER BY LogTime DESC';
    const selParts = chunkSQL(sel);
    selParts.forEach((c, i) => {
      L.push('SQLResult = ' + (i === 0 ? 'SQLSetStatement' : 'SQLAppendStatement') + '(SQLConn, "' + qsEscape(c) + '");   { ' + qsEscape(c).length + ' chars }');
    });
    L.push('IF SQLResult <> 0 THEN LogMessage("Chunked SELECT failed: " + SQLErrorMsg(SQLResult)); ENDIF;');
    L.push('');
    L.push('{ ---- 7. Application script: ON SHUTDOWN ------------------------------- }');
    L.push('SQLResult = SQLDisconnect(SQLConn);');
    L.push('IF SQLResult <> 0 THEN LogMessage("SQLDisconnect failed: " + SQLErrorMsg(SQLResult)); ENDIF;');
    return L.join('\n');
  }

  /* ---------- ArchestrA C# ---------- */
  function genArchestra(p) {
    const t = p.table || 'tbl_Telemetry';
    const sp = 'usp_InsertScadaTelemetry';
    const L = [];
    L.push('// ======================================================================');
    L.push('// DB-Link SCADA Bridge : ArchestrA object script (.NET)');
    L.push('// Project: ' + p.name + '   Table: ' + t);
    L.push('// Intended pattern: script only ENQUEUES a snapshot; a background worker');
    L.push('// performs the SQL call so the AppEngine scan is never blocked.');
    L.push('// QuickScript.NET uses a C#-like syntax; adapt namespace imports and');
    L.push('// attribute access to your galaxy (or place this in a Script Function Library).');
    L.push('// ======================================================================');
    L.push('using System;');
    L.push('using System.Collections.Concurrent;');
    L.push('using System.Data;');
    L.push('using System.Data.SqlClient;');
    L.push('using System.Threading;');
    L.push('');
    L.push('public static class DbLinkLogger');
    L.push('{');
    L.push('    const string ConnStr = "Data Source=SQLSRV01;Initial Catalog=ScadaDB;Integrated Security=SSPI;" +');
    L.push('        "Connection Timeout=5;Pooling=true;Min Pool Size=2;Max Pool Size=20;Application Name=ArchestrA_AppEngine";');
    L.push('    static readonly ConcurrentQueue<object[]> Queue = new ConcurrentQueue<object[]>();');
    L.push('    static int _running; static int _dropped;');
    L.push('    const int MaxQueue = 5000;');
    L.push('');
    L.push('    // Called from the object script: cheap, non-blocking.');
    L.push('    public static void Enqueue(' + p.tags.map((m) => csType(m) + ' ' + camel(m.col)).join(', ') + ')');
    L.push('    {');
    L.push('        if (Queue.Count >= MaxQueue) { Interlocked.Increment(ref _dropped); return; }');
    L.push('        Queue.Enqueue(new object[] { ' + p.tags.map((m) => camel(m.col)).join(', ') + ' });');
    L.push('        if (Interlocked.CompareExchange(ref _running, 1, 0) == 0)');
    L.push('            ThreadPool.QueueUserWorkItem(_ => Drain());');
    L.push('    }');
    L.push('');
    L.push('    static void Drain()');
    L.push('    {');
    L.push('        SqlConnection cn = null;');
    L.push('        try');
    L.push('        {');
    L.push('            cn = new SqlConnection(ConnStr);');
    L.push('            cn.Open();');
    L.push('            object[] row;');
    L.push('            while (Queue.TryDequeue(out row))');
    L.push('            {');
    L.push('                using (var cmd = new SqlCommand("dbo.' + sp + '", cn))');
    L.push('                {');
    L.push('                    cmd.CommandType = CommandType.StoredProcedure;');
    L.push('                    cmd.CommandTimeout = 5;');
    p.tags.forEach((m, i) => {
      L.push('                    cmd.Parameters.Add("@' + m.col + '", SqlDbType.' + sqlDbType(m.sqlType) + (m.sqlType.startsWith('NVARCHAR') ? ', 255' : '') + ').Value = row[' + i + '] ?? (object)DBNull.Value;');
    });
    L.push('                    cmd.ExecuteNonQuery();');
    L.push('                }');
    L.push('            }');
    L.push('        }');
    L.push('        catch (SqlException ex)');
    L.push('        {');
    L.push('            LogError("DbLink SQL error " + ex.Number + ": " + ex.Message);');
    L.push('        }');
    L.push('        catch (Exception ex)');
    L.push('        {');
    L.push('            LogError("DbLink error: " + ex.Message);');
    L.push('        }');
    L.push('        finally');
    L.push('        {');
    L.push('            if (cn != null) cn.Dispose();');
    L.push('            Interlocked.Exchange(ref _running, 0);');
    L.push('            if (_dropped > 0) { LogMessage("DbLink dropped " + _dropped + " samples (queue full)"); _dropped = 0; }');
    L.push('        }');
    L.push('    }');
    L.push('');
    L.push('    // Replace with the ArchestrA script logging calls in your environment.');
    L.push('    static void LogMessage(string s) { /* LogMessage(s); */ }');
    L.push('    static void LogError(string s)   { /* LogError(s);   */ }');
    L.push('}');
    L.push('');
    L.push('// ---- Object script (execute on trigger / periodic, e.g. 5 s) -----------');
    L.push('// DbLinkLogger.Enqueue(' + p.tags.map((m) => 'Me.' + m.tag).join(', ') + ');');
    return L.join('\n');
  }
  function camel(s) { return String(s).charAt(0).toLowerCase() + String(s).slice(1); }
  function csType(m) { return { FLOAT: 'double', INT: 'int', BIT: 'bool', 'NVARCHAR(255)': 'string', DATETIME2: 'DateTime' }[m.sqlType] || 'object'; }
  function sqlDbType(t) { return { FLOAT: 'Float', INT: 'Int', BIT: 'Bit', 'NVARCHAR(255)': 'NVarChar', DATETIME2: 'DateTime2' }[t] || 'Variant'; }

  /* ---------- SQL DDL / dialects ---------- */
  const DIALECT_TYPES = {
    mssql:    { FLOAT: 'FLOAT', INT: 'INT', BIT: 'BIT', 'NVARCHAR(255)': 'NVARCHAR(255)', DATETIME2: 'DATETIME2(3)' },
    postgres: { FLOAT: 'DOUBLE PRECISION', INT: 'INTEGER', BIT: 'BOOLEAN', 'NVARCHAR(255)': 'VARCHAR(255)', DATETIME2: 'TIMESTAMPTZ' },
    mysql:    { FLOAT: 'DOUBLE', INT: 'INT', BIT: 'TINYINT(1)', 'NVARCHAR(255)': 'VARCHAR(255) CHARACTER SET utf8mb4', DATETIME2: 'DATETIME(3)' },
    oracle:   { FLOAT: 'BINARY_DOUBLE', INT: 'NUMBER(10)', BIT: 'NUMBER(1)', 'NVARCHAR(255)': 'NVARCHAR2(255)', DATETIME2: 'TIMESTAMP(3)' }
  };

  function genDDL(p, dialect) {
    dialect = dialect || 'mssql';
    const t = p.table || 'tbl_Telemetry'; const T = DIALECT_TYPES[dialect]; const tags = p.tags;
    const L = [];
    L.push('-- DB-Link SCADA Bridge : DDL (' + dialect + ')   Project: ' + p.name);
    if (dialect === 'postgres') {
      L.push('CREATE TABLE ' + t + ' (');
      L.push('  Id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,');
      L.push('  LogTime TIMESTAMPTZ NOT NULL DEFAULT now(),');
      tags.forEach((m, i) => L.push('  ' + m.col + ' ' + T[m.sqlType] + (m.nullable ? '' : ' NOT NULL') + (i < tags.length - 1 ? ',' : '')));
      L.push(');');
      L.push('CREATE INDEX ix_' + t + '_LogTime ON ' + t + ' USING BRIN (LogTime);');
      return L.join('\n');
    }
    if (dialect === 'mysql') {
      L.push('CREATE TABLE ' + t + ' (');
      L.push('  Id BIGINT NOT NULL AUTO_INCREMENT,');
      L.push('  LogTime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),');
      tags.forEach((m) => L.push('  ' + m.col + ' ' + T[m.sqlType] + (m.nullable ? ' NULL' : ' NOT NULL') + ','));
      L.push('  PRIMARY KEY (Id),');
      L.push('  KEY ix_LogTime (LogTime)');
      L.push(') ENGINE=InnoDB;');
      return L.join('\n');
    }
    if (dialect === 'oracle') {
      L.push('CREATE TABLE ' + t + ' (');
      L.push('  Id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,');
      L.push('  LogTime TIMESTAMP(3) DEFAULT SYSTIMESTAMP NOT NULL,');
      tags.forEach((m, i) => L.push('  ' + m.col + ' ' + T[m.sqlType] + (m.nullable ? '' : ' NOT NULL') + (i < tags.length - 1 ? ',' : '')));
      L.push(');');
      L.push('CREATE INDEX ix_' + t + '_LogTime ON ' + t + ' (LogTime);');
      return L.join('\n');
    }
    // SQL Server
    L.push('SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;');
    L.push('GO');
    L.push('CREATE TABLE dbo.' + t + ' (');
    L.push('  Id       BIGINT IDENTITY(1,1) NOT NULL,');
    L.push('  LogTime  DATETIME2(3) NOT NULL CONSTRAINT DF_' + t + '_LogTime DEFAULT SYSUTCDATETIME(),');
    tags.forEach((m) => L.push('  ' + m.col.padEnd(24) + T[m.sqlType] + (m.nullable ? ' NULL' : ' NOT NULL') + ','));
    L.push('  CONSTRAINT PK_' + t + ' PRIMARY KEY NONCLUSTERED (Id)');
    L.push(');');
    L.push('GO');
    L.push('-- Time-series access: cluster on time (append-only, avoids page splits)');
    L.push('CREATE CLUSTERED INDEX CIX_' + t + '_LogTime ON dbo.' + t + ' (LogTime, Id) WITH (FILLFACTOR = 100, DATA_COMPRESSION = PAGE);');
    const keys = tags.filter((m) => m.pk && !m.nullable);
    keys.forEach((m) => L.push('CREATE NONCLUSTERED INDEX IX_' + t + '_' + m.col + ' ON dbo.' + t + ' (' + m.col + ', LogTime);'));
    L.push('GO');
    L.push('');
    L.push('-- Parameterised insert procedure');
    L.push('CREATE OR ALTER PROCEDURE dbo.usp_InsertScadaTelemetry');
    tags.forEach((m, i) => L.push('  @' + m.col + ' ' + T[m.sqlType] + ' = NULL' + (i < tags.length - 1 ? ',' : '')));
    L.push('AS');
    L.push('BEGIN');
    L.push('  SET NOCOUNT ON; SET XACT_ABORT ON;');
    L.push('  BEGIN TRY');
    L.push('    INSERT INTO dbo.' + t + ' (' + tags.map((m) => m.col).join(', ') + ')');
    L.push('    VALUES (' + tags.map((m) => '@' + m.col).join(', ') + ');');
    L.push('  END TRY');
    L.push('  BEGIN CATCH');
    L.push("    DECLARE @msg NVARCHAR(2048) = ERROR_MESSAGE();");
    L.push('    THROW 50001, @msg, 1;');
    L.push('  END CATCH');
    L.push('END');
    L.push('GO');
    L.push('');
    L.push('-- Retention: delete in small batches to avoid log bloat and lock escalation');
    L.push('WHILE 1 = 1');
    L.push('BEGIN');
    L.push('  DELETE TOP (5000) FROM dbo.' + t + ' WHERE LogTime < DATEADD(DAY, -90, SYSUTCDATETIME());');
    L.push('  IF @@ROWCOUNT = 0 BREAK;');
    L.push('END');
    return L.join('\n');
  }

  /* ---------- Historian ---------- */
  function genHistorian(p) {
    const analog = p.tags.filter((m) => m.tagType !== 'Memory Message').slice(0, 4).map((m) => m.tag);
    const names = (analog.length ? analog : ['PT_101_PV']).map((s) => "'" + s + "'").join(', ');
    const L = [];
    L.push('-- AVEVA Historian (InSQL) retrieval templates     Project: ' + p.name);
    L.push('-- Verify table/view names against your Historian version.');
    L.push('');
    L.push('-- 1. Cyclic retrieval: 1 minute resolution over the last 8 hours');
    L.push('SELECT DateTime, TagName, Value, QualityDetail');
    L.push('FROM Runtime.dbo.History');
    L.push('WHERE TagName IN (' + names + ')');
    L.push("  AND wwRetrievalMode = 'Cyclic'");
    L.push('  AND wwResolution = 60000            -- ms');
    L.push("  AND wwQualityRule = 'Good'");
    L.push('  AND DateTime >= DATEADD(HOUR, -8, GETDATE())');
    L.push('  AND DateTime <= GETDATE()');
    L.push('ORDER BY TagName, DateTime;');
    L.push('');
    L.push('-- 2. Hourly aggregates (average, min, max) using the AnalogSummaryHistory view');
    L.push('SELECT StartDateTime, TagName, Average, Minimum, Maximum, PercentGood');
    L.push('FROM Runtime.dbo.AnalogSummaryHistory');
    L.push('WHERE TagName IN (' + names + ')');
    L.push('  AND wwResolution = 3600000');
    L.push('  AND StartDateTime >= DATEADD(DAY, -1, GETDATE())');
    L.push('ORDER BY TagName, StartDateTime;');
    L.push('');
    L.push('-- 3. Delta retrieval (stored changes only, lowest cost)');
    L.push('SELECT DateTime, TagName, Value');
    L.push('FROM Runtime.dbo.History');
    L.push("WHERE TagName = " + names.split(', ')[0]);
    L.push("  AND wwRetrievalMode = 'Delta'");
    L.push('  AND DateTime >= DATEADD(HOUR, -1, GETDATE());');
    L.push('');
    L.push('-- 4. Through a linked server (date literals must be inlined in OPENQUERY)');
    L.push("SELECT * FROM OPENQUERY(INSQL, 'SELECT DateTime, TagName, Value FROM Runtime.dbo.History");
    L.push("  WHERE TagName = ''" + names.split(', ')[0].replace(/'/g, '') + "'' AND wwRetrievalMode = ''Cyclic''");
    L.push("  AND wwResolution = 60000 AND DateTime >= ''2026-10-18 00:00'' AND DateTime <= ''2026-10-18 08:00''');");
    L.push('');
    L.push('-- 5. Alarm history (System Platform alarm DB; WWALMDB on legacy installs)');
    L.push('SELECT TOP (500) AlarmTime, Tag_Name, Alarm_State, Priority, Value, Comment');
    L.push('FROM WWALMDB.dbo.v_AlarmHistory      -- A2ALMDB.dbo.v_AlarmEventHistory on newer systems');
    L.push('WHERE Alarm_State IN (\'UNACK_ALM\', \'ACK_ALM\')');
    L.push('  AND AlarmTime >= DATEADD(DAY, -7, GETDATE())');
    L.push('ORDER BY AlarmTime DESC;');
    return L.join('\n');
  }

  /* ---------- connection strings ---------- */
  function genConnections(c) {
    const srv = c.server || 'SQLSRV01'; const db = c.database || 'ScadaDB';
    const auth = c.auth === 'sql' ? { odbc: 'UID=' + (c.user || 'scada_writer') + ';PWD=' + (c.pass || '<password>') + ';', ado: 'User ID=' + (c.user || 'scada_writer') + ';Password=' + (c.pass || '<password>') + ';' } : { odbc: 'Trusted_Connection=Yes;', ado: 'Integrated Security=SSPI;' };
    const dsn = c.dsn || 'DBLink_ODBC';
    const engine = c.engine || 'mssql';
    const odbcDriver = { mssql: 'ODBC Driver 17 for SQL Server', postgres: 'PostgreSQL Unicode', mysql: 'MySQL ODBC 8.0 Unicode Driver', oracle: 'Oracle in OraClient19Home1' }[engine];
    const out = [];
    out.push({ title: 'InTouch SQL Access Manager - ODBC System DSN', body:
      '[ODBC System DSN: ' + dsn + ']\nDriver  = ' + odbcDriver + '\nServer  = ' + srv + '\nDatabase= ' + db + '\n\n' +
      '[SQLConnect string used by InTouch]\nDSN=' + dsn + ';' + auth.odbc + 'DATABASE=' + db + ';\n\n' +
      '[DSN-less]\nDRIVER={' + odbcDriver + '};SERVER=' + srv + ';DATABASE=' + db + ';' + auth.odbc + '\n\n' +
      '// InTouch is a 32-bit application: create the DSN with C:\\Windows\\SysWOW64\\odbcad32.exe.\n// The default odbcad32.exe (System32) creates 64-bit DSNs that InTouch cannot see.' });
    out.push({ title: 'InTouch / OLE DB provider', body:
      'Provider=MSOLEDBSQL;Data Source=' + srv + ';Initial Catalog=' + db + ';' + auth.ado + 'Use Encryption for Data=Optional;\n' +
      '// Legacy: Provider=SQLNCLI11;  (deprecated, use MSOLEDBSQL where available)' });
    out.push({ title: 'ArchestrA / System Platform - ADO.NET SqlClient', body:
      'Data Source=' + srv + ';Initial Catalog=' + db + ';' + auth.ado +
      'Connection Timeout=' + (c.timeout || 5) + ';Pooling=true;Min Pool Size=' + (c.minPool || 2) + ';Max Pool Size=' + (c.maxPool || 20) + ';' +
      (c.failover ? 'Failover Partner=' + c.failover + ';' : '') +
      'MultiSubnetFailover=False;Application Name=ArchestrA_AppEngine;Encrypt=True;TrustServerCertificate=True;\n\n' +
      '// Use CommandTimeout <= the script execution interval; open late, close early (pooling reuses sockets).\n' +
      '// aaDBAccess users: pass the same server/database in the aaDBAccess connection dialog.' });
    out.push({ title: 'AVEVA Historian (InSQL) - Linked Server', body:
      "EXEC master.dbo.sp_addlinkedserver @server = N'INSQL', @srvproduct = N'', @provider = N'MSOLEDBSQL', @datasrc = N'" + (c.historian || 'HISTSRV01') + "';\n" +
      "EXEC master.dbo.sp_addlinkedsrvlogin @rmtsrvname = N'INSQL', @useself = N'False', @rmtuser = N'" + (c.histUser || 'wwUser') + "', @rmtpassword = N'<password>';\n" +
      "EXEC master.dbo.sp_serveroption N'INSQL', N'rpc out', N'true';\n\n" +
      "SELECT * FROM OPENQUERY(INSQL, 'SELECT TOP 10 DateTime, TagName, Value FROM Runtime.dbo.History WHERE TagName = ''" + (c.sampleTag || 'PT_101_PV') + "'' AND wwRetrievalMode = ''Cyclic'' AND wwResolution = 60000 AND DateTime >= DATEADD(HOUR,-1,GETDATE())');" });
    return out;
  }

  /* ---------- storage estimator ---------- */
  function estimateStorage(o) {
    const tags = +o.tags || 0; const scanSec = Math.max(0.001, (+o.scan || 1) * (o.unit === 'ms' ? 0.001 : 1));
    const days = +o.days || 0; const rowBytes = +o.rowBytes || 46; const idx = 1 + (+o.indexPct || 30) / 100;
    const change = o.mode === 'delta' ? Math.min(1, Math.max(0, (+o.changePct || 15) / 100)) : 1;
    const rowsPerSec = (tags / scanSec) * change;
    const rowsDay = rowsPerSec * 86400;
    const bytesDay = rowsDay * rowBytes * idx;
    const mbDay = bytesDay / 1048576; const gbYear = (bytesDay * 365) / 1073741824; const gbRetention = (bytesDay * days) / 1073741824;
    const batch = Math.max(1, +o.batch || 100);
    const iops = Math.ceil(rowsPerSec / batch) * 2 + Math.ceil(rowsPerSec * rowBytes * idx / 8192) * 0.1; // log + data page flush estimate
    const mbps = (rowsPerSec * rowBytes * 1.5) / 1048576;
    return { rowsPerSec, rowsDay, mbDay, gbYear, gbRetention, iops, mbps };
  }

  /* ---------- simulator ---------- */
  function simulateValue(m, prev, opts) {
    opts = opts || {}; const noise = opts.noise !== false;
    if (m.sqlType === 'BIT' || m.tagType === 'I/O Discrete') return opts.toggle ? !prev : !!prev;
    if (m.sqlType === 'NVARCHAR(255)') return prev && !opts.toggle ? prev : (opts.toggle ? 'HIGH PRESSURE ' + new Date().toISOString().slice(11, 19) : 'NORMAL');
    if (m.sqlType === 'DATETIME2') return new Date().toISOString().slice(0, 23).replace('T', ' ');
    const base = typeof prev === 'number' ? prev : 50;
    if (m.sqlType === 'INT') return Math.max(0, Math.round(base + (noise ? (Math.random() - 0.4) * 10 : 0)));
    if (/TOT/i.test(m.tag)) return +(base + (noise ? Math.random() * 2 : 0)).toFixed(3); // totalizers climb
    return +(Math.min(200, Math.max(0, base + (noise ? (Math.random() - 0.5) * 4 : 0)))).toFixed(3);
  }

  function resolveInsert(p, values) {
    const t = p.table;
    const lit = (m, v) => {
      if (m.sqlType === 'BIT') return v ? '1' : '0';
      if (m.sqlType === 'NVARCHAR(255)') return "N'" + String(v).replace(/'/g, "''") + "'";
      if (m.sqlType === 'DATETIME2') return "'" + v + "'";
      return String(v);
    };
    return 'INSERT INTO dbo.' + t + ' (' + p.tags.map((m) => m.col).join(', ') + ')\nVALUES (' + p.tags.map((m) => lit(m, values[m.tag])).join(', ') + ');';
  }
  function resolveSelect(p) {
    return 'SELECT TOP (100) LogTime, ' + p.tags.map((m) => m.col).join(', ') + '\nFROM dbo.' + p.table + '\nWHERE LogTime >= DATEADD(MINUTE, -15, SYSUTCDATETIME())\nORDER BY LogTime DESC;';
  }

  /* ---------- troubleshooting checklist ---------- */
  const CHECKLIST = [
    { t: 'ODBC 32-bit trap', d: 'InTouch is 32-bit. Create the System DSN with C:\\Windows\\SysWOW64\\odbcad32.exe; a DSN made in System32 is invisible to InTouch (SQLConnect returns a data source error).' },
    { t: 'Deadlocks', d: 'Keep writer transactions short and insert-only; read with SNAPSHOT / READ_COMMITTED_SNAPSHOT. Capture with the system_health extended event or trace flag 1222 and fix access order.' },
    { t: 'Transaction log bloat', d: 'Check log_reuse_wait_desc. Use the right recovery model, schedule log backups, batch retention deletes (5k rows) and avoid long open transactions from stuck connections.' },
    { t: 'Index fragmentation', d: 'Cluster on LogTime (append-only) with FILLFACTOR 100. Reorganise above 10% and rebuild above 30% fragmentation via sys.dm_db_index_physical_stats; keep non-clustered indexes minimal.' },
    { t: 'Per-row inserts', d: 'One INSERT per tag per scan floods the server. Batch into one wide row or table-valued parameters; log on change or at 1-10 s cycles.' },
    { t: 'AppEngine scan overruns', d: 'Never run synchronous SQL in a scan-time script. Queue the data and write from a background thread; set CommandTimeout lower than the script period.' },
    { t: '131-character literal', d: 'Any QuickScript string literal over 131 characters is rejected. Split with SQLSetStatement and SQLAppendStatement (generated automatically in Module 3).' },
    { t: 'Connection lifetime', d: 'Connect once at startup, reconnect on failure with back-off, and always SQLDisconnect on shutdown to avoid exhausting the server connection pool.' },
    { t: 'Time zones', d: 'Store UTC (SYSUTCDATETIME) and convert at reporting; avoid DST gaps and duplicate hours in cyclic trends.' },
    { t: 'Historian queries', d: 'Always bound DateTime and set wwResolution or wwCycleCount; unbounded history queries scan every block and can stall the Historian.' }
  ];

  const api = {
    TAG_TYPES, SQL_TYPES, INTOUCH_LIMIT, CHECKLIST, DIALECT_TYPES,
    validate, validateRow, parseTagCSV, toCSV, chunkSQL, qsEscape, toColumn, defaultSql,
    genQuickScript, genArchestra, genDDL, genHistorian, genConnections,
    estimateStorage, simulateValue, resolveInsert, resolveSelect, esc
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScadaEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
