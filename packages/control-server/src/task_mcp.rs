use crate::task_runs::{auth, bearer, tool_definitions, RunService};
use axum::{http::request::Parts, middleware, Router};
use rmcp::{
    model::*,
    service::RequestContext,
    transport::{
        streamable_http_server::{
            session::local::LocalSessionManager, tower::StreamableHttpService,
        },
        StreamableHttpServerConfig,
    },
    ErrorData, RoleServer, ServerHandler,
};
use serde_json::{json, Value};

pub fn http_server_config() -> StreamableHttpServerConfig {
    let mut config = StreamableHttpServerConfig::default();
    // RMCP validates Host independently of the HTTP authorization middleware.
    // Preserve loopback defaults and add the explicitly configured public hosts.
    config.allowed_hosts.extend(
        std::env::var("BOX_ALLOWED_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .map(str::to_ascii_lowercase),
    );
    config
}

#[derive(Clone)]
pub enum TaskTools {
    Local(RunService),
    Remote {
        client: reqwest::Client,
        url: String,
        token: String,
    },
}
impl ServerHandler for TaskTools {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some("3DBox task control. Discover capabilities, create a run, observe, assign tasks, submit actions and repeatedly advance until verified completion. Preserve request IDs on retries. Thinking does not advance simulation. Return console_url to the user. Notes are optional summaries.".into());
        info
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: tool_definitions()
                .into_iter()
                .map(|v| serde_json::from_value(v).expect("tool schema"))
                .collect(),
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        req: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let progress_token = ctx.meta.get_progress_token();
        if let Some(token) = progress_token.clone() {
            let _ = ctx
                .peer
                .notify_progress(
                    ProgressNotificationParam::new(token, 0.0)
                        .with_total(1.0)
                        .with_message(format!("开始调用 {}", req.name)),
                )
                .await;
        }
        let input = Value::Object(req.arguments.unwrap_or_default());
        let result = match self {
            Self::Local(s) => {
                let token = ctx
                    .extensions
                    .get::<Parts>()
                    .and_then(|p| bearer(&p.headers))
                    .unwrap_or("");
                match s.authenticate(token) {
                    Ok(p) => s.call(&p, req.name.as_ref(), input).await,
                    Err(e) => Err(e),
                }
            }
            Self::Remote { client, url, token } => {
                let response = client
                    .post(format!("{url}/runs/v1/tools/{}", req.name))
                    .bearer_auth(token)
                    .json(&input)
                    .send()
                    .await;
                match response {
                    Ok(r) => {
                        let ok = r.status().is_success();
                        match r.json::<Value>().await {
                            Ok(v) if ok => Ok(v),
                            Ok(v) => Err(anyhow::anyhow!(v["error"]
                                .as_str()
                                .unwrap_or("control_request_failed")
                                .to_string())),
                            Err(_) => Err(anyhow::anyhow!("outcome_unknown")),
                        }
                    }
                    Err(_) => Err(anyhow::anyhow!("outcome_unknown")),
                }
            }
        };
        if let Some(token) = progress_token {
            let message = match &result {
                Ok(v) if req.name == "box_advance" => {
                    format!(
                        "本段推进了 {} 步，停止原因 {}",
                        v["executed"],
                        v["stop_reason"].as_str().unwrap_or("unknown")
                    )
                }
                Ok(_) => format!("{} 已返回结果", req.name),
                Err(_) => format!("{} 调用失败", req.name),
            };
            let _ = ctx
                .peer
                .notify_progress(
                    ProgressNotificationParam::new(token, 1.0)
                        .with_total(1.0)
                        .with_message(message),
                )
                .await;
        }
        Ok(match result {
            Ok(v) => CallToolResult::structured(v),
            Err(e) => {
                let code = e.to_string();
                CallToolResult::structured_error(
                    json!({"code":code,"message":code,"retryable":code=="outcome_unknown"}),
                )
            }
        }
        .into())
    }
}
pub fn router<S: Clone + Send + Sync + 'static>(svc: RunService) -> Router<S> {
    let tools = TaskTools::Local(svc.clone());
    let service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        LocalSessionManager::default().into(),
        http_server_config(),
    );
    Router::new()
        .nest_service("/mcp/control", service)
        .layer(tower_http::limit::RequestBodyLimitLayer::new(16384))
        .layer(middleware::from_fn_with_state(svc, auth))
}
