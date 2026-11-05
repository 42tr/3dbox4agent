//! Owned lifecycle state. The JS host may issue commands, but cannot replace the clock or event prefix.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT_LEDGER_ID: AtomicU64 = AtomicU64::new(1);

const MAX_TICK: u32 = 10_000_000;
const MAX_EVENTS: usize = 200_000;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initial {
    tick: u32,
    done: bool,
    failed: bool,
    events: Vec<Value>,
}

fn invalid() -> Error { Error::from_reason("invalid world ledger input") }
fn valid_event(value: &Value) -> bool {
    let Some(event) = value.as_object() else { return false };
    event.get("message").and_then(Value::as_str).is_some_and(|s| s.encode_utf16().count() <= 500)
        && matches!(event.get("type").and_then(Value::as_str), Some("info" | "warning" | "success"))
}

#[napi]
#[derive(Clone)]
pub struct WorldLedger {
    checkpoint_id: u64,
    id: u64,
    tick: u32,
    done: bool,
    failed: bool,
    events: Vec<Value>,
    closed: bool,
}

impl WorldLedger {
    pub(crate) fn identity(&self) -> Result<u64> { self.active()?; Ok(self.id) }
    pub(crate) fn entries(&self) -> Result<&[Value]> { self.active()?; Ok(&self.events) }
    fn active(&self) -> Result<()> {
        if self.closed { Err(Error::from_reason("world ledger is closed")) } else { Ok(()) }
    }
}

#[napi]
impl WorldLedger {
    #[napi(constructor)]
    pub fn new(input: String) -> Result<Self> {
        if input.len() > 64 * 1024 * 1024 { return Err(invalid()) }
        let initial: Initial = serde_json::from_str(&input).map_err(|_| invalid())?;
        if initial.tick > MAX_TICK || initial.failed && !initial.done || initial.events.len() > MAX_EVENTS {
            return Err(invalid());
        }
        let mut previous = 0;
        for (index, event) in initial.events.iter().enumerate() {
            let tick = event.get("tick").and_then(Value::as_u64).ok_or_else(invalid)?;
            if !valid_event(event) || event.get("seq").and_then(Value::as_u64) != Some(index as u64 + 1)
                || tick < previous || tick > initial.tick as u64 { return Err(invalid()) }
            previous = tick;
        }
        Ok(Self { checkpoint_id: crate::world_checkpoint::identity(), id: NEXT_LEDGER_ID.fetch_add(1, Ordering::Relaxed), tick: initial.tick, done: initial.done, failed: initial.failed, events: initial.events, closed: false })
    }

    #[napi(getter)]
    pub fn tick(&self) -> Result<u32> { self.active()?; Ok(self.tick) }
    #[napi(getter)]
    pub fn done(&self) -> Result<bool> { self.active()?; Ok(self.done) }
    #[napi(getter)]
    pub fn failed(&self) -> Result<bool> { self.active()?; Ok(self.failed) }

    #[napi]
    pub fn advance(&mut self, expected_tick: f64) -> Result<u32> {
        self.active()?;
        if self.done { return Err(Error::from_reason("world ledger is finished")) }
        if expected_tick != self.tick as f64 || self.tick >= MAX_TICK { return Err(invalid()) }
        self.tick += 1;
        Ok(self.tick)
    }

    #[napi]
    pub fn finish(&mut self, failed: bool) -> Result<()> {
        self.active()?;
        if self.done && self.failed != failed { return Err(Error::from_reason("world ledger terminal state is immutable")) }
        self.done = true;
        self.failed = failed;
        Ok(())
    }

    #[napi]
    pub fn append(&mut self, input: String) -> Result<String> {
        self.active()?;
        if input.len() > 65536 || self.events.len() >= MAX_EVENTS { return Err(invalid()) }
        let mut event: Value = serde_json::from_str(&input).map_err(|_| invalid())?;
        if !valid_event(&event) || event.get("seq").is_some() || event.get("tick").is_some() { return Err(invalid()) }
        let fields = event.as_object_mut().ok_or_else(invalid)?;
        fields.insert("seq".into(), json!(self.events.len() + 1));
        fields.insert("tick".into(), json!(self.tick));
        let encoded = serde_json::to_string(&event).map_err(|_| invalid())?;
        self.events.push(event);
        Ok(encoded)
    }

    #[napi]
    pub fn snapshot(&self) -> Result<String> {
        self.active()?;
        serde_json::to_string(&json!({"tick":self.tick,"done":self.done,"failed":self.failed,"events":self.events})).map_err(|_| invalid())
    }

    #[napi]
    pub fn free(&mut self) {
        self.closed = true;
        self.events.clear();
        self.events.shrink_to_fit();
    }
}

crate::world_checkpoint::world_checkpoint!(WorldLedger);
