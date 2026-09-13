# TypeScript Coding Style Guide

This guide applies to every TypeScript file in the repository — `services/api`, `services/nex`, `services/web-ui`, `packages/lixpi`, `infrastructure/pulumi`, and scripts. The [DOM Templating](#dom-templating-web-ui) section is the only web-ui-specific part.

Use `.ts` files only. JavaScript source files, TSX, JSX, and React are prohibited in this repository. The TypeScript quality runner migrates `.js`, `.mjs`, and `.cjs` source files to `.ts` during a fix pass and rejects them during validation. It rejects `.tsx` and `.jsx` files and React imports.

## Imports And Exports

- Always use `.ts` extension when importing files — never `.js`. Oxlint enforces file import extensions through the Dockerized [TypeScript quality runner](../../services/typescript-quality-runner/documentation/TYPESCRIPT-QUALITY.md).
- A named import list with two or more items must be multiline, with one imported item per line. A single value import stays inline. A single inline `type` import remains multiline. Oxfmt and the TypeScript quality runner enforce this layout.
- Named exports use the same layout: two or more exported items are multiline with one item per line, while a single exported item stays inline. This applies to both value exports and `export type` declarations.
- Always use inline `type` specifiers. Do not use top-level `import type`. This keeps type-only imports ready to accept value imports without rewriting the whole declaration. Oxlint enforces `import/consistent-type-specifier-style: "prefer-inline"`.
- Within a named import list, place every value import first and every inline `type` import last. Do not interleave the two groups. The TypeScript quality runner enforces and fixes this order.
- Combine type and value imports in a single import block:

```typescript
import {
    createJwtVerifier,
    type JwtVerificationResult,
} from '@lixpi/auth-service'
```

Type-only imports use the same declaration shape:

```typescript
import {
    type JwtVerificationResult,
} from '@lixpi/auth-service'
```

A single value import, including an aliased import, stays inline:

```typescript
import { v4 as uuidv4 } from 'uuid'
```

Named exports follow the same one-versus-many layout:

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

## Type Definitions

- Use `type` instead of `interface` for all type definitions. Oxlint enforces this in implementation files. Ambient `.d.ts` declarations are exempt because TypeScript declaration merging can require `interface`.

```typescript
// Correct
type UserProfile = {
    id: string
    name: string
}

// Wrong — do not use interface
interface UserProfile {
    id: string
    name: string
}
```

## Classes And State Ownership

- Prefer classes by default. If a TypeScript module owns cohesive behavior, state, DOM references, lifecycle cleanup, listeners, layout/positioning logic, subscriptions, timers, or a public imperative API, it **must** be a class.
- If you are unsure whether a module is "simple enough" for plain functions, use a class. Plain functions are the exception, not the default.
- Do not hide component, controller, service, manager, menu, switch, tooltip/popover, editor, canvas-control, or other stateful behavior inside a closure-backed factory. A factory can stay as the public entry point, but it must return a class instance for these module types:
  ```typescript
  import { html } from '@lixpi/ui-primitives/dom'

  export type ExampleWidgetConfig = {
      label: string
  }

  export type ExampleWidgetInstance = {
      dom: HTMLElement
      destroy: () => void
  }

  class ExampleWidget implements ExampleWidgetInstance {
      readonly dom: HTMLElement

      constructor(private readonly config: ExampleWidgetConfig) {
          this.dom = this.render()
      }

      private render(): HTMLElement {
          return html`<div className="example-widget">${this.config.label}</div>` as HTMLDivElement
      }

      destroy(): void {
          this.dom.remove()
      }
  }

  export const createExampleWidget = (config: ExampleWidgetConfig): ExampleWidgetInstance =>
      new ExampleWidget(config)
  ```
- Plain functions are only appropriate for pure utilities, tiny adapters, simple callbacks, small mappers, and glue code where a class would clearly add ceremony without improving ownership. If the code needs private state, cleanup, lifecycle, callbacks retained across calls, DOM references, or an imperative instance API, it is no longer a tiny function.
- Reusable UI components, controllers, services, managers, menu primitives, tooltip/popover primitives, canvas controls, SVG controls, editor plugins/views, and other imperative instances must use a class-backed implementation. Do not implement these as closure-backed factories.
- Prefer composition over inheritance. Do not build inheritance chains deeper than 3 levels; inheritance deeper than 3 levels is a deal breaker and must be redesigned.
- Keep config, event payloads, and other object shapes as `type` definitions, not `interface`.

## Functions And Control Flow

- Use arrow functions instead of plain function declarations. Export a `const` when the function is part of a module's public API.
- Remove braces and `return` from an arrow function whose body is one expression. The same rule applies to arrow-function class fields.
- When an expression-bodied arrow function would exceed 150 characters on one line, keep the signature and `=>` on the first line and move the intact body expression to the following indented line. Do not split the expression itself.
- Keep blocks around multi-statement, branching, or otherwise complex function bodies.
- A function, method, constructor, arrow function, call, or `new` expression with two or more parameters or arguments is multiline, with one item per line and a trailing comma. The same formatter entry point owns declarations and invocations so these layouts cannot drift.
- Keep an `if` condition with no more than two logical evaluations on the `if` line. Split a condition with more than two logical evaluations across lines, with each top-level operand on its own indented line. Remove braces from an `if` body when it contains one simple single-line statement and place that statement on the following indented line. `else` begins on the following line when both branches are compact.
- Keep each level of a nested conditional expression visibly nested. Indent a nested `?` and `:` one level beyond its parent conditional. Do not flatten multiple conditional levels into one operator column or add parentheses that erase the indentation hierarchy.
- Declare or assign each value in a separate statement. Comma-separated variable declarations and comma sequence expressions are prohibited.
- Preserve deliberately expanded function parameters, function arguments, types, arrays, objects, logical expressions, conditional expressions, and method chains. Formatting must not flatten those structures just because they fit under the print width.
- Use object spread instead of `Object.assign`. Merge into a variable or property with `target = { ...target, ...source }`. The TypeScript quality runner's `lixpi/no-object-assign` rule rewrites convertible calls and rejects the rest. Writing onto an element's `style` with `Object.assign` is allowed.
- Object destructuring with more than one property is multiline, with one property per line.
- `Map`, `Set`, `WeakMap`, and `WeakSet` initializers with more than one value are multiline, with one value per line. Any other collection that is already expanded stays expanded.
- A D3 or SVG chain with more than one `.attr()` call is multiline, with one chained call per line.
- Do not use semicolons. A leading semicolon is required before an IIFE or another statement-continuation expression when automatic semicolon insertion would attach it to the previous statement.
- Remove unused imports. The TypeScript quality runner's fix actions remove them automatically without deleting unused local variables.
- Outside frontend code, use `log`, `info`, `infoStr`, `warn`, and `err` from `@lixpi/debug-tools` instead of native `console.log`, `console.info`, `console.warn`, or `console.error`. The quality runner rewrites native backend logging calls and adds the required imports automatically.

```typescript
const isMediaNode = (node: CanvasNode | undefined): boolean =>
    node?.type === 'image' || node?.type === 'video'

private releasePanZoomForNodePointer = (): void =>
    this.nodeGestures.releasePanLock()

if (!currentState)
    return

if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
)
    return null

const source = byId.get(edge.sourceNodeId)
const target = byId.get(edge.targetNodeId)

const {
    repository,
    image,
} = buildDockerImage(options)

const transitionHelpers = new Set([
    'hoverTransition',
    'standardTransition',
])

const value = resolveValue()
;(() => initialize(value))()
```

## Comments

- Always use `//` single-line comments. For multi-line explanations, use multiple `//` lines.
- Never use `/** */` or `/* */` block comments anywhere in the codebase.

```typescript
// Correct — single-line
// This function handles token refresh by redirecting
// through the browser-based login flow.

// Wrong — never use block comments
/** This function handles token refresh. */
/* This function handles token refresh. */
```

## Docker

Every service runs inside its own Docker container. All commands (tests, builds, linters, etc.) must be executed inside the relevant container using `docker exec`. Never run service commands on the host machine.

## Modern JavaScript / ES Modules

All projects use `"type": "module"` and target the latest ECMAScript releases. Always use modern language features — never legacy patterns.

### Async / Await

Always use `async`/`await`. Never use `.then()` / `.catch()` chains.

```typescript
// Correct
const data = await fetchData()

// Wrong — never use .then()
fetchData().then((data) => { ... })
```

### DOM Templating (web-ui)

**This rule is mandatory. No exceptions outside of test files.**

Oxfmt formats HTML files and HTML inside tagged TypeScript templates. Nested interpolations stay indented relative to their surrounding HTML instead of being aligned as ordinary TypeScript expressions.

TypeScript inside `${...}` follows every normal TypeScript rule, including control-flow, function argument, logical-expression, and conditional-expression layout. HTML formatting must not replace or bypass the formatted TypeScript interpolation body.

An HTML start tag with two or more attributes is multiline, with one attribute per line. This applies to standalone HTML and `html` tagged templates, including attributes with interpolated values.

In all `services/web-ui` `.ts` files that create DOM elements — ProseMirror plugins and NodeViews, shared components, canvas code (`WorkspaceCanvas.ts`, utilities, etc.), and any other file that builds UI — always use the `html` tagged template from `@lixpi/ui-primitives/dom`:

```typescript
import { html } from '@lixpi/ui-primitives/dom'

const el = html`
    <div className="my-component" onclick=${handleClick}>
        <span innerHTML=${someIcon}></span>
        <span>Label</span>
    </div>
` as HTMLDivElement
```

**Never use `document.createElement` in these files.** Also forbidden: `Object.assign(el.style, ...)`, `el.className = ...`, `el.setAttribute(...)`. The `html` helper produces real DOM nodes (no VDOM) and handles:

- `className` — sets `element.className`
- `innerHTML` — sets `element.innerHTML`
- `style` — object of camelCase CSS properties passed as a variable reference: `style=${styleObj}`. **Never inline the object literal directly in the template.** Always declare a named variable first:
  ```ts
  // CORRECT
  const railStyle = { position: 'absolute' as const, width: `${WIDTH}px`, zIndex: '9990' }
  const el = html`<div className="my-rail" style=${railStyle}></div>` as HTMLDivElement

  // WRONG — do not do this
  const el = html`<div className="my-rail" style=${{ position: 'absolute', width: `${WIDTH}px`, zIndex: '9990' }}></div>` as HTMLDivElement
  ```
  The only acceptable exception is a single trivial property where the intent is self-evident: `style=${{ display: 'none' }}`.
- `data` — object of dataset values (e.g. `data=${{ nodeId: id }}`)
- `on*` — event handlers (e.g. `onclick=${handler}`)

CSS custom properties (`--foo`) cannot be set via the `style` object — use `.style.setProperty('--foo', value)` on the element after creation. That is fine.

To apply multiple style properties to an **existing** element, use `applyStyle` from `@lixpi/ui-primitives/dom` — never set properties one line at a time:
```ts
import { applyStyle } from '@lixpi/ui-primitives/dom'

// CORRECT
applyStyle(el, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })

// WRONG — do not do this
el.style.left = `${x}px`
el.style.top = `${y}px`
el.style.width = `${w}px`
el.style.height = `${h}px`
```
Single-property assignments (`el.style.display = 'none'`) are still fine.

For SVG icons, import them from `@lixpi/ui-kit/svg` and inject via `innerHTML` — never inline SVG markup in component code.

Never create native browser hover tooltips with a `title` attribute, `element.title`, `setAttribute('title', ...)`, or SVG `<title>`. Visible hover or focus help must go through `@lixpi/ui-kit/components/help-tooltip`. Simple controls keep their ARIA text and opt into the shared provider with `data-help-tooltip="aria-label"` or `data-help-tooltip="aria-description"`; rich content uses `createHelpTooltip()`. Use ARIA naming or description attributes without the tooltip marker when the text is only for assistive technology. Document `<title>` metadata and semantic application fields named `title` are not covered by this prohibition.

The only exception is test files (`*.test.ts`) where minimal DOM setup for mocking is acceptable.

### Prefer Modern APIs Over Legacy Alternatives

| Use | Instead of |
|-----|------------|
| `async` / `await` | `.then()` / `.catch()` / callbacks |
| `for...of` | `.forEach()` when `await` or `break` is needed |
| `structuredClone()` | `JSON.parse(JSON.stringify())` |
| `Object.hasOwn(obj, key)` | `obj.hasOwnProperty(key)` |
| `Array.at(-1)` | `arr[arr.length - 1]` |
| Template literals | String concatenation with `+` |
| Optional chaining `?.` | Manual null checks |
| Nullish coalescing `??` | `\|\|` for default values |
| `using` / `await using` | Manual resource cleanup (when supported) |
| Native `fetch` API | `axios` or any HTTP client library |

String concatenation is prohibited. Use template interpolation even when the concatenation spans multiple lines.

Oxlint enforces template interpolation, `structuredClone()`, and `Object.hasOwn()` through the Dockerized [TypeScript quality runner](../../services/typescript-quality-runner/documentation/TYPESCRIPT-QUALITY.md).
