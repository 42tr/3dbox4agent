use crate::run_store::{ControlCommand, Store};
use anyhow::{anyhow, bail, ensure, Context, Result};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const MAX_ARCHIVE_BYTES: usize = 50 * 1024 * 1024;
const MAX_ARCHIVE_FRAMES: usize = 5000;
const MAX_RUN_EVENTS: u64 = 50000;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
pub fn hash(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or_else(|| anyhow!("invalid_{key}"))
}
fn terminal(r: &Value) -> bool {
    matches!(
        r["status"].as_str(),
        Some("completed" | "cancelled" | "failed" | "timeout")
    )
}
pub fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|s| !s.is_empty())
}
pub fn tool_definitions() -> Vec<Value> {
    serde_json::from_str(include_str!("../../control/schemas/task-tools.v1.json"))
        .expect("embedded tool schema")
}
fn scene() -> Value {
    serde_json::from_str(include_str!("../../world/scenes/industrial-park-v2.json"))
        .expect("embedded scene")
}

// The same bounded schema validation is used for MCP, HTTP and stdio.
pub fn validate(value: &Value, schema: &Value) -> Result<()> {
    if let Some(choices) = schema["oneOf"].as_array() {
        ensure!(
            choices
                .iter()
                .filter(|s| validate(value, s).is_ok())
                .count()
                == 1,
            "invalid_arguments"
        );
        return Ok(());
    }
    if let Some(values) = schema["enum"].as_array() {
        ensure!(values.contains(value), "invalid_arguments")
    }
    match schema["type"].as_str() {
        Some("object") => {
            let map = value.as_object().context("invalid_arguments")?;
            let props = schema["properties"].as_object().context("invalid_schema")?;
            for key in schema["required"].as_array().into_iter().flatten() {
                ensure!(
                    map.contains_key(key.as_str().unwrap()),
                    "missing_{}",
                    key.as_str().unwrap()
                )
            }
            for (key, v) in map {
                let s = props
                    .get(key)
                    .ok_or_else(|| anyhow!("unknown_argument_{key}"))?;
                validate(v, s)?;
            }
        }
        Some("string") => {
            let s = value.as_str().context("invalid_arguments")?;
            ensure!(
                s.len() >= schema["minLength"].as_u64().unwrap_or(0) as usize
                    && s.len() <= schema["maxLength"].as_u64().unwrap_or(8192) as usize,
                "invalid_arguments"
            );
            if schema.get("pattern").is_some() {
                ensure!(
                    s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
                    "invalid_identifier"
                )
            }
        }
        Some("integer" | "number") => {
            if schema["type"] == "integer" {
                ensure!(value.as_u64().is_some(), "invalid_arguments")
            };
            let n = value.as_f64().context("invalid_arguments")?;
            ensure!(
                n >= schema["minimum"].as_f64().unwrap_or(0.0)
                    && n <= schema["maximum"].as_f64().unwrap_or(9007199254740991.0)
                    && schema["exclusiveMaximum"].as_f64().is_none_or(|max| n < max),
                "invalid_arguments"
            )
        }
        Some("boolean") => ensure!(value.is_boolean(), "invalid_arguments"),
        Some("array") => {
            let a = value.as_array().context("invalid_arguments")?;
            ensure!(
                a.len() >= schema["minItems"].as_u64().unwrap_or(0) as usize
                    && a.len() <= schema["maxItems"].as_u64().unwrap_or(200) as usize,
                "invalid_arguments"
            );
            for v in a {
                validate(v, &schema["items"])?
            }
        }
        _ => bail!("invalid_schema"),
    };
    Ok(())
}

