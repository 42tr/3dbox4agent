//! Opaque, instance-bound copies used by the host's synchronous commit boundary.
//! No JSON restoration or caller-supplied state is accepted on this path.
use napi::{Error, Result};
use napi_derive::napi;
use std::{any::Any, sync::atomic::{AtomicU64, Ordering}};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
pub(crate) fn identity() -> u64 { NEXT_ID.fetch_add(1, Ordering::Relaxed) }

#[napi]
pub struct WorldCheckpoint { owner: u64, state: Option<Box<dyn Any + Send + Sync>> }
impl WorldCheckpoint {
    pub(crate) fn capture<T: Clone + Send + Sync + 'static>(owner: u64, value: &T) -> Self {
        Self { owner, state: Some(Box::new(value.clone())) }
    }
    pub(crate) fn restore<T: Clone + 'static>(&self, owner: u64) -> Result<T> {
        if owner != self.owner { return Err(Error::from_reason("checkpoint owner mismatch")); }
        self.state.as_ref().and_then(|s| s.downcast_ref::<T>()).cloned()
            .ok_or_else(|| Error::from_reason("checkpoint unavailable"))
    }
}
#[napi]
impl WorldCheckpoint {
    #[napi]
    pub fn free(&mut self) { self.state = None; }
}

macro_rules! world_checkpoint {
    ($name:ident) => {
        #[napi]
        impl $name {
            #[napi]
            pub fn checkpoint(&self) -> napi::Result<crate::world_checkpoint::WorldCheckpoint> {
                if self.closed { return Err(napi::Error::from_reason("checkpoint owner closed")); }
                Ok(crate::world_checkpoint::WorldCheckpoint::capture(self.checkpoint_id, self))
            }
            #[napi]
            pub fn rollback(&mut self, checkpoint: &crate::world_checkpoint::WorldCheckpoint) -> napi::Result<()> {
                if self.closed { return Err(napi::Error::from_reason("checkpoint owner closed")); }
                let saved: Self = checkpoint.restore(self.checkpoint_id)?;
                *self = saved;
                Ok(())
            }
        }
    };
}
pub(crate) use world_checkpoint;
