---
title: TypeScript and Stylesheet Linting and Formatting
description: Architecture, enforced syntax rules, and Docker-only commands for the TypeScript quality runner.
---

# TypeScript and Stylesheet Linting and Formatting

The `lixpi-typescript-quality-runner` container owns TypeScript, HTML, Sass, and CSS formatting and linting. It uses Oxfmt for production TypeScript, standalone HTML, and tagged HTML templates; Oxc for TypeScript syntax; parse5 for HTML syntax; dprint with Malva for stylesheet formatting; PostCSS and postcss-value-parser for stylesheet syntax; Oxlint for TypeScript rules and safe fixes; Stylelint for stylesheet rules; and the repository import/export-layout checker for the exact named-specifier matrix. The container has its own dependencies and does not reuse service, package, or test-runner dependencies.

Never run `node`, `npm`, `npx`, `pnpm`, `pnpx`, `dprint`, Oxlint, Stylelint, TypeScript files, package scripts, linters, or formatters on the host. Run every TypeScript and stylesheet quality command through Docker Compose from the repository root.

Every direct quality-runner dependency uses `"*"` in `package.json`. Each invocation resolves the latest available versions with `pnpm install --no-lockfile` inside the isolated tool workspace. The pnpm store and every `node_modules` directory are named Docker volumes; the runner never creates a lockfile, package store, or `node_modules` directory in the host checkout. Rebuild the base image only when its Dockerfile changes:

```bash
docker compose --profile dev --profile main build --no-cache lixpi-typescript-quality-runner
```

## Commands

The quality runner follows the TypeScript test runner's domain shape. Run a service independently:

```bash
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner web-ui validate
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner web-ui-user-portal validate
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner api validate
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner nex validate
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner ai-model-registry validate
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner quality-runner validate
```

Run all shared packages or select one package by its directory name:

```bash
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner shared validate
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner shared canvas-engine validate
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner shared canvas-components format
```

The runner also exposes `docs-site`, `infrastructure`, `random-useful-things`, and `quality-runner` domains. TypeScript rules apply to every TypeScript file, while Sass and CSS rules apply to every first-party stylesheet. Use `all` when a repository-wide change needs every configured domain:

```bash
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner all validate
```

The action is optional and defaults to `validate`.

Domain configuration passes source aliases to the extension runner as `specifierPrefix`, `importerScope`, and `targetDirectory` data. The extension runner resolves the narrowest matching importer scope and contains no service names or application paths. Domains without aliases pass an empty list.

| Action | Behavior |
|--------|----------|
| `validate` | Validates Oxfmt and dprint formatting, Oxlint rules, named-import/export layout, and Stylelint rules. It does not modify source. |
| `fix` | Applies Oxlint fixes, formats production TypeScript and HTML with Oxfmt, formats stylesheets with dprint, fixes named-import/export layout, and applies Stylelint fixes. |
| `format` | Formats production TypeScript and HTML with Oxfmt, formats stylesheets with dprint, and fixes named-import/export layout. |
| `validate-formatting` | Validates Oxfmt, dprint, and named-import/export formatting. It does not modify source. |
| `lint` | Runs Oxlint and Stylelint. |
| `lint-fix` | Applies Oxlint and Stylelint fixes, then formats changed production TypeScript and HTML. |

## TypeScript and HTML formatting contracts

The quality runner treats parser nodes as the only authority for syntax boundaries. Oxc identifies TypeScript declarations, expressions, function parameters, call arguments, tagged-template quasis, and `${...}` interpolation bodies. parse5 identifies elements and attribute locations inside standalone HTML and `html` tagged templates. PostCSS supplies stylesheet declarations, and postcss-value-parser supplies the declaration-value tree used by custom Stylelint rules. Formatter and linter rules must not discover language constructs with regular expressions or raw source-text searches.

Oxfmt provides the baseline layout, but repository rules run through AST-addressed replacements after that baseline. Every pass parses through one shared entry point that holds the most recent result, so a chain of passes that leave the text alone costs one parse rather than one parse each:

