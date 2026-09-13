#!/bin/sh

# This fixture suite exercises the container's public check and fix commands against known
# valid and invalid sources. Every mutation happens in a disposable directory.
set -eu

repository_dir="/usr/src/repository"
tool_dir="/usr/src/quality-runner"
runner_dir="$tool_dir"
dprint_bin="$tool_dir/node_modules/.bin/dprint"
oxlint_bin="$tool_dir/node_modules/.bin/oxlint"
import_order_checker="$runner_dir/import-specifier-order.ts"
source_extension_runner="$runner_dir/source-extension-runner.ts"
typescript_format_runner="$runner_dir/typescript-format-runner.ts"
stylelint_runner="$tool_dir/stylelint-runner.ts"
# dprint formats stylesheets only. TypeScript goes through the Oxfmt-backed formatter, so a
# TypeScript path passed to dprint intentionally matches no plugin.
dprint_config="$tool_dir/dprint.json"
oxlint_config="$repository_dir/.oxlintrc.json"
fixture_dir="$runner_dir/fixtures"
temporary_dir=$(mktemp -d)

# Always remove copied and fixed fixtures, including when an expected failure does not occur.
cleanup() {
    rm -rf "$temporary_dir"
}
trap cleanup EXIT

# Prove that invalid import layout fails, fixes to the exact expected text, then passes both
# the formatter and the dedicated import-order checker without another change.
cp "$fixture_dir/import-layout-input.txt" "$temporary_dir/import-layout.ts"
if node "$typescript_format_runner" check "$temporary_dir/import-layout.ts" >/dev/null 2>&1 \
    && node "$import_order_checker" check "$temporary_dir/import-layout.ts" >/dev/null 2>&1; then
    echo "Expected the composite formatter to reject the invalid import fixture" >&2
    exit 1
fi

node "$typescript_format_runner" fix "$temporary_dir/import-layout.ts" >/dev/null
node "$import_order_checker" fix "$temporary_dir/import-layout.ts" >/dev/null
if ! cmp -s "$fixture_dir/import-layout-expected.txt" "$temporary_dir/import-layout.ts"; then
    echo "The TypeScript formatter did not produce the expected multiline import layout" >&2
    diff -u "$fixture_dir/import-layout-expected.txt" "$temporary_dir/import-layout.ts" >&2 || true
    exit 1
fi

node "$typescript_format_runner" check "$temporary_dir/import-layout.ts" >/dev/null
node "$import_order_checker" check "$temporary_dir/import-layout.ts" >/dev/null

# Exercise the complete Oxlint rule set with one negative fixture and one accepted fixture.
cp "$fixture_dir/lint-invalid.txt" "$temporary_dir/lint-invalid.ts"
if "$oxlint_bin" --config "$oxlint_config" "$temporary_dir/lint-invalid.ts" >/dev/null 2>&1; then
    echo "Expected Oxlint to reject the invalid lint fixture" >&2
    exit 1
fi

cp "$fixture_dir/lint-valid.txt" "$temporary_dir/lint-valid.ts"
"$oxlint_bin" --config "$oxlint_config" "$temporary_dir/lint-valid.ts" >/dev/null

# Top-level `import type` must fail while the equivalent inline type specifier remains valid.
cp "$fixture_dir/type-import-invalid.txt" "$temporary_dir/type-import-invalid.ts"
if "$oxlint_bin" --config "$oxlint_config" "$temporary_dir/type-import-invalid.ts" >/dev/null 2>&1; then
    echo "Expected Oxlint to reject a top-level type import" >&2
    exit 1
fi

cp "$fixture_dir/type-import-valid.txt" "$temporary_dir/type-import-valid.ts"
"$oxlint_bin" --config "$oxlint_config" "$temporary_dir/type-import-valid.ts" >/dev/null

# The import fixer must keep value specifiers first and move type specifiers behind them.
cp "$fixture_dir/type-import-order-invalid.txt" "$temporary_dir/type-import-order.ts"
if node "$import_order_checker" check "$temporary_dir/type-import-order.ts" >/dev/null 2>&1; then
    echo "Expected the import-order checker to reject interleaved type imports" >&2
    exit 1
fi

node "$import_order_checker" fix "$temporary_dir/type-import-order.ts" >/dev/null
if ! cmp -s "$fixture_dir/type-import-order-valid.txt" "$temporary_dir/type-import-order.ts"; then
    echo "Import-order fix did not place type imports last" >&2
    diff -u "$fixture_dir/type-import-order-valid.txt" "$temporary_dir/type-import-order.ts" >&2 || true
    exit 1
