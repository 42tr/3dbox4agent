use std::{env, sync::Arc, time::Duration};

use anyhow::Context;
use axum::{
    body::{Body, HttpBody},
    extract::State,
    http::{header, request::Parts, HeaderMap, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use reqwest::Client;
use rmcp::{
    handler::server::tool::Extension,
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    schemars, tool,
    transport::{
        streamable_http_server::{
            session::local::LocalSessionManager, tower::StreamableHttpService,
        },
        StreamableHttpServerConfig,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;

mod runner;

#[derive(Clone)]
struct AppState {
    client: Client,
    world_url: Arc<str>,
}

#[derive(Clone)]
struct ControlTools {
    client: Client,
    world_url: Arc<str>,
    default_token: Option<Arc<str>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AgentReference {
    #[schemars(description = "World session identifier")]
    session_id: String,
    #[schemars(description = "Agent identifier inside the session")]
    agent_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ActionRequest {
    #[schemars(description = "World session identifier")]
    session_id: String,
    #[schemars(description = "Agent identifier inside the session")]
    agent_id: String,
    #[schemars(description = "Semantic action envelope accepted by the World service")]
    action: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CancelActionRequest {
    #[schemars(description = "World session identifier")]
    session_id: String,
    #[schemars(description = "Agent identifier inside the session")]
    agent_id: String,
    request_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct MessageRequest {
    #[schemars(description = "World session identifier")]
    session_id: String,
    #[schemars(description = "Agent identifier inside the session")]
    agent_id: String,
    to: String,
    text: String,
    #[serde(default)]
    via: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    ok: bool,
    service: &'static str,
    world_url: String,
}

#[rmcp::tool_router(server_handler)]
impl ControlTools {
    #[tool(description = "Read the current scoped observation for an Agent from the World service")]
    async fn observe_agent(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(input): Parameters<AgentReference>,
    ) -> CallToolResult {
        let token = bearer_token(&parts.headers);
        self.request(
            Method::GET,
            format!(
                "/sessions/{}/observations/{}",
                encode_path(&input.session_id),
                encode_path(&input.agent_id)
            ),
            token,
            None,
        )
        .await
    }

    #[tool(description = "Submit one semantic action for an Agent")]
    async fn submit_action(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(input): Parameters<ActionRequest>,
    ) -> CallToolResult {
        let token = bearer_token(&parts.headers);
        self.request(
            Method::POST,
            format!(
                "/sessions/{}/agents/{}/actions",
                encode_path(&input.session_id),
                encode_path(&input.agent_id)
            ),
            token,
            Some(json!(input.action)),
        )
        .await
    }

    #[tool(description = "Cancel a previously submitted Agent action by request id")]
    async fn cancel_action(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(input): Parameters<CancelActionRequest>,
    ) -> CallToolResult {
        let token = bearer_token(&parts.headers);
        self.request(
            Method::POST,
            format!(
                "/sessions/{}/agents/{}/actions/cancel",
                encode_path(&input.session_id),
                encode_path(&input.agent_id)
            ),
            token,
            Some(json!({ "requestId": input.request_id })),
        )
        .await
    }

    #[tool(description = "Send a message from one Agent to another through the World service")]
    async fn send_agent_message(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(input): Parameters<MessageRequest>,
    ) -> CallToolResult {
        let token = bearer_token(&parts.headers);
        let mut payload = json!({ "to": input.to, "text": input.text });
        if let Some(via) = input.via {
            payload["via"] = json!(via);
        }
        if let Some(request_id) = input.request_id {
            payload["requestId"] = json!(request_id);
        }
        self.request(
            Method::POST,
            format!(
                "/sessions/{}/agents/{}/messages",
                encode_path(&input.session_id),
                encode_path(&input.agent_id)
            ),
            token,
            Some(payload),
        )
        .await
    }
}

impl ControlTools {
    async fn request(
        &self,
        method: Method,
        path: String,
        token: Option<&str>,
        payload: Option<Value>,
    ) -> CallToolResult {
        let Some(token) = token.or(self.default_token.as_deref()) else {
            return tool_error(StatusCode::UNAUTHORIZED, "missing_agent_token");
        };

        let mut request = self
            .client
            .request(method, format!("{}{}", self.world_url, path))
            .bearer_auth(token);
        if let Some(payload) = payload {
            request = request.json(&payload);
        }
        match request.send().await {
            Ok(response) => tool_response(response).await,
            Err(_) => tool_error(StatusCode::BAD_GATEWAY, "world_unreachable"),
        }
    }
}

async fn tool_response(response: reqwest::Response) -> CallToolResult {
    let status = response.status();
    let Ok(body) = response.text().await else {
        return tool_error(StatusCode::BAD_GATEWAY, "world_response_failed");
    };
    let Ok(Value::Object(mut payload)) = serde_json::from_str(&body) else {
        return tool_error(StatusCode::BAD_GATEWAY, "invalid_world_response");
    };
    if status.is_success() {
        CallToolResult::success(vec![ContentBlock::text(body)])
    } else {
        payload.insert("status".into(), json!(status.as_u16()));
        CallToolResult::error(vec![ContentBlock::text(Value::Object(payload).to_string())])
    }
}

fn tool_error(status: StatusCode, error: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(
        json!({ "error": error, "status": status.as_u16() }).to_string(),
    )])
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then_some(token)
}

fn encode_path(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "control",
        world_url: state.world_url.to_string(),
    })
}

async fn require_mcp_auth(
    State(has_default_token): State<bool>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let headers = request.headers();
    let has_bearer = bearer_token(headers).is_some();
    let use_default = has_default_token && !headers.contains_key(header::AUTHORIZATION);
    if has_bearer || use_default {
        next.run(request).await
    } else {
        http_error(StatusCode::UNAUTHORIZED, "missing_agent_token")
    }
}

fn http_error(status: StatusCode, error: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "error": error })),
    )
        .into_response()
}