- A function, method, constructor or named arrow function with two or more parameters is multiline, and a call or `new` expression with more than two arguments is multiline. An arrow written inline, as a callback or as a branch of an expression, counts with the calls: splitting `(state, dispatch) =>` across lines buys nothing. An arrow bound to a name, by a `const` or a class field, is a function definition and lays out like one. The shared delimited-list formatter puts one item on each line and adds the trailing comma. A single parameter stays on the signature line, and one or two arguments stay on the call line.
- A call or `new` expression also splits when one of its arguments is itself a call, however few arguments it has, and when its own closing parenthesis would land past 150 columns. Width counts the column its opening parenthesis sits on plus its arguments with everything inside them closed up: the opening parenthesis does not move when the list splits, so the answer is the same either way and a call cannot argue with itself from one pass to the next. A call further along a member chain is measured from its own line, not from the head of the chain, so `.attr('height', 32)` is not charged for the calls above it. `new Map([...])` and its siblings are left to Oxlint's collection rule, which lays the elements out inside the array's own brackets.
- A call or signature around a single item whose own braces carry the content keeps those braces on its own line, so it reads `f({` or `method(params: {` and closes on `})`, rather than opening two brackets on two lines for one item. It covers an object or array argument, a destructuring pattern, and a parameter whose type is a type literal, since `params: { ... }` is one item however that type is written. It applies whenever that item spans lines, whether a rule above asked for the split or the source was already written that way, and it wins over every splitting reason above. A list carrying a second item alongside it puts each item on its own line as usual.
- A sole arrow parameter that is a plain name drops its parentheses, so a callback reads `e => {`. A parameter carrying a type, a default, a rest element or a destructuring pattern keeps them, and so does an arrow with a return type or type parameters, because the syntax needs them there. Oxfmt is configured with `arrowParens: avoid` to match.
- A call carrying more than one argument also splits when one of those arguments is an object or array literal that spans lines, since a literal the object rule has already split cannot come back onto one line.
- A call around one plain argument, a name or a literal or a property path made of them, is never split on width. There is no inner structure for a line break to reveal, so `syntaxHighlighting(defaultHighlightStyle)` stays as written however long its line runs.
- A call whose last argument is a function with a block body is not measured against the width limit. That body can never sit on one line, so its own braces are what break the call.
- A callback whose body is an expression rather than a block splits the call as soon as that body spans lines, so it starts on a line of its own and reads as its own block. A block-bodied callback keeps hugging the call, since its braces already do that job.
- The rule runs both ways. A list of one or two items that an earlier layout left split is joined back onto the call or signature line, as long as it is not split for one of the reasons above, every item is already a single line, and the joined line fits. A list holding a multiline item, such as an object literal or an arrow body, stays split. A parameter list written without parentheses, such as `async request =>`, is left alone entirely.
- An argument list that is already split keeps its indentation from the container pass whether or not the delimited-list formatter rewrites it, so a one or two argument call cannot drift. A call whose member chain broke before its property anchors to that property rather than to the start of the chain, so its arguments and closing parenthesis line up under the call's own line.
- Pulling an assigned value back onto its assignment line takes the same indentation level off every line the value spans. Without that the value would come back one level deeper on every run and the format loop would never settle.
- A compact `if`, `while`, or `for` body is always placed on the following indented line. The formatter's final AST condition pass and Oxlint's condition fixer own the closing-parenthesis-to-body boundary, so a containing-node rewrite or overlapping fix cannot reattach `return`, `throw`, `break`, `continue`, or an expression body to the closing parenthesis.
- Block statements and terminal control-flow statements are separated from adjacent siblings by one blank line. The rule covers `if`, loops, `switch`, `try`, `break`, `continue`, `return`, `throw`, and the other configured statement types. It operates only on gaps between AST siblings, so it does not insert a blank line before the first statement or after the last statement in a program, function body, block, static block, TypeScript module block, or switch case.
- Adjacent `case` and `default` clauses use one line break with no blank line between clauses. Statement spacing inside each clause still follows the normal sibling rules.
- A nested conditional expression is rejected. `lixpi/no-nested-ternary` reports a conditional whose test, consequent or alternate holds another one, and it has no fix. It is turned off in [`oxlint.json`](../oxlint.json); set it to `warn` or `error` to switch it on. When it runs: rewrite it as an `if` statement or an early return. When several groups of conditions decide the same value, use a membership test such as `[...].includes(value)`, a lookup object keyed by the value, or a small named helper. One chain is reported once, on its outermost conditional.
- A nested conditional expression that still exists keeps each level visibly nested. Each nested `?` and `:` is indented one level beyond its parent conditional instead of being flattened into the parent branch.
- The formatter never introduces or removes a parenthesis. The only pairs it writes are the ones an `if`, `while`, `for` or `do...while` requires; a pair that looks redundant is left alone because it can carry the meaning of the expression. An operand of a logical chain is copied out of the source exactly as written, on one line or on several, so a parenthesized subgroup keeps the shape its author gave it. The rule decides where the operands of a chain go, never how an operand is laid out inside itself.
- A conditional expression whose test has more than one logical evaluation splits its test across lines and follows it with an indented `?` line and an indented `:` line. The test's first operand stays on the line it already sits on. A test the source parenthesized keeps that pair and indents its operands inside it. The rewrite is bounded by the conditional's own `?` and `:` punctuators and by the test's range, so it cannot swallow half of a parenthesis pair belonging to a surrounding call, a grouping around the whole conditional, or a parenthesized branch.
- An assigned logical expression with more than two evaluations splits the same way: the first operand stays on the assignment line and the rest are indented one level under it.
- A parameter list ending in a rest parameter is split one item per line without a trailing comma, because TypeScript rejects a comma after a rest element. A call's trailing spread argument still takes the trailing comma.
- TypeScript inside an `html` interpolation follows the same control-flow, conditional, argument, and expression rules as TypeScript outside a template. The HTML merge copies only parsed template quasis, so HTML formatting cannot replace an interpolation body with Oxfmt's uncanonicalized TypeScript output.
- An HTML start tag with two or more attributes is multiline, with one attribute per line. This applies to standalone `.html` files and `html` tagged templates, including attributes whose values contain TypeScript interpolations.
- String concatenation is prohibited by Oxlint's `prefer-template` rule. Use template interpolation. `validate` and `lint` reject concatenation even when Oxlint cannot safely fix it; `fix` applies the safe fixes Oxlint provides before the formatter runs.