#[derive(Clone)]
pub struct Principal {
    pub id: String,
    pub operator: bool,
    pub scopes: Value,
}
#[derive(Clone)]
pub struct RunService {
    pub store: Store,
    client: Client,
    world: Arc<str>,
    operator_hash: Option<String>,
    console_url: String,
    locks: Arc<Mutex<BTreeMap<String, Arc<AsyncMutex<()>>>>>,
    create_lock: Arc<AsyncMutex<()>>,
    data_dir: PathBuf,
    rate_windows: Arc<Mutex<BTreeMap<String, (u64, u32)>>>,
    streams: Arc<tokio::sync::Semaphore>,
}
impl RunService {
    pub fn open(client: Client, world: Arc<str>) -> Result<Self> {
        let data_dir = PathBuf::from(
            env::var("BOX_CONTROL_DATA_DIR")
                .or_else(|_| env::var("BOX_RUNNER_DATA_DIR"))
                .unwrap_or_else(|_| ".3dbox/control".into()),
        );
        let store = Store::open(&data_dir)?;
        let console_url =
            env::var("BOX_CONSOLE_URL").unwrap_or_else(|_| "http://127.0.0.1:8780".into());
        let url = reqwest::Url::parse(&console_url)?;
        ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "invalid BOX_CONSOLE_URL"
        );
        Ok(Self {
            store,
            client,
            world,
            operator_hash: env::var("BOX_RUNNER_OPERATOR_TOKEN")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|s| hash(&s)),
            console_url,
            locks: Default::default(),
            create_lock: Default::default(),
            data_dir,
            rate_windows: Default::default(),
            streams: Arc::new(tokio::sync::Semaphore::new(64)),
        })
    }
    pub fn authenticate(&self, token: &str) -> Result<Principal> {
        let digest = hash(token);
        if self
            .operator_hash
            .as_ref()
            .is_some_and(|h| bool::from(h.as_bytes().ct_eq(digest.as_bytes())))
        {
            return Ok(Principal {
                id: "operator".into(),
                operator: true,
                scopes: json!({}),
            });
        }
        for (h, b) in self.store.integrations()? {
            if bool::from(h.as_bytes().ct_eq(digest.as_bytes()))
                && b["revoked"] != true
                && b["expires_at"].as_u64().unwrap_or(0) > now()
            {
                return Ok(Principal {
                    id: field(&b, "id")?.into(),
                    operator: false,
                    scopes: b,
                });
            }
        }
        bail!("unauthorized")
    }
    fn authorized(&self, p: &Principal, id: &str) -> Result<Value> {
        let r = self.store.run(id).map_err(|_| anyhow!("run_not_found"))?;
        ensure!(p.operator || r["owner_id"] == p.id, "forbidden");
        Ok(r)
    }
    fn lock(&self, id: &str) -> Arc<AsyncMutex<()>> {
        self.locks
            .lock()
            .unwrap()
            .entry(id.into())
            .or_default()
            .clone()
    }
    pub fn summary(&self, r: &Value) -> Value {
        let mut out = r.clone();
        let o = out.as_object_mut().unwrap();
        for key in [
            "session",
            "creation_key",
            "creation_expires_at",
            "credentials",
            "scene",
            "last_world_event",
        ] {
            o.remove(key);
        }
        out["console_url"] = json!(format!(
            "{}/#run={}",
            self.console_url.trim_end_matches('/'),
            r["run_id"].as_str().unwrap()
        ));
        out["can_observe"] = json!(r["session"]["observer_token"].is_string() && !terminal(r));
        out["next_actions"] = if terminal(r) {
            json!(["box_get_events"])
        } else if r["phase"] == "paused" {
            json!(["box_resume_run"])
        } else {
            json!([
                "box_observe",
                "box_assign_task",
                "box_submit_action",
                "box_advance"
            ])
        };
        out
    }
    pub fn list(&self, p: &Principal) -> Result<Value> {
        Ok(
            json!({"runs":self.store.runs()?.iter().filter(|r|p.operator||r["owner_id"]==p.id).map(|r|self.summary(r)).collect::<Vec<_>>()}),
        )
    }
    pub fn capabilities(&self, p: &Principal) -> Value {
        json!({"version":1,"scenes":[scene()],"execution_modes":["agent","primitive"],"dispatch_modes":["external"],"objectives":["all_tasks_done","scene_completed"],"limits":{"max_ticks_per_call":100,"max_wall_ms_per_call":2000,"max_ticks":10000},"permissions":p.scopes,"tools":tool_definitions(),"workflow":"create_run → observe(coordinator) → assign_task → submit_action → advance → repeat until get_run.status is terminal. Agent thinking does not advance simulation."})
    }
    async fn world(
        &self,
        method: &str,
        route: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut req = self
            .client
            .request(method.parse()?, format!("{}{}", self.world, route))
            .timeout(Duration::from_secs(8));
        if let Some(t) = token {
            req = req.bearer_auth(t)
        };
        if let Some(b) = body {
            req = req.json(&b)
        };
        let response = req.send().await.map_err(|_| anyhow!("outcome_unknown"))?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|_| anyhow!("outcome_unknown"))?;
        if !status.is_success() {
            let code = value["error"].as_str().unwrap_or("world_response_failed");
            if code == "session_not_found" || code == "world_process_exited" {
                bail!("world_session_lost")
            };
            if status.is_server_error()
                && !["world_step_failed", "journal_write_failed"].contains(&code)
            {
                bail!("outcome_unknown")
            }
            bail!("{code}")
        };
        Ok(value)
    }
    async fn session_request(
        &self,
        r: &Value,
        method: &str,
        path: &str,
        token: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        self.world(
            method,
            &format!("/sessions/{}{}", field(&r["session"], "id")?, path),
            Some(token),
            body,
        )
        .await
    }
    async fn snapshot(&self, r: &Value) -> Result<Value> {
        self.session_request(r, "GET", "", field(&r["session"], "admin_token")?, None)
            .await
    }
    fn writable(&self, r: &Value, input: &Value) -> Result<()> {
        ensure!(
            r["status"] == "running" && r["phase"] != "paused",
            "run_not_writable"
        );
        ensure!(
            r["control_epoch"] == input["control_epoch"],
            "control_epoch_conflict"
        );
        ensure!(
            now() < r["deadline"].as_u64().unwrap_or(0),
            "budget_exhausted"
        );
        Ok(())
    }
    fn record_snapshot(&self, id: &str, snapshot: &Value) -> Result<Value> {
        let world = &snapshot["world"];
        let old = self.store.run(id)?;
        let events = world["events"].as_array().cloned().unwrap_or_default();
        let from = old["last_world_event"].as_u64().unwrap_or(0) as usize;
        self.store.edit(id,|r|{r["world_revision"]=snapshot["revision"].clone();r["tick"]=world["tick"].clone();r["last_world_event"]=json!(events.len());
            let ids=r["objective"]["task_ids"].as_array().cloned().unwrap_or_default();let tasks=world["tasks"].as_array().context("invalid_world_response")?;
            r["conditions"]=json!(ids.iter().map(|id|json!({"task_id":id,"done":tasks.iter().any(|t|t["id"]==*id&&t["status"]=="done")})).collect::<Vec<_>>());Ok(())},"world.updated",json!({"events":events.iter().skip(from).collect::<Vec<_>>()}))
    }
    async fn evaluate(&self, id: &str, snapshot: &Value) -> Result<bool> {
        let run = self.record_snapshot(id, snapshot)?;
        if run["status"] != "running" {
            return Ok(terminal(&run) || run["status"] == "stopping");
        }
        let all = run["conditions"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && a.iter().all(|c| c["done"] == true));
        let done = if run["objective"]["type"] == "scene_completed" {
            snapshot["world"]["done"] == true
        } else {
            all
        };
        let failed = snapshot["world"]["failed"] == true
            || snapshot.get("simulationError").is_some()
            || snapshot.get("sessionError").is_some();
        if done || failed {
            self.store.edit(id,|r|{if r["status"]=="running"{r["status"]=json!("stopping");r["outcome"]=json!(if failed{"failed"}else{"completed"});r["phase"]=json!("archiving");r["control_epoch"]=json!(r["control_epoch"].as_u64().unwrap()+1);r["result"]=json!({"success":!failed,"conditions":r["conditions"],"tick":snapshot["world"]["tick"],"world_revision":snapshot["revision"],"objective_hash":r["objective_hash"],"reason":if failed{"world_failed"}else{"objective_satisfied"}})}Ok(())},"objective.evaluated",json!({"success":!failed}))?;
            return Ok(true);
        };
        Ok(false)
    }

    pub async fn call(&self, p: &Principal, name: &str, input: Value) -> Result<Value> {
        {
            let mut windows = self.rate_windows.lock().unwrap();
            let window = windows.entry(p.id.clone()).or_insert((now(), 0));
            if window.0 != now() {
                *window = (now(), 0)
            };
            ensure!(window.1 < 120, "rate_limited");
            window.1 += 1;
        }
        let schema = tool_definitions()
            .into_iter()
            .find(|t| t["name"] == name)
            .context("unknown_tool")?;
        validate(&input, &schema["inputSchema"])?;
        if name == "box_get_capabilities" {
            if let Some(id) = input["scene_id"].as_str() {
                ensure!(id == "industrial-park-v2", "scene_not_supported")
            };
            return Ok(self.capabilities(p));
        }
        if name == "box_create_run" {
            return self.create(p, input).await;
        }
        let id = field(&input, "run_id")?.to_string();
        let r = self.authorized(p, &id)?;
        if !p.operator && r["status"] == "running" {
            self.store.edit(
                &id,
                |r| {
                    r["last_active"] = json!(now());
                    Ok(())
                },
                "",
                Value::Null,
            )?;
        }
        let result = async {
            match name {
                "box_get_run" => Ok(self.summary(&r)),
                "box_get_events" => {
                    let mut events = self.store.events(
                        &id,
                        input["after_seq"].as_u64().unwrap_or(0),
                        input["limit"].as_u64().unwrap_or(100),
                    )?;
                    if !p.operator {
                        for event in &mut events {
                            if event["kind"] == "world.updated" {
                                event["payload"] = json!({"scope":"console_only"})
                            }
                        }
                    }
                    let next = events
                        .last()
                        .map(|e| e["seq"].clone())
                        .unwrap_or_else(|| json!(input["after_seq"].as_u64().unwrap_or(0)));
                    Ok(json!({"events":events,"next_cursor":next,"event_cursor":r["event_cursor"]}))
                }
                "box_observe" => {
                    let _guard = self.lock(&id).lock_owned().await;
                    self.observe(p, &id, &input).await
                }
                "box_cancel_run" | "box_pause_run" => self.interrupt(p, name, &input),
                _ => {
                    let _guard = self.lock(&id).lock_owned().await;
                    self.command(p, name, &input).await
                }
            }
        }
        .await;
        if result
            .as_ref()
            .err()
            .is_some_and(|e| e.to_string() == "world_session_lost")
        {
            self.fail(&id, "world_session_lost")?;
        }
        result
    }
    async fn observe(&self, p: &Principal, id: &str, input: &Value) -> Result<Value> {
        let r = self.authorized(p, id)?;
        let record = r["event_cursor"].as_u64().unwrap_or(0) < MAX_RUN_EVENTS;
        let mut payload = json!({"tool":"box_observe","call_id":Uuid::new_v4(),"view":input["view"],"agent_id":input["agent_id"],"actor_id":p.id});
        if record {
            self.store
                .edit(id, |_| Ok(()), "tool.started", payload.clone())?;
        }
        let result: Result<Value> = async {
            ensure!(!terminal(&r), "run_not_writable");
            let include = if input["include_device"] == true { "?include=device" } else { "" };
            let (agent, path) = if input["view"] == "agent" {
                let agent = field(input, "agent_id")?;
                self.check_agent(p, &r, agent)?;
                (Some(agent), format!("/observations/{agent}{include}"))
            } else {
                ensure!(p.operator || p.scopes["coordinator"] == true, "forbidden");
                (None, format!("/coordinator/observation{include}"))
            };
            let token = self.credential(id, agent).await?;
            let observation = self.session_request(&r, "GET", &path, &token, None).await?;
            Ok(json!({"run_id":id,"world_revision":r["world_revision"],"control_epoch":r["control_epoch"],"observation":observation}))
        }.await;
        if let Err(error) = &result {
            if record {
                payload["code"] = json!(error.to_string());
                self.store.edit(id, |_| Ok(()), "tool.failed", payload)?;
            }
        } else {
            self.store.edit(
                id,
                |r| {
                    if !p.operator {
                        r["last_active"] = json!(now());
                    }
                    Ok(())
                },
                if record { "tool.observed" } else { "" },
                payload,
            )?;
        }
        result
    }
    fn check_agent(&self, p: &Principal, r: &Value, agent: &str) -> Result<()> {
        let agents = r["agents"].as_array().context("invalid_run")?;
        let a = agents
            .iter()
            .find(|a| a["id"] == agent)
            .context("agent_not_found")?;
        ensure!(
            p.operator
                || p.scopes["roles"]
                    .as_array()
                    .is_some_and(|roles| roles.contains(&a["role"])),
            "forbidden"
        );
        Ok(())
    }
    async fn credential(&self, id: &str, agent: Option<&str>) -> Result<String> {
        let key = agent.unwrap_or("coordinator");
        let r = self.store.run(id)?;
        if let Some(t) = r["credentials"][key].as_str() {
            return Ok(t.into());
        }
        let path = agent
            .map(|a| format!("/agents/{a}/credentials"))
            .unwrap_or_else(|| "/coordinator/credentials".into());
        let field = if agent.is_some() {
            "agentToken"
        } else {
            "coordinatorToken"
        };
        let v = self
            .session_request(
                &r,
                "POST",
                &path,
                field_str(&r["session"], "admin_token")?,
                Some(json!({})),
            )
            .await?;
        let token = field_str(&v, field)?.to_string();
        self.store.edit(
            id,
            |r| {
                r["credentials"][key] = json!(token);
                Ok(())
            },
            "",
            Value::Null,
        )?;
        Ok(token)
    }
    async fn create(&self, p: &Principal, input: Value) -> Result<Value> {
        ensure!(!p.operator, "integration_token_required");
        let _creation = self.create_lock.lock().await;
        ensure!(
            input["scene_id"] == "industrial-park-v2"
                && p.scopes["scenes"]
                    .as_array()
                    .is_some_and(|a| a.contains(&input["scene_id"])),
            "scene_not_supported"
        );
        let mut config = json!({"seed":42,"physics_mode":"kinematic","execution_mode":"agent","dispatch_mode":"external","max_ticks":3000,"max_wall_seconds":1800,"idle_timeout_seconds":300,"speed":5});
        if let Some(c) = input["config"].as_object() {
            for (k, v) in c {
                config[k] = v.clone()
            }
        }
        ensure!(
            config["max_wall_seconds"].as_u64() <= p.scopes["max_wall_seconds"].as_u64(),
            "budget_exhausted"
        );
        let mut objective = input["objective"].clone();
        let sc = scene();
        let tasks = sc["tasks"].as_array().unwrap();
        if objective["type"] == "scene_completed" {
            ensure!(objective.get("task_ids").is_none(), "objective_unsupported");
            objective["task_ids"] = json!(tasks.iter().map(|t| t["id"].clone()).collect::<Vec<_>>())
        }
        let ids = objective["task_ids"]
            .as_array()
            .context("objective_unsupported")?;
        ensure!(
            !ids.is_empty() && ids.iter().all(|id| tasks.iter().any(|t| t["id"] == *id)),
            "objective_unsupported"
        );
        let request = field(&input, "request_id")?;
        let signature = hash(&input.to_string());
        let created_at = now();
        let deadline = created_at + config["max_wall_seconds"].as_u64().unwrap();
        let creation_expires_at = deadline.min(created_at + 30 * 60) * 1000;
        let run = json!({"run_id":Uuid::new_v4().to_string(),"owner_id":p.id,"owner_label":p.scopes["label"],"request_id":request,"executor_kind":"external_mcp","scene_id":input["scene_id"],"objective_hash":hash(&objective.to_string()),"objective":objective,"config":config,"status":"starting","phase":"creating_world","control_epoch":1,"created_at":created_at,"last_active":created_at,"deadline":deadline,"event_cursor":0,"world_revision":0,"tick":0,"last_world_event":0,"creation_key":secret(),"creation_expires_at":creation_expires_at,"credentials":{},"archive_status":"pending"});
        let (r, _) = self.store.create(
            run,
            &p.id,
            request,
            &signature,
            p.scopes["max_concurrency"].as_u64().unwrap_or(1),
        )?;
        let id = field(&r, "run_id")?;
        let _guard = self.lock(id).lock_owned().await;
        let r = self.store.run(id)?;
        if r["status"] == "starting" {
            if let Err(error) = self.setup(id).await {
                let code = error.to_string();
                if code != "outcome_unknown" {
                    self.fail(id, &code)?;
                }
                return Err(error);
            }
        };
        Ok(self.summary(&self.store.run(id)?))
    }
    async fn setup(&self, id: &str) -> Result<()> {
        let r = self.store.run(id)?;
        if r["session"].is_null() {
            let c = &r["config"];
            let mut creation = json!({"creationKey":r["creation_key"],"sceneId":r["scene_id"],"seed":c["seed"],"physicsMode":c["physics_mode"],"executionMode":c["execution_mode"],"dispatchMode":"external"});
            // Rows written by older Controls must retry with their original payload.
            if let Some(expires_at) = r["creation_expires_at"].as_u64() {
                creation["creationExpiresAt"] = json!(expires_at);
            }
            let v = self
                .world("POST", "/sessions", None, Some(creation))
                .await?;
            self.store.edit(
                id,
                |r| {
                    r["session"] = json!({"id":v["sessionId"],"admin_token":v["adminToken"]});
                    r["agents"] = json!(v["world"]["agents"]
                        .as_array()
                        .context("invalid_world_response")?
                        .iter()
                        .map(|a| json!({"id":a["id"],"role":a["role"]}))
                        .collect::<Vec<_>>());
                    r["recording_context"] = v["recordingContext"].clone();
                    Ok(())
                },
                "run.session_created",
                json!({}),
            )?;
        }
        let r = self.store.run(id)?;
        if r["session"]["observer_token"].is_null() {
            let v = self
                .session_request(
                    &r,
                    "POST",
                    "/observer/credentials",
                    field(&r["session"], "admin_token")?,
                    Some(json!({})),
                )
                .await?;
            self.store.edit(
                id,
                |r| {
                    r["session"]["observer_token"] = v["observerToken"].clone();
                    Ok(())
                },
                "",
                Value::Null,
            )?;
        }
        self.store.edit(
            id,
            |r| {
                if r["status"] == "starting" {
                    r["status"] = json!("running");
                    r["phase"] = json!("waiting_for_agent")
                }
                Ok(())
            },
            "run.started",
            json!({}),
        )?;
        let r = self.store.run(id)?;
        self.record_snapshot(id, &self.snapshot(&r).await?)?;
        Ok(())
    }

    fn interrupt(&self, p: &Principal, name: &str, input: &Value) -> Result<Value> {
        let id = field(input, "run_id")?;
        self.authorized(p, id)?;
        self.store.control_command(
            id,
            ControlCommand {
                tool: name,
                request: field(input, "request_id")?,
                signature: &hash(&input.to_string()),
                actor: &p.id,
            },
            |r| {
                ensure!(
                    r["control_epoch"] == input["control_epoch"],
                    "control_epoch_conflict"
                );
                if !terminal(r) && r["status"] != "stopping" {
                    r["control_epoch"] = json!(r["control_epoch"].as_u64().unwrap() + 1);
                    if name == "box_cancel_run" {
                        r["status"] = json!("stopping");
                        r["outcome"] = json!("cancelled");
                        r["phase"] = json!("archiving");
                    } else {
                        r["phase"] = json!("paused");
                    }
                }
                Ok(())
            },
            |r| self.summary(r),
        )
    }
    async fn command(&self, p: &Principal, name: &str, input: &Value) -> Result<Value> {
        let id = field(input, "run_id")?;
        let request = if name == "box_submit_action" {
            field(&input["action"], "requestId")?
        } else {
            field(input, "request_id")?
        };
        let sig = hash(&input.to_string());
        let mut cmd=self.store.command(id,name,request)?.unwrap_or_else(||json!({"signature":sig,"status":"pending","command_id":Uuid::new_v4().to_string(),"input":input,"started_at":now(),"steps":0}));
        cmd["actor_id"] = json!(p.id);
        cmd["call_id"] = json!(Uuid::new_v4().to_string());
        let r = self.authorized(p, id)?;
        let mut event = json!({"tool":name,"request_id":request,"command_id":cmd["command_id"],"call_id":cmd["call_id"],"actor_id":p.id});
        if let Some(agent) = input["agent_id"].as_str() {
            event["agent_id"] = json!(agent);
        }
        if let Some(task) = input["task_id"]
            .as_str()
            .or_else(|| input["action"]["taskId"].as_str())
        {
            event["task_id"] = json!(task);
        }
        if let Some(action) = input["action"]["type"].as_str() {
            event["action_type"] = json!(action);
        }
        let record = r["event_cursor"].as_u64().unwrap_or(0) < MAX_RUN_EVENTS;
        let check = || -> Result<Option<Value>> {
            ensure!(cmd["signature"] == sig, "request_id_conflict");
            if cmd["status"] == "completed" {
                return Ok(Some(cmd["result"].clone()));
            }
            if cmd["status"] == "failed" {
                bail!("{}", cmd["error"].as_str().unwrap_or("command_failed"))
            }
            ensure!(
                now() < r["deadline"].as_u64().unwrap_or(0),
                "budget_exhausted"
            );
            ensure!(
                name == "box_resume_run"
                    || self
                        .store
                        .pending(id)?
                        .iter()
                        .all(|c| c["tool"] == name && c["request_id"] == request),
                "run_reconciling"
            );
            ensure!(record, "run_event_limit");
            if name == "box_resume_run" {
                ensure!(
                    r["status"] == "running"
                        && r["phase"] == "paused"
                        && r["control_epoch"] == input["control_epoch"],
                    "run_not_writable"
                )
            } else if !(r["phase"] == "reconciling"
                && r["pending_command"]["tool"] == name
                && r["pending_command"]["request_id"] == request
                && cmd["status"] == "pending")
            {
                self.writable(&r, input)?
            }
            Ok(None)
        };
        match check() {
            Ok(Some(cached)) => {
                if record {
                    event["outcome"] = json!("cached");
                    if let Err(error) = self.store.edit(id, |_| Ok(()), "tool.completed", event) {
                        tracing::warn!(run_id = id, tool = name, %error, "could not record cached tool result");
                    }
                }
                return Ok(cached);
            }
            Err(error) => {
                if record {
                    event["code"] = json!(error.to_string());
                    if let Err(write_error) = self.store.edit(id, |_| Ok(()), "tool.failed", event) {
                        tracing::warn!(run_id = id, tool = name, %write_error, "could not record rejected tool call");
                    }
                }
                return Err(error);
            }
            Ok(None) => {}
        }
        self.store
            .write_command(id, name, request, &cmd, "tool.started", event.clone())?;
        self.store.edit(
            id,
            |r| {
                r["last_active"] = json!(now());
                Ok(())
            },
            "",
            Value::Null,
        )?;
        let result = self.execute(p, name, input, &mut cmd).await;
        match result {
            Ok(v) => {
                cmd["status"] = json!("completed");
                cmd["result"] = v.clone();
                event["elapsed_seconds"] =
                    json!(now().saturating_sub(cmd["started_at"].as_u64().unwrap_or(now())));
                event["outcome"] = json!("accepted");
                if let Some(status) = v["action"]["status"]
                    .as_str()
                    .or_else(|| v["decision"]["status"].as_str())
                {
                    event["world_status"] = json!(status);
                }
                self.store
                    .write_command(id, name, request, &cmd, "tool.completed", event)?;
                Ok(v)
            }
            Err(e) => {
                let code = e.to_string();
                // A failed resume only reads World; it has no ambiguous World mutation.
                let uncertain = code == "outcome_unknown" && name != "box_resume_run";
                cmd["status"] = json!(if uncertain { "pending" } else { "failed" });
                cmd["error"] = json!(code);
                event["code"] = json!(code);
                event["retryable"] = json!(uncertain);
                self.store
                    .write_command(id, name, request, &cmd, "tool.failed", event)?;
                if uncertain {
                    self.store.edit(
                        id,
                        |r| {
                            if r["status"] == "running" {
                                if r["phase"] != "paused" {
                                    r["phase"] = json!("reconciling");
                                }
                                r["pending_command"] = json!({"tool":name,"request_id":request})
                            }
                            Ok(())
                        },
                        "run.reconciling",
                        json!({}),
                    )?;
                }
                if [
                    "world_session_lost",
                    "world_step_failed",
                    "journal_write_failed",
                ]
                .contains(&code.as_str())
                {
                    self.fail(id, &code)?;
                }
                Err(e)
            }
        }
    }
    async fn execute(
        &self,
        p: &Principal,
        name: &str,
        input: &Value,
        cmd: &mut Value,
    ) -> Result<Value> {
        let id = field(input, "run_id")?;
        let r = self.store.run(id)?;
        if r["phase"] == "reconciling" {
            ensure!(
                r["pending_command"]["tool"] == name
                    && r["pending_command"]["request_id"]
                        == input["request_id"]
                            .as_str()
                            .map(json_string)
                            .unwrap_or_else(|| input["action"]["requestId"].clone()),
                "run_reconciling"
            )
        }
        match name {
            "box_record_note" => Ok(json!({"recorded":true})),
            "box_resume_run" => {
                self.snapshot(&r).await?;
                let pending = self
                    .store
                    .pending(id)?
                    .into_iter()
                    .find(|c| c["tool"] != "box_resume_run");
                self.store.control_command(
                    id,
                    ControlCommand {
                        tool: name,
                        request: field(input, "request_id")?,
                        signature: &hash(&input.to_string()),
                        actor: &p.id,
                    },
                    |r| {
                        ensure!(
                            r["status"] == "running"
                                && r["phase"] == "paused"
                                && r["control_epoch"] == input["control_epoch"],
                            "run_not_writable"
                        );
                        ensure!(now() < r["deadline"].as_u64().unwrap(), "budget_exhausted");
                        if let Some(pending) = pending {
                            r["phase"] = json!("reconciling");
                            r["pending_command"] =
                                json!({"tool":pending["tool"],"request_id":pending["request_id"]});
                        } else {
                            r["phase"] = json!("waiting_for_agent");
                        }
                        r["last_active"] = json!(now());
                        r["control_epoch"] = json!(r["control_epoch"].as_u64().unwrap() + 1);
                        Ok(())
                    },
                    |r| self.summary(r),
                )
            }
            "box_assign_task" => {
                ensure!(p.operator || p.scopes["coordinator"] == true, "forbidden");
                let a = field(input, "agent_id")?;
                self.check_agent(p, &r, a)?;
                let token = self.credential(id, None).await?;
                let v=self.session_request(&r,"POST","/coordinator/decisions",&token,Some(json!({"requestId":input["request_id"],"expectedRevision":input["expected_revision"],"taskId":input["task_id"],"agentId":a,"observedTick":r["tick"]}))).await?;
                let s = self.snapshot(&r).await?;
                self.record_snapshot(id, &s)?;
                ensure!(
                    !matches!(
                        v["decision"]["status"].as_str(),
                        Some("rejected" | "failed")
                    ),
                    "decision_rejected"
                );
                Ok(json!({"run_id":id,"world_revision":s["revision"],"decision":v["decision"]}))
            }
            "box_submit_action" | "box_cancel_action" => {
                let a = field(input, "agent_id")?;
                self.check_agent(p, &r, a)?;
                let token = self.credential(id, Some(a)).await?;
                let (path, body) = if name == "box_submit_action" {
                    (format!("/agents/{a}/actions"), input["action"].clone())
                } else {
                    (
                        format!("/agents/{a}/actions/cancel"),
                        json!({"requestId":input["action_request_id"]}),
                    )
                };
                let v = self
                    .session_request(&r, "POST", &path, &token, Some(body))
                    .await?;
                let s = self.snapshot(&r).await?;
                self.record_snapshot(id, &s)?;
                Ok(json!({"run_id":id,"world_revision":s["revision"],"action":v["action"]}))
            }
            "box_advance" => self.advance(p, input, cmd).await,
            _ => bail!("unknown_tool"),
        }
    }
    async fn advance(&self, p: &Principal, input: &Value, cmd: &mut Value) -> Result<Value> {
        let id = field(input, "run_id")?;
        let request = field(input, "request_id")?;
        let r = self.store.run(id)?;
        let mut snapshot = self.snapshot(&r).await?;
        if cmd["next_revision"].is_null() {
            ensure!(
                snapshot["revision"] == input["expected_revision"],
                "revision_conflict"
            );
            cmd["next_revision"] = snapshot["revision"].clone();
            cmd["start_tick"] = snapshot["world"]["tick"].clone();
        }
        let mut reconciled = false;
        if snapshot["revision"] != cmd["next_revision"] {
            let step_id = hash(&format!("{}:{}", cmd["command_id"], cmd["steps"]));
            let receipt = self
                .session_request(
                    &r,
                    "GET",
                    &format!("/step-receipts/{step_id}"),
                    field(&r["session"], "admin_token")?,
                    None,
                )
                .await?;
            ensure!(
                receipt["expectedRevision"] == cmd["next_revision"]
                    && receipt["revision"] == snapshot["revision"],
                "revision_conflict"
            );
            cmd["steps"] =
                json!(cmd["steps"].as_u64().unwrap() + receipt["executed"].as_u64().unwrap_or(0));
            cmd["next_revision"] = receipt["revision"].clone();
            self.store
                .write_command(id, "box_advance", request, cmd, "", Value::Null)?;
            reconciled = true;
        }
        self.store.edit(
            id,
            |r| {
                if r["status"] == "running" && r["phase"] != "paused" {
                    r["phase"] = json!("advancing")
                }
                Ok(())
            },
            "run.advancing",
            json!({"tool":"box_advance","call_id":cmd["call_id"],"max_ticks":input["max_ticks"],"start_tick":cmd["start_tick"]}),
        )?;
        let start = std::time::Instant::now();
        let mut stop = "max_ticks";
        let already_finished = self.evaluate(id, &snapshot).await?;
        if already_finished {
            stop = "terminal";
        } else if reconciled {
            stop = "reconciled";
        }
        while !already_finished
            && !reconciled
            && cmd["steps"].as_u64().unwrap() < input["max_ticks"].as_u64().unwrap()
        {
            let r = self.store.run(id)?;
            if r["status"] != "running"
                || r["phase"] == "paused"
                || r["control_epoch"] != input["control_epoch"]
            {
                stop = "interrupted";
                break;
            }
            // Re-check credential revocation during a long call.
            ensure!(
                p.operator
                    || self
                        .store
                        .integrations()?
                        .iter()
                        .any(|(_, i)| i["id"] == p.id
                            && i["revoked"] != true
                            && i["expires_at"].as_u64().unwrap_or(0) > now()),
                "unauthorized"
            );
            if now() >= r["deadline"].as_u64().unwrap()
                || snapshot["world"]["tick"].as_u64().unwrap()
                    >= r["config"]["max_ticks"].as_u64().unwrap()
            {
                self.stop(id, "timeout", "budget_exhausted")?;
                stop = "budget_exhausted";
                break;
            }
            if start.elapsed() >= Duration::from_secs(2) {
                stop = "wall_budget";
                break;
            }
            self.store
                .write_command(id, "box_advance", request, cmd, "", Value::Null)?;
            let step_id = hash(&format!("{}:{}", cmd["command_id"], cmd["steps"]));
            let before = snapshot["world"]["events"].as_array().map_or(0, Vec::len);
            snapshot=self.session_request(&r,"POST","/step",field(&r["session"],"admin_token")?,Some(json!({"count":1,"requestId":step_id,"expectedRevision":cmd["next_revision"]}))).await?;
            cmd["steps"] =
                json!(cmd["steps"].as_u64().unwrap() + snapshot["executed"].as_u64().unwrap_or(0));
            cmd["next_revision"] = snapshot["revision"].clone();
            self.store
                .write_command(id, "box_advance", request, cmd, "", Value::Null)?;
            if self.evaluate(id, &snapshot).await? {
                stop = "terminal";
                break;
            }
            let selected = input["until"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![json!("task_finished"), json!("failure")]);
            let events = snapshot["world"]["events"]
                .as_array()
                .context("invalid_world_response")?;
            if events.iter().skip(before).any(|e| {
                let kind = e["kind"].as_str().unwrap_or("");
                selected.iter().any(|s| match s.as_str() {
                    Some("task_finished") => kind == "task_completed",
                    Some("action_finished") => {
                        e["actionStatus"] == "completed" || kind == "action_completed"
                    }
                    Some("failure") => e["type"] == "warning",
                    _ => false,
                })
            }) {
                stop = "event";
                break;
            }
            if snapshot["executed"] == 0 {
                stop = "terminal";
                break;
            }
            tokio::time::sleep(Duration::from_millis(
                50 / r["config"]["speed"].as_u64().unwrap_or(5),
            ))
            .await;
        }
        let latest = self.store.run(id)?;
        if latest["status"] == "running"
            && snapshot["world"]["tick"].as_u64().unwrap_or(0)
                >= latest["config"]["max_ticks"].as_u64().unwrap()
        {
            self.stop(id, "timeout", "tick_budget_exhausted")?;
            stop = "budget_exhausted";
        }
        self.store.edit(
            id,
            |r| {
                if r["status"] == "running" && r["phase"] == "advancing" {
                    r["phase"] = json!("waiting_for_agent");
                    r.as_object_mut().unwrap().remove("pending_command");
                }
                Ok(())
            },
            "run.advance_finished",
            json!({"tool":"box_advance","call_id":cmd["call_id"],"stop_reason":stop,"steps":cmd["steps"],"max_ticks":input["max_ticks"]}),
        )?;
        Ok(
            json!({"run":self.summary(&self.store.run(id)?),"world_revision":snapshot["revision"],"start_tick":cmd["start_tick"],"end_tick":snapshot["world"]["tick"],"executed":cmd["steps"],"stop_reason":stop}),
        )
    }
    fn stop(&self, id: &str, outcome: &str, reason: &str) -> Result<()> {
        self.store.edit(
            id,
            |r| {
                if !terminal(r) && r["status"] != "stopping" {
                    r["status"] = json!("stopping");
                    r["phase"] = json!("archiving");
                    r["outcome"] = json!(outcome);
                    r["reason"] = json!(reason);
                    r["control_epoch"] = json!(r["control_epoch"].as_u64().unwrap() + 1);
                }
                Ok(())
            },
            "run.stopping",
            json!({"reason":reason}),
        )?;
        Ok(())
    }
    fn fail(&self, id: &str, reason: &str) -> Result<()> {
        self.stop(id, "failed", reason)
    }
    async fn archive_frames(
        &self,
        run: &Value,
        through: i64,
        persisted: bool,
        byte_limit: usize,
    ) -> Result<(i64, Vec<Value>)> {
        let session = field(&run["session"], "id")?;
        let token = field(&run["session"], "admin_token")?;
        let root = if persisted {
            format!("/event-journals/{session}/replay")
        } else {
            format!("/sessions/{session}/history")
        };
        let mut after = -1;
        let mut first = None;
        let mut frames = Vec::new();
        let mut bytes = 0;
        loop {
            let camera = if persisted { "&camera=0" } else { "" };
            let route = format!("{root}?after={after}&through={through}&limit=64{camera}");
            let page = self.world("GET", &route, Some(token), None).await?;
            ensure!(page["sessionId"] == session, "invalid_world_history");
            let rows = page["frames"].as_array().context("invalid_world_history")?;
            ensure!(!rows.is_empty(), "invalid_world_history");
            for row in rows {
                let revision = row["revision"].as_i64().context("invalid_world_history")?;
                if first.is_some() || persisted || page["truncated"] != true {
                    ensure!(revision == after + 1, "invalid_world_history");
                }
                ensure!(
                    revision >= 0 && revision <= through,
                    "invalid_world_history"
                );
                first.get_or_insert(revision);
                after = revision;
                let mut world = row["world"].clone();
                ensure!(world.is_object(), "invalid_world_history");
                if row["cameraFrames"].is_object() {
                    world["cameraFrames"] = row["cameraFrames"].clone();
                }
                bytes += serde_json::to_vec(&world)?.len() + 1;
                ensure!(
                    bytes <= byte_limit && frames.len() < MAX_ARCHIVE_FRAMES,
                    "archive_too_large"
                );
                frames.push(world);
            }
            if after == through {
                break;
            }
            ensure!(page["nextAfter"] == after, "invalid_world_history");
        }
        Ok((first.context("invalid_world_history")?, frames))
    }
    async fn archive(&self, id: &str, run: &Value) -> Result<String> {
        let snapshot = self.snapshot(run).await?;
        let through = snapshot["revision"]
            .as_i64()
            .context("invalid_world_history")?;
        let world = &snapshot["world"];
        let mut report = json!({
            "format":"3dbox-prototype-v1", "source":"server", "recordingContext":run["recording_context"],
            "config":{"seed":run["config"]["seed"],"policy":world["policy"],"sceneId":run["scene_id"],"scene":scene()},
            "metrics":snapshot["metrics"], "events":world["events"],
            "coverage":{"start":"partial", "end":if world["done"] == true {"finished"} else {"unfinished"},"revisionRange":[through,through]},
            "frames":[]
        });
        let byte_limit = MAX_ARCHIVE_BYTES.saturating_sub(serde_json::to_vec(&report)?.len());
        let persisted = snapshot["journal"]["snapshots"] == true
            && snapshot["journal"]["healthy"] == true
            && through < MAX_ARCHIVE_FRAMES as i64;
        let (first, frames) = match self
            .archive_frames(run, through, persisted, byte_limit)
            .await
        {
            Err(error) if persisted => {
                tracing::warn!(run_id = id, %error, "Full replay unavailable; using retained history");
                self.archive_frames(run, through, false, byte_limit).await?
            }
            result => result?,
        };
        if first == 0 {
            report["coverage"]["start"] = json!("complete");
        }
        report["coverage"]["revisionRange"][0] = json!(first);
        report["frames"] = Value::Array(frames);
        let bytes = serde_json::to_vec(&report)?;
        ensure!(bytes.len() <= MAX_ARCHIVE_BYTES, "archive_too_large");
        let digest = hash(std::str::from_utf8(&bytes)?);
        let path = self.data_dir.join(format!("task-{id}.json"));
        tokio::task::spawn_blocking(move || crate::run_store::write_artifact(&path, &bytes))
            .await??;
        Ok(digest)
    }
    async fn finalize(&self, id: &str) -> Result<()> {
        let r = self.store.run(id)?;
        if r["status"] != "stopping" {
            return Ok(());
        }
        for pending in self.store.pending(id)? {
            let mut command = pending["command"].clone();
            command["status"] = json!("failed");
            command["error"] = json!("run_ended_before_confirmation");
            self.store.write_command(
                id,
                field(&pending, "tool")?,
                field(&pending, "request_id")?,
                &command,
                "tool.failed",
                json!({"code":"run_ended_before_confirmation","request_id":pending["request_id"]}),
            )?;
        }
        if r["session"]["id"].is_string() {
            if r["archive_status"] == "pending" {
                let archive = self.archive(id, &r).await;
                self.store.edit(
                    id,
                    |r| {
                        match archive {
                            Ok(digest) => {
                                r["archive_status"] = json!("ready");
                                r["artifact_sha256"] = json!(digest)
                            }
                            Err(e) => {
                                r["archive_status"] = json!("failed");
                                r["archive_error"] = json!(e.to_string());
                            }
                        }
                        Ok(())
                    },
                    "run.archived",
                    json!({}),
                )?;
            }
            // Only delete after the artifact has been attempted; retry closure if unavailable.
            self.session_request(&r, "DELETE", "", field(&r["session"], "admin_token")?, None)
                .await
                .or_else(|e| {
                    if e.to_string() == "world_session_lost" {
                        Ok(Value::Null)
                    } else {
                        Err(e)
                    }
                })?;
        }
        self.store.edit(
            id,
            |r| {
                r["status"] = r["outcome"].clone();
                r["phase"] = json!("finished");
                if r["archive_status"] == "pending" {
                    r["archive_status"] = json!("unavailable");
                }
                r["finished_at"] = json!(now());
                r.as_object_mut().unwrap().remove("session");
                r["credentials"] = json!({});
                Ok(())
            },
            "run.finished",
            json!({}),
        )?;
        Ok(())
    }
    pub async fn recover(&self) -> Result<()> {
        for r in self.store.active_runs()? {
            if r["status"] == "starting" {
                let id = field(&r, "run_id")?;
                if let Err(error) = self.setup(id).await {
                    let code = error.to_string();
                    if code != "outcome_unknown" {
                        self.fail(id, &code)?;
                    }
                }
                continue;
            }
            if r["status"] != "running" {
                continue;
            }
            let id = field(&r, "run_id")?;
            match self.snapshot(&r).await {
                Ok(snapshot) => {
                    self.record_snapshot(id, &snapshot)?;
                    let pending = self.store.pending(id)?;
                    if let Some(c) = pending.first() {
                        self.store.edit(
                            id,
                            |r| {
                                if r["phase"] != "paused" {
                                    r["phase"] = json!("reconciling");
                                    r["pending_command"] =
                                        json!({"tool":c["tool"],"request_id":c["request_id"]});
                                }
                                Ok(())
                            },
                            "run.recovered",
                            json!({"pending":true}),
                        )?;
                    } else {
                        self.evaluate(id, &snapshot).await?;
                    }
                }
                Err(e) if e.to_string() == "world_session_lost" => {
                    self.fail(id, "world_session_lost")?
                }
                Err(_) => {
                    let pending = self.store.pending(id)?;
                    self.store.edit(
                        id,
                        |r| {
                            if let Some(command) = pending.first() {
                                r["phase"] = json!("reconciling");
                                r["pending_command"] = json!({"tool":command["tool"],"request_id":command["request_id"]});
                            } else {
                                r["phase"] = json!("paused");
                                r["control_epoch"] = json!(r["control_epoch"].as_u64().unwrap() + 1);
                            }
                            Ok(())
                        },
                        "run.recovery_unavailable",
                        json!({}),
                    )?;
                }
            }
        }
        Ok(())
    }
    pub fn start_sweeper(&self) {
        let svc = self.clone();
        tokio::spawn(async move {
            let mut last_probe = BTreeMap::<String, u64>::new();
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Ok(runs) = svc.store.active_runs() else {
                    continue;
                };
                last_probe.retain(|id, _| runs.iter().any(|r| r["run_id"] == id.as_str()));
                svc.locks
                    .lock()
                    .unwrap()
                    .retain(|_, lock| Arc::strong_count(lock) > 1);
                for r in runs {
                    let Some(id) = r["run_id"].as_str() else {
                        continue;
                    };
                    if terminal(&r) {
                        continue;
                    }
                    if now() >= r["deadline"].as_u64().unwrap_or(0) {
                        let _ = svc.stop(id, "timeout", "wall_budget_exhausted");
                    } else if r["status"] == "running"
                        && r["phase"] == "waiting_for_agent"
                        && now().saturating_sub(r["last_active"].as_u64().unwrap_or(now()))
                            >= r["config"]["idle_timeout_seconds"].as_u64().unwrap_or(300)
                    {
                        let _ = svc.store.edit(
                            id,
                            |r| {
                                r["phase"] = json!("paused");
                                r["control_epoch"] =
                                    json!(r["control_epoch"].as_u64().unwrap() + 1);
                                Ok(())
                            },
                            "run.idle_paused",
                            json!({}),
                        );
                    }
                    let Ok(_guard) = svc.lock(id).try_lock_owned() else {
                        continue;
                    };
                    let Ok(latest) = svc.store.run(id) else {
                        continue;
                    };
                    if latest["status"] == "running"
                        && now().saturating_sub(*last_probe.get(id).unwrap_or(&0)) >= 5
                    {
                        last_probe.insert(id.into(), now());
                        // Read-only health checks never renew the external controller's idle budget.
                        match svc.snapshot(&latest).await {
                            Ok(snapshot) if snapshot["revision"] != latest["world_revision"] => {
                                let _ = svc.evaluate(id, &snapshot).await;
                            }
                            Err(e) if e.to_string() == "world_session_lost" => {
                                let _ = svc.fail(id, "world_session_lost");
                            }
                            _ => {}
                        }
                    }
                    let Ok(latest) = svc.store.run(id) else {
                        continue;
                    };
                    if latest["status"] == "stopping" {
                        if let Err(e) = svc.finalize(id).await {
                            tracing::warn!(run_id=id,error=%e,"task run finalization deferred")
                        }
                    }
                }
            }
        });
    }
    pub async fn observer(&self, p: &Principal, id: &str) -> Result<Value> {
        ensure!(p.operator, "forbidden");
        let r = self.authorized(p, id)?;
        ensure!(!terminal(&r), "run_not_writable");
        Ok(
            json!({"format":"3dbox-observer-access-v1","sessionId":r["session"]["id"],"observerToken":r["session"]["observer_token"]}),
        )
    }
    pub fn report(&self, p: &Principal, id: &str) -> Result<Value> {
        ensure!(p.operator, "forbidden");
        self.authorized(p, id)?;
        let r = self.store.run(id)?;
        ensure!(r["archive_status"] == "ready", "replay_unavailable");
        Ok(serde_json::from_slice(&std::fs::read(
            self.data_dir.join(format!("task-{id}.json")),
        )?)?)
    }
    pub fn integrations(&self, p: &Principal) -> Result<Value> {
        ensure!(p.operator, "forbidden");
        Ok(
            json!({"integrations":self.store.integrations()?.into_iter().map(|(_,v)|v).collect::<Vec<_>>()}),
        )
    }
    pub fn enroll(&self, p: &Principal, input: Value) -> Result<Value> {
        ensure!(p.operator, "forbidden");
        let label = field(&input, "label")?;
        ensure!(
            !label.trim().is_empty() && label.len() <= 100,
            "invalid_label"
        );
        ensure!(
            input.as_object().is_some_and(|m| m.keys().all(|k| [
                "label",
                "max_concurrency",
                "max_wall_seconds"
            ]
            .contains(&k.as_str()))),
            "invalid_arguments"
        );
        ensure!(self.store.integrations()?.len() < 64, "integration_limit");
        let max = input
            .get("max_concurrency")
            .map(|v| v.as_u64().context("invalid_limits"))
            .transpose()?
            .unwrap_or(2);
        let wall = input
            .get("max_wall_seconds")
            .map(|v| v.as_u64().context("invalid_limits"))
            .transpose()?
            .unwrap_or(1800);
        ensure!(
            (1..=4).contains(&max) && (60..=7200).contains(&wall),
            "invalid_limits"
        );
        let id = Uuid::new_v4().to_string();
        let token = secret();
        let b = json!({"id":id,"label":label,"scenes":["industrial-park-v2"],"roles":["drone","vehicle","robot"],"coordinator":true,"max_concurrency":max,"max_wall_seconds":wall,"expires_at":now()+30*86400,"revoked":false});
        self.store.put_integration(&id, &hash(&token), &b)?;
        Ok(json!({"integration":b,"token":token,"mcp_url":"/control/mcp/control"}))
    }
    pub fn revoke(&self, p: &Principal, id: &str) -> Result<Value> {
        ensure!(p.operator, "forbidden");
        let (h, mut b) = self
            .store
            .integrations()?
            .into_iter()
            .find(|(_, b)| b["id"] == id)
            .context("integration_not_found")?;
        b["revoked"] = json!(true);
        self.store.put_integration(id, &h, &b)?;
        for r in self.store.active_runs()? {
            if r["owner_id"] == id && !terminal(&r) {
                self.stop(field(&r, "run_id")?, "cancelled", "integration_revoked")?
            }
        }
        Ok(json!({"revoked":true}))
    }
}
fn field_str<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    field(v, k)
}
fn json_string(s: &str) -> Value {
    json!(s)
}

