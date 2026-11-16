use serde::{Deserialize, Serialize};

fn range(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Camera {
    enabled: bool,
    mount: [f64; 3],
    yaw: f64,
    pitch: f64,
    fov: f64,
    range: f64,
    update_ticks: u32,
    resolution: [u32; 2],
}

impl Camera {
    pub(crate) fn valid(&self) -> bool {
        self.mount.iter().all(|value| range(*value, -100.0, 100.0))
            && range(self.yaw, -180.0, 180.0)
            && range(self.pitch, -90.0, 90.0)
            && range(self.fov, 30.0, 120.0)
            && range(self.range, 0.0, 1000.0)
            && self.range > 0.0
            && (1..=1000).contains(&self.update_ticks)
            && (160..=640).contains(&self.resolution[0])
            && (90..=360).contains(&self.resolution[1])
    }
}
