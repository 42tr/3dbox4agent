use anyhow::{Context, Result};
use rmcp::ServiceExt;
use threebox_control_server::task_mcp::TaskTools;

#[tokio::main]
async fn main() -> Result<()> {
    let url = std::env::var("BOX_CONTROL_URL").unwrap_or_else(|_| "http://127.0.0.1:8789".into());
    let origin = reqwest::Url::parse(&url)?;
    anyhow::ensure!(
        matches!(origin.scheme(), "http" | "https")
            && origin.username().is_empty()
            && origin.password().is_none()
            && origin.query().is_none()
            && origin.fragment().is_none(),
        "invalid BOX_CONTROL_URL"
    );
    let token = std::env::var("BOX_CONTROL_TOKEN").context("BOX_CONTROL_TOKEN is required")?;
    anyhow::ensure!(!token.trim().is_empty(), "BOX_CONTROL_TOKEN is required");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(35))
        .build()?;
    let service = TaskTools::Remote {
        client,
        url: url.trim_end_matches('/').into(),
        token,
    }
    .serve(rmcp::transport::stdio())
    .await?;
    service.waiting().await?;
    Ok(())
}
