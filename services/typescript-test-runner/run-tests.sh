#!/bin/sh
# Universal entrypoint for lixpi-typescript-test-runner.
#
# api / web-ui / web-ui-user-portal / ai-model-registry / nex are bind-mounted from their own service directories
# (docker compose.typescript-test-runner.yml, included from the root
# docker compose.yml) — each is fully self-contained, with its own
# package.json, pnpm-workspace.yaml, and vitest.config.ts, identical to what
# ships in its app container. No config is duplicated here.
#
# "shared" covers packages/lixpi/*, mounted file-by-file under
# /usr/src/service/shared, tied together by packages/lixpi/pnpm-workspace.yaml
# so workspace:* deps between shared packages (e.g. nats-auth-callout-service
# -> auth-service) resolve. This script walks the subdirectories (one or two
# levels deep, since some packages nest their TS sources under a "ts/"
# subfolder) and runs whichever ones define a "test:run" script in their own
# package.json.
#
# This script is the image's ENTRYPOINT (Dockerfile), so it's invoked as a
# one-shot `docker compose run --rm` per call — each call gets its own fresh
# container (always reflects the current docker compose.yml) with a Compose
# auto-generated unique name, so concurrent invocations never collide.
#
# --profile is a top-level `docker compose` flag, not a `run` flag, so it
# must come before `run`. Both "dev" and "main" are required because the
# compose file has a cross-profile depends_on elsewhere that Compose
# validates regardless of which service you're targeting.
#
# Usage (assumes .env is symlinked via ./set-env.sh at the repo root; add
# --env-file .env.<your-env> to each command instead if you haven't run it):
#   docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner web-ui
#   docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner web-ui-user-portal
#   docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner ai-model-registry
#   docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner web-ui src/canvas-adapters/workspace-canvas.test.ts
#   docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner api
#   docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner nex
#   docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner shared
#   docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner shared auth-service
#   docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner shared debug-tools src/debug-tools.test.ts
#   docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner all
#
# For "shared", an optional first argument selects a single package by its
# directory name under packages/lixpi (e.g. "auth-service", "debug-tools",
# "nats-service" — the "ts" nesting is resolved automatically). Any remaining
# arguments are passed through to vitest. With no package argument, every
# shared package with a "test:run" script runs.

set -e
domain="$1"
[ "$#" -gt 0 ] && shift

run_domain() {
    dir="$1"
    shift
    echo "==> [$dir] pnpm install"
    (cd "/usr/src/service/$dir" && pnpm install)
    echo "==> [$dir] vitest run $*"
    (cd "/usr/src/service/$dir" && pnpm exec vitest run "$@")
}

run_shared() {
    # pnpm may update the workspace manifest with dependency build decisions.
    # Keep those install-only writes in the disposable container filesystem.
    cp /usr/src/service/shared-workspace/pnpm-workspace.yaml /usr/src/service/shared/pnpm-workspace.yaml

    pkg_filter=""
    case "$1" in
        ""|-*) ;;
        *)
            pkg_filter="$1"
            shift
            ;;
    esac

    found=0
    for pkg_json in /usr/src/service/shared/*/package.json /usr/src/service/shared/*/*/package.json; do
        [ -f "$pkg_json" ] || continue
        pkg_dir=$(dirname "$pkg_json")
        pkg_label=${pkg_dir#/usr/src/service/shared/}

        if [ -n "$pkg_filter" ]; then
            case "$pkg_label" in
                "$pkg_filter"|"$pkg_filter"/*) ;;
                *) continue ;;
            esac
        fi

        if grep -q '"test:run"' "$pkg_json"; then
            found=1
            echo "==> [shared/$pkg_label] pnpm install"
            (cd "$pkg_dir" && pnpm install)
            echo "==> [shared/$pkg_label] vitest run $*"
            (cd "$pkg_dir" && pnpm exec vitest run "$@")
        fi
    done
    if [ "$found" -eq 0 ]; then
        if [ -n "$pkg_filter" ]; then
            echo "==> [shared] no package matching \"$pkg_filter\" defines a \"test:run\" script" >&2
            exit 1
        fi
        echo "==> [shared] no packages/lixpi/* package defines a \"test:run\" script yet, nothing to run"
    fi
}

case "$domain" in
    api|web-ui|web-ui-user-portal|ai-model-registry|nex|docs-site)
        run_domain "$domain" "$@"
        ;;
    shared)
        run_shared "$@"
        ;;
    all)
        run_domain api
        run_domain web-ui
        run_domain web-ui-user-portal
        run_domain ai-model-registry
        run_domain nex
        run_shared
        ;;
    *)
        echo "Usage: run-tests.sh {api|web-ui|web-ui-user-portal|ai-model-registry|nex|docs-site|shared|all} [vitest args]" >&2
        exit 1
        ;;
esac