pub struct ApiError(pub anyhow::Error);
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self(e)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let code = self.0.to_string();
        let status = match code.as_str() {
            "unauthorized" => StatusCode::UNAUTHORIZED,
            "rate_limited" => StatusCode::TOO_MANY_REQUESTS,
            "forbidden" | "integration_token_required" => StatusCode::FORBIDDEN,
            "run_not_found" | "integration_not_found" => StatusCode::NOT_FOUND,
            "outcome_unknown" | "world_session_lost" => StatusCode::BAD_GATEWAY,
            _ => StatusCode::CONFLICT,
        };
        (
            status,
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({"error":code,"code":code,"retryable":code=="outcome_unknown"})),
        )
            .into_response()
    }
}
type ApiResult = std::result::Result<Json<Value>, ApiError>;
fn principal(s: &RunService, h: &HeaderMap) -> Result<Principal> {
    s.authenticate(bearer(h).context("unauthorized")?)
}
pub async fn auth(State(s): State<RunService>, req: Request<Body>, next: Next) -> Response {
    if let Err(e) = principal(&s, req.headers()) {
        return ApiError(e).into_response();
    }
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let target = reqwest::Url::parse(&format!("http://{host}"));
    let valid_host = target.as_ref().ok().is_some_and(|u| {
        let name = u.host_str().unwrap_or("").trim_matches(['[', ']']);
        !host.is_empty()
            && !host
                .chars()
                .any(|c| c.is_whitespace() || "\\/?#@%,".contains(c))
            && u.username().is_empty()
            && u.password().is_none()
            && u.path() == "/"
            && (name == "localhost"
                || name.parse::<std::net::IpAddr>().is_ok()
                || env::var("BOX_ALLOWED_HOSTS")
                    .unwrap_or_default()
                    .split(',')
                    .any(|s| s.trim().eq_ignore_ascii_case(name)))
    });
    if !valid_host {
        return ApiError(anyhow!("forbidden")).into_response();
    }
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let valid = origin
            .to_str()
            .ok()
            .and_then(|s| reqwest::Url::parse(s).ok().map(|u| (s, u)))
            .is_some_and(|(raw, u)| {
                matches!(u.scheme(), "http" | "https")
                    && u.origin().ascii_serialization() == raw
                    && reqwest::Url::parse(&format!("{}://{host}", u.scheme()))
                        .is_ok_and(|target| u.origin() == target.origin())
            });
        if !valid {
            return ApiError(anyhow!("forbidden")).into_response();
        }
    }
    next.run(req).await
}
pub fn router<S: Clone + Send + Sync + 'static>(svc: RunService) -> Router<S> {
    Router::new()
        .route("/runs/v1/capabilities", get(capabilities))
        .route("/runs/v1/integrations", get(integrations).post(enroll))
        .route("/runs/v1/integrations/{id}", axum::routing::delete(revoke))
        .route("/runs/v1/runs", get(list).post(create))
        .route("/runs/v1/runs/{id}", get(get_run))
        .route("/runs/v1/runs/{id}/commands/{command}", post(command))
        .route("/runs/v1/runs/{id}/observations", get(observe))
        .route("/runs/v1/runs/{id}/observer", post(observer))
        .route("/runs/v1/runs/{id}/events", get(events))
        .route("/runs/v1/runs/{id}/events/stream", get(stream))
        .route("/runs/v1/runs/{id}/result", get(get_run))
        .route("/runs/v1/runs/{id}/report", get(report))
        .route("/runs/v1/tools/{tool}", post(tool_call))
        .layer(DefaultBodyLimit::max(16384))
        .layer(middleware::from_fn_with_state(svc.clone(), auth))
        .with_state(svc)
}
async fn capabilities(State(s): State<RunService>, h: HeaderMap) -> ApiResult {
    Ok(Json(s.capabilities(&principal(&s, &h)?)))
}
async fn integrations(State(s): State<RunService>, h: HeaderMap) -> ApiResult {
    Ok(Json(s.integrations(&principal(&s, &h)?)?))
}
async fn enroll(State(s): State<RunService>, h: HeaderMap, Json(v): Json<Value>) -> ApiResult {
    Ok(Json(s.enroll(&principal(&s, &h)?, v)?))
}
async fn revoke(State(s): State<RunService>, Path(id): Path<String>, h: HeaderMap) -> ApiResult {
    Ok(Json(s.revoke(&principal(&s, &h)?, &id)?))
}
async fn list(State(s): State<RunService>, h: HeaderMap) -> ApiResult {
    Ok(Json(s.list(&principal(&s, &h)?)?))
}
async fn create(State(s): State<RunService>, h: HeaderMap, Json(v): Json<Value>) -> ApiResult {
    Ok(Json(
        s.call(&principal(&s, &h)?, "box_create_run", v).await?,
    ))
}
async fn get_run(State(s): State<RunService>, Path(id): Path<String>, h: HeaderMap) -> ApiResult {
    Ok(Json(
        s.call(&principal(&s, &h)?, "box_get_run", json!({"run_id":id}))
            .await?,
    ))
}
async fn command(
    State(s): State<RunService>,
    Path((id, c)): Path<(String, String)>,
    h: HeaderMap,
    Json(mut v): Json<Value>,
) -> ApiResult {
    ensure_object(&v)?;
    v["run_id"] = json!(id);
    Ok(Json(
        s.call(&principal(&s, &h)?, &format!("box_{c}"), v).await?,
    ))
}
async fn tool_call(
    State(s): State<RunService>,
    Path(name): Path<String>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> ApiResult {
    Ok(Json(s.call(&principal(&s, &h)?, &name, v).await?))
}
fn ensure_object(v: &Value) -> Result<()> {
    ensure!(v.is_object(), "invalid_arguments");
    Ok(())
}
#[derive(Deserialize)]
struct ObservationQuery {
    view: String,
    agent_id: Option<String>,
}
async fn observe(
    State(s): State<RunService>,
    Path(id): Path<String>,
    h: HeaderMap,
    Query(q): Query<ObservationQuery>,
) -> ApiResult {
    let mut v = json!({"run_id":id,"view":q.view});
    if let Some(a) = q.agent_id {
        v["agent_id"] = json!(a)
    }
    Ok(Json(s.call(&principal(&s, &h)?, "box_observe", v).await?))
}
async fn observer(State(s): State<RunService>, Path(id): Path<String>, h: HeaderMap) -> ApiResult {
    Ok(Json(s.observer(&principal(&s, &h)?, &id).await?))
}
async fn report(State(s): State<RunService>, Path(id): Path<String>, h: HeaderMap) -> ApiResult {
    Ok(Json(s.report(&principal(&s, &h)?, &id)?))
}
#[derive(Deserialize)]
struct EventQuery {
    #[serde(default)]
    after: u64,
    limit: Option<u64>,
}
async fn events(
    State(s): State<RunService>,
    Path(id): Path<String>,
    h: HeaderMap,
    Query(q): Query<EventQuery>,
) -> ApiResult {
    Ok(Json(
        s.call(
            &principal(&s, &h)?,
            "box_get_events",
            json!({"run_id":id,"after_seq":q.after,"limit":q.limit.unwrap_or(100)}),
        )
        .await?,
    ))
}
async fn stream(
    State(s): State<RunService>,
    Path(id): Path<String>,
    h: HeaderMap,
    Query(q): Query<EventQuery>,
) -> std::result::Result<Response, ApiError> {
    let p = principal(&s, &h)?;
    s.authorized(&p, &id)?;
    let token = bearer(&h).unwrap().to_string();
    let permit = s
        .streams
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(anyhow!("rate_limited")))?;
    let events = async_stream::stream! {let _permit=permit;let mut cursor=q.after;loop{if s.authenticate(&token).is_err(){break}let batch=match s.store.events(&id,cursor,100){Ok(v)=>v,Err(_)=>break};for mut e in batch{cursor=e["seq"].as_u64().unwrap();if !p.operator&&e["kind"]=="world.updated"{e["payload"]=json!({"scope":"console_only"})}yield Ok::<_,std::convert::Infallible>(Event::default().id(cursor.to_string()).event("run").data(e.to_string()));}tokio::time::sleep(Duration::from_millis(200)).await;}};
    let mut response = Sse::new(events)
        .keep_alive(KeepAlive::default().interval(Duration::from_secs(10)))
        .into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(response)
}
