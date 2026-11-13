use std::{
    collections::BTreeMap,
    env,
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path as FilePath, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{bearer_token, http_error};

const VERSION: u8 = 1;
const LEASE_SECONDS: u64 = 15;
const MAX_ARCHIVE_FAILURES: u8 = 5;
const RUNNER_ONLINE_SECONDS: u64 = 12;
const RECENT_RUNS: usize = 128;
const MAX_RUNNERS: usize = 32;
const SCENES: [&str; 13] = [
    "industrial-park-v2",
    "industrial-park-v1",
    "industrial-park-parallel-v1",
    "lunar-base-v1",
    "lunar-terrain-v1",
    "lunar-sampling-v1",
    "lunar-outpost-v1",
    "shore-coordination-v1",
    "shore-surface-v1",
    "shore-sea-state-v1",
    "shore-echelons-v1",
    "shore-rescue-v1",
    "industrial-park-fixed-sensor-v1",
];

type Result<T> = std::result::Result<T, ApiError>;

#[derive(Debug)]
struct ApiError(StatusCode, &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        http_error(self.0, self.1)
    }
}

fn invalid(code: &'static str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, code)
}

fn unauthorized() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "runner_unauthorized")
}

fn conflict(code: &'static str) -> ApiError {
    ApiError(StatusCode::CONFLICT, code)
}

fn storage_error(error: std::io::Error) -> ApiError {
    tracing::error!(%error, "runner state storage failed");
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "runner_storage_failed")
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn digest(token: &str) -> String {
    hex_digest(token.as_bytes())
}

fn hex_digest(value: &[u8]) -> String {
    use std::fmt::Write;
    let mut encoded = String::with_capacity(64);
    for byte in Sha256::digest(value) {
        write!(&mut encoded, "{byte:02x}").unwrap();
    }
    encoded
}

fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn matches_digest(token: &str, expected: &str) -> bool {
    bool::from(digest(token).as_bytes().ct_eq(expected.as_bytes()))
}

fn valid_id(value: &str) -> bool {
    (1..=48).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    scene_id: String,
    seed: u32,
    physics: String,
    coordinators: u8,
    fault: String,
    max_ticks: u32,
    timeout_seconds: u32,
    strategy: String,
}

