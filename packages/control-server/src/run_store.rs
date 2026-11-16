//! Transactional run state and durable event cursors. One writer process per DB.
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

pub fn write_artifact(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        fs::File::open(path.parent().context("artifact parent")?)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct Store(Arc<Mutex<Connection>>);

pub struct ControlCommand<'a> {
    pub tool: &'a str,
    pub request: &'a str,
    pub signature: &'a str,
    pub actor: &'a str,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        fs::create_dir_all(path)?;
        let file = path.join("control.sqlite3");
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(&file)?;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
        }
        let db = Connection::open(file)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS control_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS task_runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request TEXT NOT NULL,signature TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(owner,request));
          CREATE TABLE IF NOT EXISTS run_events(run TEXT NOT NULL,seq INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run,seq));
          CREATE TABLE IF NOT EXISTS run_commands(run TEXT NOT NULL,tool TEXT NOT NULL,request TEXT NOT NULL,signature TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run,tool,request));
          CREATE TABLE IF NOT EXISTS integrations(id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,body TEXT NOT NULL);
          INSERT OR IGNORE INTO control_meta VALUES('schema_version','1');")?;
        Ok(Self(Arc::new(Mutex::new(db))))
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .query_row("SELECT value FROM control_meta WHERE key=?", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }
    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.0.lock().unwrap().execute("INSERT INTO control_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])?;
        Ok(())
    }
    pub fn run(&self, id: &str) -> Result<Value> {
        let raw: String = self
            .0
            .lock()
            .unwrap()
            .query_row("SELECT body FROM task_runs WHERE id=?", [id], |r| r.get(0))
            .context("run_not_found")?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn runs(&self) -> Result<Vec<Value>> {
        let db = self.0.lock().unwrap();
        let mut query = db.prepare("SELECT body FROM task_runs ORDER BY rowid DESC")?;
        let rows = query.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn create(
        &self,
        mut run: Value,
        owner: &str,
        request: &str,
        signature: &str,
    ) -> Result<(Value, bool)> {
        let mut db = self.0.lock().unwrap();
        let tx = db.transaction()?;
        let old: Option<(String, String)> = tx
            .query_row(
                "SELECT body,signature FROM task_runs WHERE owner=? AND request=?",
                params![owner, request],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((body, hash)) = old {
            anyhow::ensure!(hash == signature, "request_id_conflict");
            return Ok((serde_json::from_str(&body)?, false));
        }
        append(&tx, &mut run, "run.created", json!({}))?;
        tx.execute(
            "INSERT INTO task_runs VALUES(?,?,?,?,?)",
            params![
                run["run_id"].as_str(),
                owner,
                request,
                signature,
                run.to_string()
            ],
        )?;
        tx.commit()?;
        Ok((run, true))
    }
    pub fn edit(
        &self,
        id: &str,
        change: impl FnOnce(&mut Value) -> Result<()>,
        kind: &str,
        payload: Value,
    ) -> Result<Value> {
        let mut db = self.0.lock().unwrap();
        let tx = db.transaction()?;
        let raw: String =
            tx.query_row("SELECT body FROM task_runs WHERE id=?", [id], |r| r.get(0))?;
        let mut run: Value = serde_json::from_str(&raw)?;
        change(&mut run)?;
        if !kind.is_empty() {
            append(&tx, &mut run, kind, payload)?;
        }
        tx.execute(
            "UPDATE task_runs SET body=? WHERE id=?",
            params![run.to_string(), id],
        )?;
        tx.commit()?;
        Ok(run)
    }
    pub fn command(&self, id: &str, tool: &str, request: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self
            .0
            .lock()
            .unwrap()
            .query_row(
                "SELECT body FROM run_commands WHERE run=? AND tool=? AND request=?",
                params![id, tool, request],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    pub fn pending(&self, id: &str) -> Result<Vec<Value>> {
        let db = self.0.lock().unwrap();
        let mut q = db.prepare("SELECT tool,request,body FROM run_commands WHERE run=? AND json_extract(body,'$.status')='pending'")?;
        let rows = q.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|r| {
            let (t, id, b) = r?;
            Ok(json!({"tool":t,"request_id":id,"command":serde_json::from_str::<Value>(&b)?}))
        })
        .collect()
    }
    // Local control transitions and their idempotent results commit together.
    pub fn control_command(
        &self,
        id: &str,
        command: ControlCommand<'_>,
        change: impl FnOnce(&mut Value) -> Result<()>,
        project: impl FnOnce(&Value) -> Value,
    ) -> Result<Value> {
        let ControlCommand {
            tool,
            request,
            signature,
            actor,
        } = command;
        let mut db = self.0.lock().unwrap();
        let tx = db.transaction()?;
        let old: Option<String> = tx
            .query_row(
                "SELECT body FROM run_commands WHERE run=? AND tool=? AND request=?",
                params![id, tool, request],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            let c: Value = serde_json::from_str(&old)?;
            anyhow::ensure!(c["signature"] == signature, "request_id_conflict");
            if c["status"] == "completed" {
                return Ok(c["result"].clone());
            }
        }
        let raw: String =
            tx.query_row("SELECT body FROM task_runs WHERE id=?", [id], |r| r.get(0))?;
        let mut run: Value = serde_json::from_str(&raw)?;
        change(&mut run)?;
        append(
            &tx,
            &mut run,
            "run.interrupted",
            json!({"tool":tool,"request_id":request,"actor_id":actor}),
        )?;
        append(
            &tx,
            &mut run,
            "tool.completed",
            json!({"tool":tool,"request_id":request,"actor_id":actor}),
        )?;
        let result = project(&run);
        let cmd = json!({"signature":signature,"status":"completed","result":result});
        tx.execute("INSERT INTO run_commands VALUES(?,?,?,?,?) ON CONFLICT(run,tool,request) DO UPDATE SET body=excluded.body",params![id,tool,request,signature,cmd.to_string()])?;
        tx.execute(
            "UPDATE task_runs SET body=? WHERE id=?",
            params![run.to_string(), id],
        )?;
        tx.commit()?;
        Ok(result)
    }
    pub fn write_command(
        &self,
        id: &str,
        tool: &str,
        request: &str,
        command: &Value,
        kind: &str,
        payload: Value,
    ) -> Result<()> {
        let mut db = self.0.lock().unwrap();
        let tx = db.transaction()?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT body FROM run_commands WHERE run=? AND tool=? AND request=?",
                params![id, tool, request],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(raw) = previous {
            let previous: Value = serde_json::from_str(&raw)?;
            anyhow::ensure!(
                previous["signature"] == command["signature"],
                "request_id_conflict"
            );
            if previous["status"] == "completed" {
                return Ok(());
            }
        }
        tx.execute("INSERT INTO run_commands VALUES(?,?,?,?,?) ON CONFLICT(run,tool,request) DO UPDATE SET body=excluded.body",params![id,tool,request,command["signature"].as_str(),command.to_string()])?;
        let raw: String =
            tx.query_row("SELECT body FROM task_runs WHERE id=?", [id], |r| r.get(0))?;
        let mut run: Value = serde_json::from_str(&raw)?;
        if kind == "tool.completed" {
            if tool == "box_record_note" {
                append(
                    &tx,
                    &mut run,
                    "agent.note",
                    json!({"kind":command["input"]["kind"],"text":command["input"]["text"],"request_id":request,"actor_id":command["actor_id"]}),
                )?;
            }
            if run["status"] == "running"
                && run["phase"] == "reconciling"
                && run["pending_command"]["tool"] == tool
                && run["pending_command"]["request_id"] == request
            {
                run["phase"] = json!("waiting_for_agent");
                run.as_object_mut().unwrap().remove("pending_command");
            }
        }
        if !kind.is_empty() {
            append(&tx, &mut run, kind, payload)?;
        }
        tx.execute(
            "UPDATE task_runs SET body=? WHERE id=?",
            params![run.to_string(), id],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn events(&self, id: &str, after: u64, limit: u64) -> Result<Vec<Value>> {
        let db = self.0.lock().unwrap();
        let mut q =
            db.prepare("SELECT body FROM run_events WHERE run=? AND seq>? ORDER BY seq LIMIT ?")?;
        let rows = q.query_map(params![id, after, limit], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn put_integration(&self, id: &str, hash: &str, body: &Value) -> Result<()> {
        self.0.lock().unwrap().execute("INSERT INTO integrations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,body=excluded.body",params![id,hash,body.to_string()])?;
        Ok(())
    }
    pub fn integrations(&self) -> Result<Vec<(String, Value)>> {
        let db = self.0.lock().unwrap();
        let mut q = db.prepare("SELECT hash,body FROM integrations")?;
        let rows = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.map(|r| {
            let (h, b) = r?;
            Ok((h, serde_json::from_str(&b)?))
        })
        .collect()
    }
}

fn append(tx: &Transaction<'_>, run: &mut Value, kind: &str, payload: Value) -> Result<()> {
    let seq = run["event_cursor"].as_u64().unwrap_or(0) + 1;
    let event = json!({"schema_version":1,"run_id":run["run_id"],"seq":seq,"kind":kind,
        "source":if kind=="agent.note"{"external_agent"}else if kind=="world.updated"{"world"}else{"control"},
        "actor_id":payload.get("actor_id").filter(|v|v.is_string()).cloned().unwrap_or_else(||if kind=="run.created"{run["owner_id"].clone()}else{json!("control")}),
        "world_session_id":run["session"]["id"],"world_revision":run["world_revision"],"tick":run["tick"],
        "occurred_at_ms":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64,"payload":payload});
    tx.execute(
        "INSERT INTO run_events VALUES(?,?,?)",
        params![run["run_id"].as_str(), seq, event.to_string()],
    )?;
    run["event_cursor"] = json!(seq);
    Ok(())
}