async fn proxy(State(state): State<AppState>, inbound: Request<Body>) -> Response {
    let (parts, body) = inbound.into_parts();
    let route = if parts.method == Method::GET && parts.uri.path() == "/world/health" {
        "/health"
    } else {
        parts.uri.path_and_query().map_or("/", |path| path.as_str())
    };
    let target = format!("{}{}", state.world_url, route);
    let mut request = state.client.request(parts.method, target);
    for name in [
        header::AUTHORIZATION,
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::ACCEPT,
        header::HOST,
        header::ORIGIN,
    ] {
        if let Some(value) = parts.headers.get(&name) {
            request = request.header(name, value.clone());
        }
    }
    if !body.is_end_stream() {
        request = request.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => return http_error(StatusCode::BAD_GATEWAY, "world_unreachable"),
    };
    let mut builder = Response::builder().status(response.status());
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CACHE_CONTROL,
        header::CONTENT_DISPOSITION,
        header::X_CONTENT_TYPE_OPTIONS,
    ] {
        if let Some(value) = response.headers().get(&name) {
            builder = builder.header(name, value);
        }
    }
    builder
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|_| http_error(StatusCode::BAD_GATEWAY, "world_response_failed"))
}

fn env_or(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(env_or("RUST_LOG", "threebox_control_server=info"))
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()) && env::var_os("NO_COLOR").is_none())
        .init();

    let world_origin = reqwest::Url::parse(&env_or("WORLD_URL", "http://127.0.0.1:8787"))
        .context("parse WORLD_URL")?;
    anyhow::ensure!(
        matches!(world_origin.scheme(), "http" | "https")
            && world_origin.host().is_some()
            && world_origin.username().is_empty()
            && world_origin.password().is_none()
            && world_origin.path() == "/"
            && world_origin.query().is_none()
            && world_origin.fragment().is_none(),
        "WORLD_URL must be an HTTP or HTTPS origin"
    );
    let world_url = world_origin.origin().ascii_serialization();
    let bind = env_or("CONTROL_BIND", "127.0.0.1:8789");
    let default_token = env::var("CONTROL_AGENT_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
        .map(Arc::<str>::from);
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .context("create HTTP client")?;
    let state = AppState {
        client: client.clone(),
        world_url: Arc::<str>::from(world_url.clone()),
    };
    let has_default_token = default_token.is_some();
    let tools = ControlTools {
        client,
        world_url: Arc::<str>::from(world_url.clone()),
        default_token,
    };

    let mcp_service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );
    let mcp_router =
        Router::new()
            .nest_service("/mcp", mcp_service)
            .layer(middleware::from_fn_with_state(
                has_default_token,
                require_mcp_auth,
            ));
    let app = Router::new()
        .route("/health", get(health))
        .merge(mcp_router)
        .merge(runner::router::<AppState>(state.client.clone(), state.world_url.clone())?)
        .fallback(proxy)
        .with_state(state);

    let listener = TcpListener::bind(&bind)
        .await
        .with_context(|| format!("bind Control server at {bind}"))?;
    let address = listener
        .local_addr()
        .context("read Control listen address")?;
    tracing::info!(%address, %world_url, "Control server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve Control server")?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