impl Config {
    fn validate(&self, capabilities: &Capabilities) -> Result<()> {
        if !capabilities.scenes.contains(&self.scene_id)
            || !capabilities.physics.contains(&self.physics)
            || !capabilities.faults.contains(&self.fault)
            || !capabilities.strategies.contains(&self.strategy)
            || !(1..=capabilities.max_coordinators).contains(&self.coordinators)
            || !(1..=10_000).contains(&self.max_ticks)
            || !(2..=300).contains(&self.timeout_seconds)
        {
            return Err(invalid("runner_unsupported_config"));
        }
        Ok(())
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capabilities {
    scenes: Vec<String>,
    physics: Vec<String>,
    faults: Vec<String>,
    strategies: Vec<String>,
    max_coordinators: u8,
    concurrency: u8,
}

impl Capabilities {
    fn validate(&self) -> Result<()> {
        if self.scenes.is_empty()
            || self.scenes.len() > SCENES.len()
            || self.scenes.iter().any(|v| !SCENES.contains(&v.as_str()))
            || self.physics.is_empty()
            || self.physics.len() > 2
            || self
                .physics
                .iter()
                .any(|v| !["kinematic", "rapier"].contains(&v.as_str()))
            || !self.faults.iter().any(|v| v == "none")
            || self.faults.len() > 4
            || self
                .faults
                .iter()
                .any(|v| !["none", "transport", "recoverable", "resident"].contains(&v.as_str()))
            || self.strategies.is_empty()
            || self.strategies.len() > 16
            || self.strategies.iter().any(|v| !valid_id(v))
            || !(1..=4).contains(&self.max_coordinators)
            || !(1..=4).contains(&self.concurrency)
        {
            return Err(invalid("runner_invalid_capabilities"));
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Runner {
    label: String,
    token_hash: String,
    capabilities: Option<Capabilities>,
    last_seen: u64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Status {
    Queued,
    Starting,
    Running,
    Stopping,
    Completed,
    Cancelled,
    Failed,
    Timeout,
}

impl Status {
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Cancelled | Self::Failed | Self::Timeout
        )
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct WorldSession {
    id: Uuid,
    admin_token: String,
    observer_token: Option<String>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    tick: u64,
    completed_tasks: usize,
    total_tasks: usize,
}

#[derive(Clone, Serialize, Deserialize)]
struct Run {
    id: Uuid,
    request_id: Uuid,
    runner_id: String,
    config: Config,
    status: Status,
    reason: Option<String>,
    created_at: u64,
    deadline: u64,
    lease_hash: Option<String>,
    lease_until: u64,
    session: Option<WorldSession>,
    outcome: Option<Status>,
    progress: Option<Progress>,
    report_id: Option<String>,
    archived: bool,
    #[serde(default)]
    archive_failures: u8,
    #[serde(default)]
    replay_error: Option<String>,
    credentials: BTreeMap<String, ScopedCredential>,
}

impl Run {
    fn summary(&self) -> Value {
        json!({
            "runId": self.id,
            "runnerId": self.runner_id,
            "config": self.config,
            "status": self.status,
            "reason": self.reason,
            "createdAt": self.created_at,
            "progress": self.progress,
            "canObserve": self.status == Status::Running &&
                self.session.as_ref().is_some_and(|session| session.observer_token.is_some()),
            "hasReplay": self.archived,
            "replayError": self.replay_error,
        })
    }

    fn stop(&mut self, outcome: Status, reason: Option<String>) {
        self.outcome = Some(outcome);
        self.reason = reason;
        self.lease_hash = None;
        self.status = Status::Stopping;
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Database {
    runners: BTreeMap<String, Runner>,
    runs: BTreeMap<Uuid, Run>,
}

struct Storage {
    path: PathBuf,
    db: Database,
}

impl Storage {
    fn open(path: PathBuf) -> anyhow::Result<Self> {
        fs::create_dir_all(&path)?;
        let db = match fs::read(path.join("runner-state.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("decode runner state")?,
            Err(error) if error.kind() == ErrorKind::NotFound => Database::default(),
            Err(error) => return Err(error.into()),
        };
        Ok(Self { path, db })
    }

    fn update<T>(&mut self, edit: impl FnOnce(&mut Database) -> Result<T>) -> Result<T> {
        let mut next = self.db.clone();
        let result = edit(&mut next)?;
        let bytes = serde_json::to_vec(&next).expect("serializable runner state");
        atomic_write(&self.path.join("runner-state.json"), &bytes).map_err(storage_error)?;
        self.db = next;
        Ok(result)
    }

    fn report(&self, id: Uuid) -> PathBuf {
        self.path.join(format!("{id}.json"))
    }
}

fn atomic_write(path: &FilePath, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
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
        File::open(path.parent().expect("runner file parent"))?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[derive(Clone)]
struct Broker {
    store: Arc<Mutex<Storage>>,
    world: Arc<str>,
    client: Client,
    operator_hash: Option<Arc<str>>,
    operations: Arc<std::sync::Mutex<BTreeMap<Uuid, Arc<Mutex<()>>>>>,
}

pub(crate) fn router<S: Clone + Send + Sync + 'static>(
    client: Client,
    world: Arc<str>,
) -> anyhow::Result<Router<S>> {
    let Some(path) = env::var_os("BOX_RUNNER_DATA_DIR").filter(|path| !path.is_empty()) else {
        return Ok(Router::new());
    };
    let operator_hash = env::var("BOX_RUNNER_OPERATOR_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
        .map(|token| Arc::from(digest(&token)));
    let path = PathBuf::from(path);
    fs::create_dir_all(&path)?;
    #[cfg(unix)]
    if env::var_os("BOX_RUNNER_BOOTSTRAP_FILE").is_some() {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    }
    let mut store = Storage::open(path).context("open runner data directory")?;
    let bootstrap = match env::var_os("BOX_RUNNER_BOOTSTRAP_FILE") {
        Some(path) => {
            let path = PathBuf::from(path);
            let token = match fs::read_to_string(&path) {
                Ok(token) => token.trim().to_owned(),
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    let token = secret();
                    atomic_write(&path, token.as_bytes())
                        .context("write built-in runner credential")?;
                    token
                }
                Err(error) => return Err(error.into()),
            };
            anyhow::ensure!(token.len() >= 32, "invalid built-in runner credential");
            Some(token)
        }
        None => env::var("BOX_RUNNER_BOOTSTRAP_TOKEN")
            .ok()
            .filter(|token| !token.trim().is_empty()),
    };
    if let Some(token) = bootstrap {
        store
            .update(|db| {
                db.runners
                    .entry("builtin".into())
                    .and_modify(|runner| {
                        let token_hash = digest(&token);
                        if runner.token_hash != token_hash {
                            runner.token_hash = token_hash;
                            runner.last_seen = 0;
                        }
                    })
                    .or_insert_with(|| Runner {
                        label: "内置 Runner".into(),
                        token_hash: digest(&token),
                        capabilities: None,
                        last_seen: 0,
                    });
                Ok(())
            })
            .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    }
    let broker = Broker {
        store: Arc::new(Mutex::new(store)),
        world,
        client,
        operator_hash,
        operations: Default::default(),
    };
    let sweep = broker.clone();
    tokio::spawn(async move { sweep.sweep().await });
    Ok(Router::new()
        .route("/runners/v1/runners", get(list_runners).post(create_runner))
        .route(
            "/runners/v1/runners/{runner_id}",
            axum::routing::delete(revoke_runner),
        )
        .route("/runners/v1/runners/{runner_id}/register", post(register))
        .route("/runners/v1/runners/{runner_id}/claim", post(claim))
        .route("/runners/v1/runs", get(list_runs).post(create_run))
        .route("/runners/v1/runs/{run_id}", get(get_run))
        .route("/runners/v1/runs/{run_id}/cancel", post(cancel))
        .route("/runners/v1/runs/{run_id}/observer", post(observer))
        .route("/runners/v1/runs/{run_id}/report", get(report))
        .route("/runners/v1/runs/{run_id}/heartbeat", post(heartbeat))
        .route("/runners/v1/runs/{run_id}/finish", post(finish))
        .route("/runners/v1/runs/{run_id}/session", post(session))
        .route(
            "/runners/v1/runs/{run_id}/world/{*route}",
            axum::routing::any(world_request),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(broker))
}

impl Broker {
    fn operator(&self, headers: &HeaderMap) -> Result<()> {
        if self.operator_hash.as_ref().is_some_and(|hash| {
            !bearer_token(headers).is_some_and(|token| matches_digest(token, hash))
        }) {
            return Err(unauthorized());
        }
        Ok(())
    }

    async fn world(
        &self,
        method: Method,
        route: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .client
            .request(method, format!("{}{route}", self.world))
            .timeout(Duration::from_secs(35));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        request
            .send()
            .await
            .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "world_unreachable"))
    }
}

fn runner_auth(db: &Database, id: &str, headers: &HeaderMap) -> Result<()> {
    let token = bearer_token(headers).ok_or_else(unauthorized)?;
    if !db
        .runners
        .get(id)
        .is_some_and(|runner| matches_digest(token, &runner.token_hash))
    {
        return Err(unauthorized());
    }
    Ok(())
}

fn leased<'a>(db: &'a Database, id: Uuid, headers: &HeaderMap) -> Result<&'a Run> {
    let run = db.runs.get(&id).ok_or_else(unauthorized)?;
    let token = bearer_token(headers).ok_or_else(unauthorized)?;
    if !run
        .lease_hash
        .as_ref()
        .is_some_and(|hash| matches_digest(token, hash))
        || now() >= run.lease_until
        || now() >= run.deadline
    {
        return Err(conflict("runner_lease_inactive"));
    }
    Ok(run)
}

fn find_run(db: &Database, id: Uuid) -> Result<&Run> {
    db.runs
        .get(&id)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "runner_run_not_found"))
}

async fn list_runners(State(broker): State<Broker>, headers: HeaderMap) -> Result<Json<Value>> {
    broker.operator(&headers)?;
    let store = broker.store.lock().await;
    let runners: Vec<_> = store
        .db
        .runners
        .iter()
        .map(|(id, runner)| {
            json!({
                "runnerId": id, "label": runner.label, "capabilities": runner.capabilities,
                "online": runner.last_seen.saturating_add(RUNNER_ONLINE_SECONDS) > now(),
            })
        })
        .collect();
    Ok(Json(
        json!({"protocolVersion": VERSION, "runners": runners}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateRunner {
    label: String,
}

async fn create_runner(
    State(broker): State<Broker>,
    headers: HeaderMap,
    Json(input): Json<CreateRunner>,
) -> Result<(StatusCode, Json<Value>)> {
    broker.operator(&headers)?;
    if broker.operator_hash.is_none() {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "runner_operator_token_required",
        ));
    }
    let label = input.label.trim();
    if label.is_empty() || label.chars().count() > 60 || label.chars().any(char::is_control) {
        return Err(invalid("runner_invalid_label"));
    }
    let id = Uuid::new_v4().simple().to_string();
    let token = secret();
    broker.store.lock().await.update(|db| {
        if db.runners.len() >= MAX_RUNNERS {
            return Err(conflict("runner_registry_full"));
        }
        db.runners.insert(
            id.clone(),
            Runner {
                label: label.to_owned(),
                token_hash: digest(&token),
                capabilities: None,
                last_seen: 0,
            },
        );
        Ok(())
    })?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"runnerId": id, "runnerToken": token})),
    ))
}

async fn revoke_runner(
    State(broker): State<Broker>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    broker.operator(&headers)?;
    if broker.operator_hash.is_none() {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "runner_operator_token_required",
        ));
    }
    if id == "builtin" {
        return Err(conflict("runner_builtin_registration"));
    }
    broker.store.lock().await.update(|db| {
        let removed = db.runners.remove(&id).is_some();
        for run in db.runs.values_mut().filter(|run| run.runner_id == id) {
            match run.status {
                Status::Queued => {
                    run.status = Status::Cancelled;
                    run.reason = Some("runner_registration_revoked".into());
                }
                Status::Starting | Status::Running => {
                    run.stop(
                        Status::Cancelled,
                        Some("runner_registration_revoked".into()),
                    );
                }
                _ => {}
            }
        }
        Ok(Json(json!({"revoked": removed})))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration {
    protocol_version: u8,
    capabilities: Capabilities,
}

async fn register(
    State(broker): State<Broker>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Registration>,
) -> Result<Json<Value>> {
    if input.protocol_version != VERSION {
        return Err(conflict("runner_protocol_version"));
    }
    input.capabilities.validate()?;
    broker.store.lock().await.update(|db| {
        runner_auth(db, &id, &headers)?;
        let runner = db.runners.get_mut(&id).unwrap();
        runner.last_seen = now();
        runner.capabilities = Some(input.capabilities);
        Ok(())
    })?;
    Ok(Json(json!({"protocolVersion": VERSION})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRun {
    request_id: Uuid,
    runner_id: String,
    config: Config,
}

async fn create_run(
    State(broker): State<Broker>,
    headers: HeaderMap,
    Json(input): Json<CreateRun>,
) -> Result<(StatusCode, Json<Value>)> {
    broker.operator(&headers)?;
    broker.store.lock().await.update(|db| {
        if let Some(run) = db
            .runs
            .values()
            .find(|run| run.request_id == input.request_id)
        {
            if run.runner_id != input.runner_id || run.config != input.config {
                return Err(conflict("runner_request_id_conflict"));
            }
            return Ok((StatusCode::OK, Json(run.summary())));
        }
        let runner = db
            .runners
            .get(&input.runner_id)
            .filter(|runner| runner.last_seen.saturating_add(RUNNER_ONLINE_SECONDS) > now())
            .ok_or_else(|| conflict("runner_offline"))?;
        input.config.validate(
            runner
                .capabilities
                .as_ref()
                .ok_or_else(|| conflict("runner_offline"))?,
        )?;
        if db
            .runs
            .values()
            .filter(|run| !run.status.terminal())
            .count()
            >= 16
        {
            return Err(conflict("runner_queue_full"));
        }
        let id = Uuid::new_v4();
        let run = Run {
            id,
            request_id: input.request_id,
            runner_id: input.runner_id,
            config: input.config,
            status: Status::Queued,
            reason: None,
            created_at: now(),
            deadline: 0,
            lease_hash: None,
            lease_until: 0,
            session: None,
            outcome: None,
            progress: None,
            report_id: None,
            archived: false,
            archive_failures: 0,
            replay_error: None,
            credentials: BTreeMap::new(),
        };
        let result = run.summary();
        db.runs.insert(id, run);
        Ok((StatusCode::ACCEPTED, Json(result)))
    })
}

async fn claim(
    State(broker): State<Broker>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let mut store = broker.store.lock().await;
    runner_auth(&store.db, &id, &headers)?;
    let runner = store.db.runners.get(&id).unwrap();
    let caps = runner
        .capabilities
        .as_ref()
        .ok_or_else(|| conflict("runner_register_first"))?;
    let current = now();
    let busy = store
        .db
        .runs
        .values()
        .filter(|run| run.runner_id == id && !run.status.terminal() && run.status != Status::Queued)
        .count();
    let next = (busy < usize::from(caps.concurrency))
        .then(|| {
            store
                .db
                .runs
                .values()
                .filter(|run| run.runner_id == id && run.status == Status::Queued)
                .min_by_key(|run| (run.created_at, run.id))
                .map(|run| run.id)
        })
        .flatten();
    if next.is_none() {
        store.db.runners.get_mut(&id).unwrap().last_seen = current;
        return Ok(Json(json!({"job": null})));
    }
    store.update(|db| {
        let runner = db.runners.get_mut(&id).unwrap();
        runner.last_seen = current;
        let run = db.runs.get_mut(&next.unwrap()).unwrap();
        if run.config.validate(runner.capabilities.as_ref().unwrap()).is_err() {
            run.status = Status::Failed;
            run.reason = Some("runner_unsupported_config".into());
            return Ok(Json(json!({"job": null})));
        }
        let token = secret();
        run.status = Status::Starting;
        run.lease_hash = Some(digest(&token));
        run.lease_until = current + LEASE_SECONDS;
        run.deadline = current + u64::from(run.config.timeout_seconds) + 15;
        Ok(Json(json!({"job": {
            "runId": run.id, "leaseToken": token, "leaseSeconds": LEASE_SECONDS, "config": run.config,
        }})))
    })
}

async fn list_runs(State(broker): State<Broker>, headers: HeaderMap) -> Result<Json<Value>> {
    broker.operator(&headers)?;
    let store = broker.store.lock().await;
    let mut runs: Vec<_> = store.db.runs.values().collect();
    runs.sort_unstable_by_key(|run| std::cmp::Reverse((run.created_at, run.id)));
    Ok(Json(
        json!({"runs": runs.into_iter().take(RECENT_RUNS).map(Run::summary).collect::<Vec<_>>() }),
    ))
}

async fn get_run(
    State(broker): State<Broker>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    broker.operator(&headers)?;
    Ok(Json(find_run(&broker.store.lock().await.db, id)?.summary()))
}

async fn cancel(
    State(broker): State<Broker>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    broker.operator(&headers)?;
    let mut store = broker.store.lock().await;
    let run = find_run(&store.db, id)?;
    if run.status == Status::Stopping || run.status.terminal() {
        return Ok(Json(run.summary()));
    }
    store.update(|db| {
        let run = db.runs.get_mut(&id).unwrap();
        if run.status == Status::Queued {
            run.status = Status::Cancelled;
        } else {
            run.stop(Status::Cancelled, None);
        }
        Ok(Json(run.summary()))
    })
}

async fn observer(
    State(broker): State<Broker>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    broker.operator(&headers)?;
    let store = broker.store.lock().await;
    let run = find_run(&store.db, id)?;
    if run.status != Status::Running {
        return Err(conflict("runner_observer_unavailable"));
    }
    let session = run
        .session
        .as_ref()
        .ok_or_else(|| conflict("runner_observer_unavailable"))?;
    let token = session
        .observer_token
        .as_ref()
        .ok_or_else(|| conflict("runner_observer_unavailable"))?;
    Ok(Json(
        json!({"format": "3dbox-observer-access-v1", "sessionId": session.id, "observerToken": token}),
    ))
}

async fn report(
    State(broker): State<Broker>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response> {
    broker.operator(&headers)?;
    let path = {
        let store = broker.store.lock().await;
        if !find_run(&store.db, id)?.archived {
            return Err(conflict("runner_replay_unavailable"));
        }
        store.report(id)
    };
    let bytes = tokio::task::spawn_blocking(move || fs::read(path))
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "runner_storage_failed"))?
        .map_err(storage_error)?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .unwrap())
}

async fn heartbeat(
    State(broker): State<Broker>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let mut store = broker.store.lock().await;
    leased(&store.db, id, &headers)?;
    let current = now();
    store.update(|db| {
        let run = db.runs.get_mut(&id).unwrap();
        run.lease_until = current + LEASE_SECONDS;
        db.runners.get_mut(&run.runner_id).unwrap().last_seen = current;
        Ok(Json(json!({"leaseSeconds": LEASE_SECONDS})))
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Finish {
    status: Status,
    reason: Option<String>,
}

async fn finish(
    State(broker): State<Broker>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<Finish>,
) -> Result<Json<Value>> {
    if !matches!(
        input.status,
        Status::Completed | Status::Failed | Status::Timeout
    ) || input
        .reason
        .as_ref()
        .is_some_and(|reason| !valid_id(reason))
    {
        return Err(invalid("runner_invalid_outcome"));
    }
    let mut store = broker.store.lock().await;
    let run = leased(&store.db, id, &headers)?;
    let outcome = if input.status == Status::Completed && run.session.is_none() {
        return Err(conflict("runner_session_unavailable"));
    } else {
        input.status
    };
    store.update(|db| {
        let run = db.runs.get_mut(&id).unwrap();
        run.stop(outcome, input.reason);
        Ok(Json(run.summary()))
    })
}

async fn session(
    State(broker): State<Broker>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response> {
    let broker_task = broker.clone();
    tokio::spawn(async move { create_session(broker_task, id, headers).await })
        .await
        .map_err(|_| invalid_world_response())?
}

async fn create_session(broker: Broker, id: Uuid, headers: HeaderMap) -> Result<Response> {
    let _operation = broker.operation(id).await?;
    let existing = {
        let store = broker.store.lock().await;
        let run = leased(&store.db, id, &headers)?;
        (run.session.clone(), run.config.clone())
    };
    let (session, scene) = match existing {
        (Some(session), _) if session.observer_token.is_some() => {
            let response = broker
                .world(
                    Method::GET,
                    &format!("/sessions/{}/observer", session.id),
                    session.observer_token.as_deref(),
                    None,
                )
                .await?;
            return relay(response);
        }
        (Some(session), _) => (session, Value::Null),
        (None, config) => {
            let response = broker.world(Method::POST, "/sessions", None, Some(json!({
                "sceneId": config.scene_id, "seed": config.seed, "physicsMode": config.physics,
                "executionMode": "primitive", "dispatchMode": "external",
            }))).await?;
            if !response.status().is_success() {
                return relay(response);
            }
            let mut created: Value = response.json().await.map_err(world_response_error)?;
            let session_id = created["sessionId"]
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(invalid_world_response)?;
            let admin_token = created
                .as_object_mut()
                .and_then(|value| value.remove("adminToken"))
                .and_then(|token| token.as_str().map(str::to_owned))
                .ok_or_else(invalid_world_response)?;
            let session = WorldSession {
                id: session_id,
                admin_token,
                observer_token: None,
            };
            let saved = broker.store.lock().await.update(|db| {
                let run = db.runs.get_mut(&id).unwrap();
                run.session = Some(session.clone());
                run.progress = progress(&created);
                Ok(())
            });
            if let Err(error) = saved {
                let _ = broker
                    .world(
                        Method::DELETE,
                        &format!("/sessions/{}", session.id),
                        Some(&session.admin_token),
                        None,
                    )
                    .await;
                return Err(error);
            }
            (session, created)
        }
    };
    let route = format!("/sessions/{}/observer/credentials", session.id);
    let response = broker
        .world(
            Method::POST,
            &route,
            Some(&session.admin_token),
            Some(json!({})),
        )
        .await?;
    if !response.status().is_success() {
        return relay(response);
    }
    let observer_token = response
        .json::<Value>()
        .await
        .map_err(world_response_error)?["observerToken"]
        .as_str()
        .ok_or_else(invalid_world_response)?
        .to_owned();
    broker.store.lock().await.update(|db| {
        leased(db, id, &headers)?;
        let run = db.runs.get_mut(&id).unwrap();
        run.session.as_mut().unwrap().observer_token = Some(observer_token.clone());
        run.status = Status::Running;
        Ok(())
    })?;
    if scene.is_null() {
        return relay(
            broker
                .world(
                    Method::GET,
                    &format!("/sessions/{}/observer", session.id),
                    Some(&observer_token),
                    None,
                )
                .await?,
        );
    }
    Ok(Json(scene).into_response())
}

#[derive(Clone, Serialize, Deserialize)]
struct ScopedCredential {
    token: String,
    agent: Option<String>,
}

fn invalid_world_response() -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, "world_response_failed")
}

fn world_response_error(_: reqwest::Error) -> ApiError {
    invalid_world_response()
}

fn relay(response: reqwest::Response) -> Result<Response> {
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| header::HeaderValue::from_static("application/json"));
    Ok(Response::builder()
        .status(response.status())
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap())
}

fn progress(snapshot: &Value) -> Option<Progress> {
    let world = &snapshot["world"];
    let tasks = world["tasks"].as_array()?;
    Some(Progress {
        tick: world["tick"].as_u64()?,
        completed_tasks: tasks.iter().filter(|task| task["status"] == "done").count(),
        total_tasks: tasks.len(),
    })
}

enum WorldRoute<'a> {
    Admin,
    Step,
    Issue {
        agent: Option<&'a str>,
        field: &'static str,
    },
    Scoped {
        agent: Option<&'a str>,
    },
}

fn world_route<'a>(method: &Method, parts: &[&'a str]) -> Result<WorldRoute<'a>> {
    use WorldRoute::*;
    let route = match (method, parts) {
        (&Method::GET, ["sessions", _]) => Admin,
        (&Method::POST, ["sessions", _, "step"]) => Step,
        (&Method::POST, ["sessions", _, "fault"]) => Admin,
        (&Method::POST, ["sessions", _, "agents", agent, "credentials"]) => Issue {
            agent: Some(agent),
            field: "agentToken",
        },
        (
            &Method::POST,
            ["sessions", _, "coordinator", "credentials"]
            | ["sessions", _, "coordinators", _, "credentials"],
        ) => Issue {
            agent: None,
            field: "coordinatorToken",
        },
        (&Method::GET, ["sessions", _, "observations", agent])
        | (
            &Method::POST,
            ["sessions", _, "agents", agent, "actions" | "messages" | "lidar" | "sample-reports"],
        )
        | (&Method::POST, ["sessions", _, "agents", agent, "actions", "cancel"]) => {
            Scoped { agent: Some(agent) }
        }
        (&Method::GET, ["sessions", _, "coordinator", "observation"])
        | (
            &Method::POST,
            ["sessions", _, "coordinator", "decisions" | "revocations" | "proposals"],
        ) => Scoped { agent: None },
        _ => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "runner_world_route_not_found",
            ))
        }
    };
    Ok(route)
}