The formatter preserves deliberately expanded types, arrays, objects, destructuring, expressions, and call chains. Repository canonicalizers may expand a structure when a rule requires it, but Oxfmt must not collapse a structure that the source intentionally expanded.

Run the runner's fixture test after changing its image, scripts, dprint configuration, Oxlint configuration, or Stylelint configuration:

```bash
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner self-test
```

The fixture test proves the named-import matrix, native TypeScript execution, Sass four-space formatting, configured Oxlint violations, configured Stylelint violations, shared transition enforcement, React import rejection, and JSX source-file rejection.

An object literal holding more than one property is split one property to a line, the same way a named import list is. `lixpi/prefer-multiline-object` reports an inline one and its fix expands it, nested literals included. A literal with a single property or none stays inline.

## Named Import And Export Layout

The repository uses Oxfmt plus the quality runner's named-import layout check for production TypeScript. A named import list with two or more items uses one item per line:

```typescript
import {
    applyNodeGeometry,
    type CanvasEngineRect,
} from '@lixpi/canvas-engine/shared'
```

A named import list with one value stays inline:

```typescript
import { applyNodeGeometry } from '@lixpi/canvas-engine/shared'
```

A default import combined with one named value also stays inline:

```typescript
import CanvasEngine, { applyNodeGeometry } from '@lixpi/canvas-engine'
```

Type-only imports also use inline `type` specifiers so adding a future value import changes only the new line:

```typescript
import {
    type CanvasEngineRect,
} from '@lixpi/canvas-engine/shared'
```

Top-level `import type` declarations are rejected by Oxlint.

When a declaration contains both value and type imports, all values come first and all inline `type` specifiers come last. The quality runner's import-order check rejects interleaved groups and its `fix` or `lint-fix` action moves the type specifiers to the end while preserving the order inside each group.

Named exports use the same layout. A single exported item remains inline, while two or more exported items use one item per line. The same rule applies to `export type` declarations:

```typescript
export { createCertificateHelper } from './certificate-helper.ts'

export {
    createLambdaCertificateHelper,
    createLambdaCertificateManager,
} from './lambda-certificate-manager.ts'

export type {
    LambdaCertificateManagerArgs,
    LambdaCertificateManagerResult,
} from './lambda-certificate-manager.ts'
```

## Sass and CSS Rules

dprint's Malva plugin formats first-party `.scss` and `.css` files with four spaces and the repository's shared formatting settings. Stylelint parses both formats through `postcss-scss` and enforces these parts of [`SASS-AND-CSS.md`](../../../documentation/coding-style-guides/SASS-AND-CSS.md):

