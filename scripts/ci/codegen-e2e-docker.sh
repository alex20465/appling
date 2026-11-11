#!/usr/bin/env bash
# Runs scripts/ci/codegen-e2e.mjs for one target inside the target's official docker image, with the host's Node
# mounted in, so the generated projects build without a local toolchain. The workspace must be built (pnpm build).
#
#   scripts/ci/codegen-e2e-docker.sh <django|ash|go|rust> [examples|constructs ...]
#
# The generated projects stay in .e2e/<target>/ of the repository (gitignored), the toolchains' caches in .e2e/home/. Ash and Go also start a Postgres container
# and shares its network namespace, so the generated config's localhost database works unchanged.
set -euo pipefail

target="${1:?usage: $0 <django|ash|go|rust> [examples|constructs ...]}"
shift
root="$(cd "$(dirname "$0")/../.." && pwd)"
node="$(command -v node)"
node_dir="$(cd "$(dirname "$(readlink -f "$node")")/.." && pwd)"

case "$target" in
  django) image=ghcr.io/astral-sh/uv:python3.12-bookworm-slim ;;
  ash) image=elixir:1.18 ;;
  go) image=golang:1.25 ;;
  rust) image=rust:1 ;;
  *) echo "unknown target $target" >&2; exit 2 ;;
esac

out="$root/.e2e/$target"
home="$root/.e2e/home"
rm -rf "$out"
mkdir -p "$out" "$home"

network=()
if [ "$target" = ash ] || [ "$target" = go ]; then
  pg="appling-e2e-postgres-$$"
  docker run -d --rm --name "$pg" -e POSTGRES_PASSWORD=postgres postgres:16-alpine >/dev/null
  trap 'docker rm -f "$pg" >/dev/null' EXIT
  network=(--network "container:$pg")
fi

docker run --rm "${network[@]}" \
  -v "$root:$root" -v "$node_dir:/opt/node:ro" -w "$root" \
  -e PATH="/opt/node/bin:/usr/local/cargo/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin" \
  -e HOME="$home" -e CARGO_HOME="$home/.cargo" -e GOPATH="$home/go" \
  --user "$(id -u):$(id -g)" \
  "$image" node scripts/ci/codegen-e2e.mjs "$target" "$@" --out "$out"
