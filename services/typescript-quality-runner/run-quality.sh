#!/bin/sh

# This is the container entry point for every TypeScript, HTML, Sass, and CSS quality mode.
# It maps repository domains to files and runs only the tools relevant to each action.
set -eu

repository_dir="/usr/src/repository"
tool_dir="/usr/src/quality-runner"
runner_dir="$tool_dir"
dprint_bin="$tool_dir/node_modules/.bin/dprint"
oxlint_bin="$tool_dir/node_modules/.bin/oxlint"
source_extension_runner="$tool_dir/source-extension-runner.ts"
typescript_format_runner="$tool_dir/typescript-format-runner.ts"
stylelint_runner="$tool_dir/stylelint-runner.ts"
dprint_config="$tool_dir/dprint.json"
oxlint_config="$repository_dir/.oxlintrc.json"

cd "$tool_dir"
# Dependencies live in the disposable runner container and reuse the mounted pnpm store.
pnpm install --store-dir /pnpm-store --no-lockfile

# Keep action parsing in one place so domain and shared-package dispatch accept the same set.
is_action() {
    case "$1" in
        validate|fix|lint|lint-fix|format|validate-formatting) return 0 ;;
        *) return 1 ;;
    esac
}

# Checksum of every file a fix round can touch, so a round that changes nothing ends the
# loop instead of burning the remaining attempts on findings no fixer can resolve.
source_fingerprint() {
    find "$@" -type f -exec cksum {} + 2>/dev/null | sort | cksum
}

# Oxlint and the custom formatter can expose work for each other. Iterate until both agree,
# stop when the source no longer changes, and then print the remaining actionable errors.
# Warnings do not fail the convergence check because advisory rules must not block a fix.
run_oxlint_fixes() {
    attempt=1
    while [ "$attempt" -le 5 ]; do
        fingerprint=$(source_fingerprint "$@")
        "$oxlint_bin" --config "$oxlint_config" --no-error-on-unmatched-pattern --threads=1 --fix --silent "$@" || true
        node "$typescript_format_runner" fix "$@"
        if "$oxlint_bin" --config "$oxlint_config" --no-error-on-unmatched-pattern --silent "$@" \
            && node "$typescript_format_runner" check "$@"; then
            return 0
        fi

        if [ "$(source_fingerprint "$@")" = "$fingerprint" ]; then
            break
        fi

        attempt=$((attempt + 1))
    done

    "$oxlint_bin" --config "$oxlint_config" --no-error-on-unmatched-pattern "$@"
    node "$typescript_format_runner" check "$@"
}

# Compose extension checks, formatting, Oxlint, and Stylelint according to the requested
# action. Keeping this matrix here makes every domain use identical tool semantics.
run_action() {
    action="$1"
    source_extension_aliases="$2"
    shift 2

    case "$action" in
        validate)
            node "$source_extension_runner" check --aliases "$source_extension_aliases" -- "$@"
            node "$typescript_format_runner" check "$@"
            "$dprint_bin" check --allow-no-files --config "$dprint_config" "$@"
            "$oxlint_bin" --config "$oxlint_config" --no-error-on-unmatched-pattern "$@"
            node "$stylelint_runner" check "$@"
            ;;
        fix)
            node "$source_extension_runner" fix --aliases "$source_extension_aliases" -- "$@"
            run_oxlint_fixes "$@"
            "$dprint_bin" fmt --allow-no-files --config "$dprint_config" "$@"
            node "$stylelint_runner" fix "$@"
            ;;
        lint)
            node "$source_extension_runner" check --aliases "$source_extension_aliases" -- "$@"
            "$oxlint_bin" --config "$oxlint_config" --no-error-on-unmatched-pattern "$@"
            node "$stylelint_runner" check "$@"
            ;;
        lint-fix)
            node "$source_extension_runner" fix --aliases "$source_extension_aliases" -- "$@"
            run_oxlint_fixes "$@"
            node "$stylelint_runner" fix "$@"
            ;;
        format)
            node "$source_extension_runner" fix --aliases "$source_extension_aliases" -- "$@"
            node "$typescript_format_runner" fix "$@"
            "$dprint_bin" fmt --allow-no-files --config "$dprint_config" "$@"
            ;;
        validate-formatting)
            node "$source_extension_runner" check --aliases "$source_extension_aliases" -- "$@"
            node "$typescript_format_runner" check "$@"
            "$dprint_bin" check --allow-no-files --config "$dprint_config" "$@"
            ;;
        *)
            echo "Unknown action: $action" >&2
            exit 1
            ;;
    esac
}