- Lixpi-owned classes use flat kebab-case names. BEM `__` and `--` punctuation, underscores, camelCase, and PascalCase are rejected. Explicit external contracts are exempt without weakening the application-class pattern: ProseMirror's classes, and CodeMirror's `cm-` set, which a stylesheet can only match because the editor renders those names itself.
- CSS custom properties use kebab-case.
- Nesting is limited to three levels. Blockless at-rules and nested pseudo-class qualifications do not consume the limit.
- Component transition values must use `hoverTransition`, `standardTransition`, `pupOutTransition`, `overlayVisibilityTransition`, `panelSlideTransition`, or a custom property populated by one of those helpers. Raw transition durations, timing functions, and mixed helper/raw lists are rejected. The shared transition implementation file is the only rule exception.
- Duplicate selectors, declarations, custom properties, Sass variables, Sass loads, Sass mixins, invalid properties, invalid units, invalid selectors, malformed calculations, invalid hex colors, and other deterministic CSS errors fail linting.

Style ownership, shared tooltip selection, external-contract classification, and selector/DOM lockstep still require code review because a stylesheet parser cannot determine those contracts safely.

When a Sass import changes the AI model registry's build graph, verify its standalone image as well as the quality runner:

```bash
docker compose --profile dev --profile main build lixpi-ai-model-registry
```

## Container and Cache Model

[`docker-compose.typescript-quality-runner.yml`](../../../docker-compose.typescript-quality-runner.yml) defines a separate one-shot service. Its command dispatcher mirrors the test runner, so a normal edit checks or formats only the selected service or package. Source paths are mounted selectively under `/usr/src/repository`; the repository root and package manifests are never bind-mounted there. Tool manifests, scripts, configuration, and wrappers are mounted separately under `/usr/src/quality-runner`, while tool dependencies use named Docker volumes. This prevents pnpm from writing installation artifacts into the host checkout.

dprint uses the `typescript-quality-runner-dprint-cache` volume for its compiled plugins and incremental file-state cache. pnpm uses `typescript-quality-runner-pnpm-store`, and both the tool workspace and its local debug-tools workspace have dedicated `node_modules` volumes. Oxlint and Stylelint receive only the selected domain paths. The formatter, import/export, Oxlint-plugin, and Stylelint wrappers are erasable TypeScript files executed directly by Node 24's stable type stripping; there is no generated JavaScript copy.

All linter and formatter configuration lives beside this documentation: [`oxfmt.json`](../oxfmt.json), [`dprint.json`](../dprint.json), [`oxlint.json`](../oxlint.json), and [`stylelint.config.ts`](../stylelint.config.ts). The wildcard package manifest is resolved without a lockfile on every invocation. There is no TypeScript build step and the tools do not emit JavaScript.

Warnings name code to rewrite without failing a run, so Oxlint is invoked without `--deny-warnings`. A fix round that changes no file ends the fix loop, so findings no fixer can resolve, such as a nested conditional, are reported once instead of retried until the attempt limit runs out.

Oxlint starts from an explicit rule baseline so adopting the runner does not silently turn unrelated existing findings into repository-wide failures. The quality runner rejects JavaScript and JSX source files, React imports, `debugger`, top-level `import type`, file imports without their TypeScript extension, duplicate module imports, CommonJS imports, `interface` declarations outside ambient `.d.ts` files, plain function declarations, unnecessary arrow-body blocks, expression-bodied arrows longer than 150 characters whose body remains on the signature line, unnecessary braces around simple `if` bodies, `if` conditions with more than two logical evaluations that remain inline, simple brace-less `if` bodies that are not on the following indented line, comma-separated declarations and sequence expressions, semicolons that are not ASI guards, inline object destructuring with multiple properties, inline multi-value Map/Set-style initializers, inline multi-attribute D3/SVG chains, string concatenation, legacy own-property checks, JSON serialization used as a deep-clone substitute, restricted HTTP client packages, restricted raw DOM construction in web-ui implementation files, and native console logging outside frontend code and the debug-tools implementation. Named exports follow the same one-versus-many layout as named imports. Fix actions migrate JavaScript source files to TypeScript, remove unused imports without deleting unused local variables, and replace native backend console calls with `@lixpi/debug-tools` imports and calls.

The `lixpi/require-ast-formatter-rules` guard runs against every TypeScript implementation file in this service. It rejects regular expressions and raw source-string syntax searches so formatter and linter changes cannot bypass the parser boundary.

## GitHub Actions

The `CI` workflow runs the quality-runner self-test and every configured quality domain as independent matrix jobs. Each job builds and invokes `lixpi-typescript-quality-runner` through `docker-compose.typescript-quality-runner.yml`, so dprint, Oxlint, Stylelint, and the repository validation scripts never run on the GitHub host.

CI points Compose at the one-shot runner file directly. This keeps the same image, bind mounts, dispatcher, and domain commands used locally without parsing the unrelated application and deployment services from the root Compose graph. The matrix feeds one stable `Required CI gate` status after every quality and test job passes.