fi
node "$import_order_checker" check "$temporary_dir/type-import-order.ts" >/dev/null

# Alias resolution is supplied as data. Repeated aliases with the same specifier use the
# narrowest importer scope, so the generic extension runner never needs application paths.
source_extension_project="$temporary_dir/source-extension-project"
mkdir -p "$source_extension_project/client/src" "$source_extension_project/shared"
cp "$fixture_dir/source-extension-alias-importer.txt" "$source_extension_project/client/src/importer.ts"
cp "$fixture_dir/source-extension-alias-module.txt" "$source_extension_project/client/src/value.js"
source_extension_aliases="[{\"specifierPrefix\":\"\$src\",\"importerScope\":\"$source_extension_project\",\"targetDirectory\":\"$source_extension_project/shared\"},{\"specifierPrefix\":\"\$src\",\"importerScope\":\"$source_extension_project/client\",\"targetDirectory\":\"$source_extension_project/client/src\"}]"
node "$source_extension_runner" fix --aliases "$source_extension_aliases" -- "$source_extension_project" >/dev/null
if [ ! -f "$source_extension_project/client/src/value.ts" ] \
    || [ -f "$source_extension_project/client/src/value.js" ] \
    || ! grep -F 'from "$src/value.ts"' "$source_extension_project/client/src/importer.ts" >/dev/null; then
    echo "The source extension runner did not use the configured importer scope and alias target" >&2
    exit 1
fi
node "$source_extension_runner" check --aliases "$source_extension_aliases" -- "$source_extension_project" >/dev/null

# Both JSX-bearing source extensions are rejected before any TypeScript formatting begins.
touch "$temporary_dir/react-component.tsx"
if node "$import_order_checker" check "$temporary_dir" >/dev/null 2>&1; then
    echo "Expected the quality runner to reject a .tsx file" >&2
    exit 1
fi
rm "$temporary_dir/react-component.tsx"

touch "$temporary_dir/react-component.jsx"
if node "$import_order_checker" check "$temporary_dir" >/dev/null 2>&1; then
    echo "Expected the quality runner to reject a .jsx file" >&2
    exit 1
fi

# A React import in a `.ts` file is rejected separately from the extension checks above.
cp "$fixture_dir/react-import-invalid.txt" "$temporary_dir/react-import-invalid.ts"
if "$oxlint_bin" --config "$oxlint_config" "$temporary_dir/react-import-invalid.ts" >/dev/null 2>&1; then
    echo "Expected Oxlint to reject a React import" >&2
    exit 1
fi

# Sass formatting must reject the input, produce the checked-in expected output, and remain
# stable when checked again.
cp "$fixture_dir/sass-format-input.txt" "$temporary_dir/sass-format.scss"
if "$dprint_bin" check --config "$dprint_config" "$temporary_dir/sass-format.scss" >/dev/null 2>&1; then
    echo "Expected dprint to reject the invalid Sass formatting fixture" >&2
    exit 1
fi

"$dprint_bin" fmt --config "$dprint_config" "$temporary_dir/sass-format.scss" >/dev/null
if ! cmp -s "$fixture_dir/sass-format-expected.txt" "$temporary_dir/sass-format.scss"; then
    echo "dprint did not produce the expected Sass formatting" >&2
    diff -u "$fixture_dir/sass-format-expected.txt" "$temporary_dir/sass-format.scss" >&2 || true
    exit 1
fi
"$dprint_bin" check --config "$dprint_config" "$temporary_dir/sass-format.scss" >/dev/null

# Stylelint's invalid fixture covers naming, transition, nesting, and syntax rules; the valid
# fixture proves those rules accept the repository's intended Sass forms.
cp "$fixture_dir/sass-lint-invalid.txt" "$temporary_dir/sass-lint-invalid.scss"
if node "$stylelint_runner" check "$temporary_dir/sass-lint-invalid.scss" >/dev/null 2>&1; then
    echo "Expected Stylelint to reject invalid Sass naming, transitions, nesting, and syntax" >&2
    exit 1
fi

cp "$fixture_dir/sass-lint-valid.txt" "$temporary_dir/sass-lint-valid.scss"
node "$stylelint_runner" check "$temporary_dir/sass-lint-valid.scss" >/dev/null

echo "TypeScript and stylesheet quality runner self-test passed"