# Resolve an optional shared-package filter into explicit package paths. Explicit paths
# avoid scanning vendored or unrelated workspaces during a targeted quality run.
run_shared() {
    package_filter=""
    action="validate"

    if [ "$#" -gt 0 ] && is_action "$1"; then
        action="$1"
        shift
    elif [ "$#" -gt 0 ]; then
        package_filter="$1"
        shift
        if [ "$#" -gt 0 ]; then
            action="$1"
            shift
        fi
    fi

    if [ "$#" -gt 0 ]; then
        echo "Unexpected shared arguments: $*" >&2
        exit 1
    fi

    selected_paths=""
    for package_path in \
        auth-service \
        capability-system \
        canvas-engine \
        canvas-components \
        canvas-components-lixpi-specific \
        constants/ts \
        debug-tools/ts \
        dynamodb-service \
        nats-auth-callout-service \
        nats-service/ts \
        prosemirror \
        test-utils \
        ui-kit \
        ui-kit-gentelella \
        ui-primitives \
        auth-client \
        web-client-service-factory \
        usage-reporter
    do
        package_name=${package_path%%/*}
        if [ -n "$package_filter" ] && [ "$package_filter" != "$package_name" ] && [ "$package_filter" != "$package_path" ]; then
            continue
        fi
        selected_paths="$selected_paths packages/lixpi/$package_path"
    done

    if [ -z "$selected_paths" ]; then
        echo "No shared package matches: $package_filter" >&2
        exit 1
    fi

    run_action "$action" '[]' $selected_paths
}

# Domain aliases are the stable command-line API used by Docker Compose and developer docs.
# Each alias expands to the source roots and configuration files that belong to that domain.
run_domain() {
    domain="$1"
    action="${2:-validate}"

    case "$domain" in
        web-ui)
            run_action "$action" '[{"specifierPrefix":"$src","importerScope":"services/web-ui","targetDirectory":"services/web-ui/src"}]' services/web-ui/index.html services/web-ui/src services/web-ui/vite.config.ts services/web-ui/vitest.config.ts
            ;;
        web-ui-user-portal)
            run_action "$action" '[{"specifierPrefix":"$src","importerScope":"services/web-ui-user-portal","targetDirectory":"services/web-ui-user-portal/src"}]' services/web-ui-user-portal/index.html services/web-ui-user-portal/src services/web-ui-user-portal/vite.config.ts services/web-ui-user-portal/vitest.config.ts
            ;;
        api)
            run_action "$action" '[]' services/api/src services/api/vitest.config.ts
            ;;
        nex)
            run_action "$action" '[]' services/nex/workloads services/nex/vitest.config.ts
            ;;
        ai-model-registry)
            run_action "$action" '[{"specifierPrefix":"$src","importerScope":"services/ai-model-registry","targetDirectory":"services/ai-model-registry/src/client"}]' services/ai-model-registry/src services/ai-model-registry/vite.config.ts services/ai-model-registry/vitest.config.ts
            ;;
        docs-site)
            run_action "$action" '[]' documentation/site/assets
            ;;
        infrastructure)
            run_action "$action" '[]' infrastructure/init-script/setup-env.ts infrastructure/pulumi/src
            ;;
        random-useful-things)
            run_action "$action" '[]' random-useful-things
            ;;
        quality-runner)
            run_action "$action" '[]' \
                "$tool_dir/import-specifier-order.ts" \
                "$tool_dir/lixpi-oxlint-plugin.ts" \
                "$tool_dir/source-extension-runner.ts" \
                "$tool_dir/stylelint.config.ts" \
                "$tool_dir/stylelint-lixpi-plugin.ts" \
                "$tool_dir/stylelint-runner.ts" \
                "$tool_dir/typescript-format-runner.ts"
            ;;
        *)
            echo "Unknown domain: $domain" >&2
            exit 1
            ;;
    esac
}

# The all target spells out every supported source root so ignored workspaces cannot enter
# the quality boundary accidentally through a broad repository glob.
run_all() {
    action="${1:-validate}"
    run_action "$action" '[{"specifierPrefix":"$src","importerScope":"services/web-ui","targetDirectory":"services/web-ui/src"},{"specifierPrefix":"$src","importerScope":"services/web-ui-user-portal","targetDirectory":"services/web-ui-user-portal/src"},{"specifierPrefix":"$src","importerScope":"services/ai-model-registry","targetDirectory":"services/ai-model-registry/src/client"}]' \
        services/web-ui/src \
        services/web-ui/index.html \
        services/web-ui/vite.config.ts \
        services/web-ui/vitest.config.ts \
        services/web-ui-user-portal/src \
        services/web-ui-user-portal/index.html \
        services/web-ui-user-portal/vite.config.ts \
        services/web-ui-user-portal/vitest.config.ts \
        services/api/src \
        services/api/vitest.config.ts \
        services/nex/workloads \
        services/nex/vitest.config.ts \
        services/ai-model-registry/src \
        services/ai-model-registry/vite.config.ts \
        services/ai-model-registry/vitest.config.ts \
        documentation/site/assets \
        infrastructure/init-script/setup-env.ts \
        infrastructure/pulumi/src \
        random-useful-things \
        "$tool_dir/import-specifier-order.ts" \
        "$tool_dir/lixpi-oxlint-plugin.ts" \
        "$tool_dir/source-extension-runner.ts" \
        "$tool_dir/stylelint.config.ts" \
        "$tool_dir/stylelint-lixpi-plugin.ts" \
        "$tool_dir/stylelint-runner.ts" \
        "$tool_dir/typescript-format-runner.ts" \
        packages/lixpi/auth-service \
        packages/lixpi/capability-system \
        packages/lixpi/canvas-engine \
        packages/lixpi/canvas-components \
        packages/lixpi/canvas-components-lixpi-specific \
        packages/lixpi/constants/ts \
        packages/lixpi/debug-tools/ts \
        packages/lixpi/dynamodb-service \
        packages/lixpi/nats-auth-callout-service \
        packages/lixpi/nats-service/ts \
        packages/lixpi/prosemirror \
        packages/lixpi/test-utils \
        packages/lixpi/ui-kit \
        packages/lixpi/ui-kit-gentelella \
        packages/lixpi/ui-primitives \
        packages/lixpi/auth-client \
        packages/lixpi/web-client-service-factory \
        packages/lixpi/usage-reporter
}

cd "$repository_dir"

# Dispatch after changing to the repository because all domain paths above are relative to
# that root. The self-test remains a separate explicit action from normal validation.
domain="${1:-}"
if [ -z "$domain" ]; then
    echo "Usage: run-quality.sh {web-ui|web-ui-user-portal|api|nex|ai-model-registry|docs-site|infrastructure|random-useful-things|quality-runner|shared|all|self-test} [package] [validate|fix|lint|lint-fix|format|validate-formatting]" >&2
    exit 1
fi
shift

case "$domain" in
    shared)
        run_shared "$@"
        ;;
    all)
        run_all "${1:-validate}"
        ;;
    self-test)
        sh "$runner_dir/test-quality.sh"
        ;;
    web-ui|web-ui-user-portal|api|nex|ai-model-registry|docs-site|infrastructure|random-useful-things|quality-runner)
        run_domain "$domain" "${1:-validate}"
        ;;
    *)
        echo "Unknown domain: $domain" >&2
        exit 1
        ;;
esac