async fn world_request(
    State(broker): State<Broker>,
    Path((id, route)): Path<(Uuid, String)>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Response> {
    tokio::spawn(async move { forward_world(broker, id, route, method, headers, bytes).await })
        .await
        .map_err(|_| invalid_world_response())?
}

async fn forward_world(
    broker: Broker,
    id: Uuid,
    route: String,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Response> {
    let parts: Vec<_> = route.split('/').collect();
    if parts.iter().any(|part| !valid_id(part)) {
        return Err(invalid("runner_invalid_world_path"));
    }
    let route_kind = world_route(&method, &parts)?;
    let credential = bearer_token(&headers).ok_or_else(unauthorized)?;
    let body = if bytes.is_empty() {
        None
    } else {
        Some(serde_json::from_slice::<Value>(&bytes).map_err(|_| invalid("runner_invalid_json"))?)
    };
    let _operation = broker.operation(id).await?;
    let (token, max_ticks, current_tick) = {
        let store = broker.store.lock().await;
        let run = store.db.runs.get(&id).ok_or_else(unauthorized)?;
        if run.status != Status::Running {
            return Err(conflict("runner_lease_inactive"));
        }
        let session = run.session.as_ref().unwrap();
        if parts.get(1).and_then(|part| Uuid::parse_str(part).ok()) != Some(session.id) {
            return Err(ApiError(StatusCode::FORBIDDEN, "runner_session_mismatch"));
        }
        let token = match &route_kind {
            WorldRoute::Scoped { agent } => {
                if now() >= run.lease_until || now() >= run.deadline {
                    return Err(conflict("runner_lease_inactive"));
                }
                let scoped = run
                    .credentials
                    .get(&digest(credential))
                    .ok_or_else(unauthorized)?;
                if scoped.agent.as_deref() != *agent {
                    return Err(ApiError(StatusCode::FORBIDDEN, "runner_scope_mismatch"));
                }
                scoped.token.clone()
            }
            _ => {
                leased(&store.db, id, &headers)?;
                session.admin_token.clone()
            }
        };
        (
            token,
            u64::from(run.config.max_ticks),
            run.progress.map_or(0, |value| value.tick),
        )
    };
    if matches!(route_kind, WorldRoute::Step) {
        let count = body.as_ref().and_then(|body| body["count"].as_u64());
        if count != Some(1) {
            return Err(invalid("runner_requires_single_step"));
        }
        if current_tick >= max_ticks {
            return Err(conflict("runner_tick_limit"));
        }
    }
    let response = broker
        .world(method, &format!("/{route}"), Some(&token), body)
        .await?;
    if !response.status().is_success() {
        return relay(response);
    }
    let status = response.status();
    match route_kind {
        WorldRoute::Issue { agent, field } => {
            let mut response: Value = response.json().await.map_err(world_response_error)?;
            let world_token = response[field]
                .as_str()
                .ok_or_else(invalid_world_response)?
                .to_owned();
            let scoped_token = secret();
            broker.store.lock().await.update(|db| {
                leased(db, id, &headers)?;
                let run = db.runs.get_mut(&id).unwrap();
                if run.credentials.len() >= 320 {
                    return Err(conflict("runner_credential_limit"));
                }
                run.credentials.insert(
                    digest(&scoped_token),
                    ScopedCredential {
                        token: world_token,
                        agent: agent.map(str::to_owned),
                    },
                );
                Ok(())
            })?;
            response[field] = json!(scoped_token);
            Ok((status, Json(response)).into_response())
        }
        WorldRoute::Step => {
            let response: Value = response.json().await.map_err(world_response_error)?;
            let mut store = broker.store.lock().await;
            store.db.runs.get_mut(&id).unwrap().progress = progress(&response);
            Ok((status, Json(response)).into_response())
        }
        _ => relay(response),
    }
}

impl Broker {
    async fn operation(&self, id: Uuid) -> Result<tokio::sync::OwnedMutexGuard<()>> {
        if !self.store.lock().await.db.runs.contains_key(&id) {
            return Err(unauthorized());
        }
        Ok(self.operation_lock(id).lock_owned().await)
    }

    fn operation_lock(&self, id: Uuid) -> Arc<Mutex<()>> {
        self.operations
            .lock()
            .unwrap()
            .entry(id)
            .or_default()
            .clone()
    }

    async fn sweep(&self) {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let ids = {
                let mut store = self.store.lock().await;
                let current = now();
                if store
                    .db
                    .runs
                    .values()
                    .any(|run| expiry(run, current).is_some())
                {
                    let result = store.update(|db| {
                        for run in db.runs.values_mut() {
                            if let Some((status, reason)) = expiry(run, current) {
                                run.stop(status, Some(reason.into()));
                            }
                        }
                        Ok(())
                    });
                    if result.is_err() {
                        continue;
                    }
                }
                store
                    .db
                    .runs
                    .values()
                    .filter(|run| run.status == Status::Stopping)
                    .map(|run| run.id)
                    .collect::<Vec<_>>()
            };
            for id in ids {
                let Ok(guard) = self.operation_lock(id).try_lock_owned() else {
                    continue;
                };
                let broker = self.clone();
                tokio::spawn(async move {
                    let _guard = guard;
                    if let Err(error) = broker.finalize(id).await {
                        tracing::warn!(%id, ?error, "runner finalization will retry");
                    }
                });
            }
        }
    }

    async fn finalize(&self, id: Uuid) -> Result<()> {
        match self.archive_and_close(id).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.store.lock().await.update(|db| {
                    let run = db.runs.get_mut(&id).unwrap();
                    if !run.archived && run.session.is_some() {
                        run.archive_failures = run.archive_failures.saturating_add(1);
                        if run.archive_failures >= MAX_ARCHIVE_FAILURES {
                            run.replay_error = Some("runner_archive_failed".into());
                        }
                    }
                    Ok(())
                })?;
                Err(error)
            }
        }
    }

    async fn archive_and_close(&self, id: Uuid) -> Result<()> {
        let (run, path) = {
            let store = self.store.lock().await;
            (store.db.runs[&id].clone(), store.report(id))
        };
        let mut outcome = run.outcome.unwrap_or(Status::Failed);
        let mut reason = run.reason;
        let mut replay_error = run.replay_error;
        if let Some(session) = &run.session {
            let root = format!("/sessions/{}", session.id);
            let token = Some(session.admin_token.as_str());
            if !run.archived
                && run.archive_failures >= MAX_ARCHIVE_FAILURES
                && outcome == Status::Completed
            {
                outcome = Status::Failed;
                reason = Some("runner_archive_failed".into());
            }
            if !run.archived && run.archive_failures < MAX_ARCHIVE_FAILURES {
                let state = self.world(Method::GET, &root, token, None).await?;
                if state.status().is_success() {
                    let state: Value = state.json().await.map_err(world_response_error)?;
                    if outcome == Status::Completed
                        && (state["world"]["done"] != true || state["world"]["failed"] == true)
                    {
                        outcome = Status::Failed;
                        reason = Some("runner_world_incomplete".into());
                    }
                    let report_id = match run.report_id {
                        Some(report_id) => report_id,
                        None => {
                            let response = self
                                .world(
                                    Method::POST,
                                    &format!("{root}/catalog"),
                                    token,
                                    Some(json!({"label": format!("Runner {id}")})),
                                )
                                .await?;
                            if !response.status().is_success() {
                                return Err(invalid_world_response());
                            }
                            let report_id = response
                                .json::<Value>()
                                .await
                                .map_err(world_response_error)?["report"]["id"]
                                .as_str()
                                .filter(|id| {
                                    id.len() == 64 && id.bytes().all(|c| c.is_ascii_hexdigit())
                                })
                                .ok_or_else(invalid_world_response)?
                                .to_owned();
                            self.store.lock().await.update(|db| {
                                let run = db.runs.get_mut(&id).unwrap();
                                run.report_id = Some(report_id.clone());
                                run.progress = progress(&state);
                                run.outcome = Some(outcome);
                                run.reason = reason.clone();
                                Ok(())
                            })?;
                            report_id
                        }
                    };
                    let response = self
                        .world(
                            Method::GET,
                            &format!("{root}/catalog/{report_id}"),
                            token,
                            None,
                        )
                        .await?;
                    if !response.status().is_success() {
                        return Err(invalid_world_response());
                    }
                    let bytes = response.bytes().await.map_err(world_response_error)?;
                    if bytes.len() > 50 * 1024 * 1024 || hex_digest(&bytes) != report_id {
                        return Err(invalid_world_response());
                    }
                    tokio::task::spawn_blocking(move || atomic_write(&path, &bytes))
                        .await
                        .map_err(|_| {
                            ApiError(StatusCode::INTERNAL_SERVER_ERROR, "runner_storage_failed")
                        })?
                        .map_err(storage_error)?;
                    self.store.lock().await.update(|db| {
                        db.runs.get_mut(&id).unwrap().archived = true;
                        Ok(())
                    })?;
                } else if !matches!(
                    state.status(),
                    StatusCode::NOT_FOUND | StatusCode::SERVICE_UNAVAILABLE
                ) {
                    return Err(invalid_world_response());
                } else {
                    replay_error = Some("runner_world_unavailable".into());
                    if outcome == Status::Completed {
                        outcome = Status::Failed;
                        reason = replay_error.clone();
                    }
                }
            }
            let response = self.world(Method::DELETE, &root, token, None).await?;
            if !response.status().is_success() && response.status() != StatusCode::NOT_FOUND {
                return Err(invalid_world_response());
            }
        }
        self.store.lock().await.update(|db| {
            let run = db.runs.get_mut(&id).unwrap();
            run.status = outcome;
            run.reason = reason;
            run.replay_error = replay_error;
            run.session = None;
            run.credentials.clear();
            Ok(())
        })
    }
}

fn expiry(run: &Run, current: u64) -> Option<(Status, &'static str)> {
    match run.status {
        Status::Starting | Status::Running if current >= run.deadline => {
            Some((Status::Timeout, "runner_timeout"))
        }
        Status::Starting | Status::Running if current >= run.lease_until => {
            Some((Status::Failed, "runner_lease_expired"))
        }
        _ => None,
    }
}
