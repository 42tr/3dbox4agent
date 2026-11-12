use std::{env, sync::Arc};

use anyhow::Context;
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, request::Parts, HeaderMap, Method, Request, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use reqwest::Client;
use rmcp::{
    handler::server::tool::Extension,
    handler::server::wrapper::Parameters,
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
    ) -> String {
        let token = bearer_token(&parts);
        self.request(
            Method::GET,
            format!(
                "/sessions/{}/observations/{}",
                encode_path(&input.session_id),
                encode_path(&input.agent_id)
            ),
            token.as_deref(),
            None,
        )
        .await
    }

    #[tool(description = "Submit one semantic action for an Agent")]
    async fn submit_action(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(input): Parameters<ActionRequest>,
    ) -> String {
        let token = bearer_token(&parts);
        self.request(
            Method::POST,
            format!(
                "/sessions/{}/agents/{}/actions",
                encode_path(&input.session_id),
                encode_path(&input.agent_id)
            ),
            token.as_deref(),
            Some(json!(input.action)),
        )
        .await
    }

    #[tool(description = "Cancel a previously submitted Agent action by request id")]
    async fn cancel_action(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(input): Parameters<CancelActionRequest>,
    ) -> String {
        let token = bearer_token(&parts);
        self.request(
            Method::POST,
            format!(
                "/sessions/{}/agents/{}/actions/cancel",
                encode_path(&input.session_id),
                encode_path(&input.agent_id)
            ),
            token.as_deref(),
            Some(json!({ "requestId": input.request_id })),
        )
        .await
    }

    #[tool(description = "Send a message from one Agent to another through the World service")]
    async fn send_agent_message(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(input): Parameters<MessageRequest>,
    ) -> String {
        let token = bearer_token(&parts);
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
            token.as_deref(),
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
    ) -> String {
        let token = token
            .map(str::to_owned)
            .or_else(|| self.default_token.as_deref().map(str::to_owned));
        let Some(token) = token else {
            return error_json(
                StatusCode::UNAUTHORIZED,
                "missing_agent_token",
                "pass token or configure CONTROL_AGENT_TOKEN",
            );
        };

        let mut request = self
            .client
            .request(method, format!("{}{}", self.world_url, path))
            .bearer_auth(token);
        if let Some(payload) = payload {
            request = request.json(&payload);
        }
        match request.send().await {
            Ok(response) => response_json(response).await,
            Err(error) => error_json(
                StatusCode::BAD_GATEWAY,
                "world_unreachable",
                &error.to_string(),
            ),
        }
    }
}

async fn response_json(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|error| {
        json!({ "error": "invalid_world_response", "message": error.to_string() }).to_string()
    });
    if status.is_success() {
        body
    } else if serde_json::from_str::<Value>(&body).is_ok() {
        body
    } else {
        json!({ "error": "world_request_failed", "status": status.as_u16(), "message": body })
            .to_string()
    }
}

fn error_json(status: StatusCode, error: &str, message: &str) -> String {
    json!({ "error": error, "status": status.as_u16(), "message": message }).to_string()
}

fn bearer_token(parts: &Parts) -> Option<String> {
    let value = parts.headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then(|| token.to_owned())
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

async fn require_mcp_auth(request: Request<Body>, next: Next) -> Result<Response, StatusCode> {
    let has_bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| !token.trim().is_empty());
    let has_default_token = env::var("CONTROL_AGENT_TOKEN")
        .ok()
        .is_some_and(|token| !token.trim().is_empty());
    if has_bearer || has_default_token {
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

async fn proxy(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let target = format!("{}{}", state.world_url, uri);
    let mut request = state.client.request(method, target);
    for name in [header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT] {
        if let Some(value) = headers.get(&name) {
            request = request.header(name, value);
        }
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "world_unreachable", "message": error.to_string() })),
            )
                .into_response()
        }
    };
    let status = response.status();
    let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "world_response_failed", "message": error.to_string() })),
            )
                .into_response()
        }
    };
    let mut builder = Response::builder().status(status);
    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    builder
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

fn env_or(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(env_or("RUST_LOG", "threebox_control_server=info"))
        .init();

    let world_url = env_or("WORLD_URL", "http://127.0.0.1:8787")
        .trim_end_matches('/')
        .to_string();
    let bind = env_or("CONTROL_BIND", "127.0.0.1:8788");
    let default_token = env::var("CONTROL_AGENT_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
        .map(Arc::<str>::from);
    let mut client_builder = Client::builder();
    if is_loopback_world(&world_url) {
        client_builder = client_builder.no_proxy();
    }
    let client = client_builder.build().context("create HTTP client")?;
    let state = AppState {
        client: client.clone(),
        world_url: Arc::<str>::from(world_url.clone()),
    };
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
    let mcp_router = Router::new()
        .nest_service("/mcp", mcp_service)
        .layer(middleware::from_fn(require_mcp_auth));
    let app = Router::new()
        .route("/health", get(health))
        .merge(mcp_router)
        .fallback(proxy)
        .with_state(state);

    let listener = TcpListener::bind(&bind)
        .await
        .with_context(|| format!("bind Control server at {bind}"))?;
    tracing::info!(%bind, %world_url, "Control server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve Control server")?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

fn is_loopback_world(world_url: &str) -> bool {
    world_url.starts_with("http://127.0.0.1:")
        || world_url.starts_with("https://127.0.0.1:")
        || world_url.starts_with("http://localhost:")
        || world_url.starts_with("https://localhost:")
        || world_url.starts_with("http://[::1]:")
        || world_url.starts_with("https://[::1]:")
}
