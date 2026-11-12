#!/bin/sh
set -eu

# Copy the downloaded crates' notices and metadata before discarding build tools.
native_license_root=${1:-/build/native-licenses}
native_lock_file=${2:-/build/rust/physics/Cargo.lock}
mkdir -p "$native_license_root"
for native_crate_dir in "${CARGO_HOME:?}/registry/src/"*/*; do
    test -d "$native_crate_dir" || continue
    native_crate_name=$(basename "$native_crate_dir")
    native_crate_destination="$native_license_root/$native_crate_name"
    mkdir -p "$native_crate_destination"
    cp "$native_crate_dir/Cargo.toml" "$native_crate_destination/Cargo.toml"
    for native_notice in "$native_crate_dir"/*LICENSE* "$native_crate_dir"/*LICENCE* \
                         "$native_crate_dir"/*NOTICE* "$native_crate_dir"/*COPYING* \
                         "$native_crate_dir"/*COPYRIGHT* "$native_crate_dir"/license* \
                         "$native_crate_dir"/notice* "$native_crate_dir"/copying*; do
        test -e "$native_notice" || continue
        cp -R "$native_notice" "$native_crate_destination/"
    done
done
cp "$native_lock_file" "$native_license_root/Cargo.lock"
