# Additional third-party license files

These upstream license texts accompany the container artifacts. Dependency
packages retain their own license files; the native image also copies downloaded
Cargo crates' notices, manifests and the dependency lock into `third_party/native`.

- `rapier-js-0.19.3-LICENSE`: upstream Rapier JavaScript/WASM binding license for
  `@dimforge/rapier3d-compat` 0.19.3. Source:
  https://raw.githubusercontent.com/dimforge/rapier.js/v0.19.3/LICENSE
  SHA-256: `4c05555705e3efde601fb1252ae48f1d63992af8a8fb8947745b7fa834e8f519`.
- `napi-rs-2.16.17-LICENSE`: upstream NAPI-RS repository license at the tag for
  the locked `napi` 2.16.17 dependency. Source:
  https://raw.githubusercontent.com/napi-rs/napi-rs/napi@2.16.17/LICENSE
  SHA-256: `3f1ce66533302df3a32edbfdfc0b78f0dd34659e4c1f5817162e5ea3c2297215`.

These files are copied verbatim. Updating the corresponding dependency requires
checking its matching upstream license and attribution files again.
