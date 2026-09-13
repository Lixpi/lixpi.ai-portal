# UI Components Coding Style Guide

## Scope

Use this guide when building UI components in `services/web-ui` that are not pure PIXI renderers. This includes TypeScript DOM UI, ProseMirror node views, canvas chrome, SVG controls, menus, switches, sliders, toolbars, overlays, and small reusable primitives.

This guide does not replace the PIXI rendering rules for canvas scene content. If the element is part of the canvas world and can be rendered naturally in PIXI, PIXI is the first choice. Use this guide for UI that sits outside PIXI or for canvas-adjacent controls that need DOM/SVG semantics.

## Frontend Boundary

`services/web-ui` is a presentational and interaction layer. It must not own distributed-system decisions or product-domain orchestration. Frontend code may collect user input, build non-authoritative snapshots for the API, render streamed API state, compute local geometry, and handle direct UI interaction. It must not decide branch topology, generated-media parentage, fork/origin marker creation, reasoning-run routing, model fanout, context relevance, resolver outcomes, lineage provenance, billing, authorization, persistence ownership, or any other API-owned workflow state.

If a feature needs a decision that must stay correct across reloads, concurrent editors, multiple clients, retries, workers, or service restarts, the decision belongs in `services/api` or a shared backend service. The browser receives that decision through a typed API response, stream event, or persisted state contract, then applies it visually. Do not hide these decisions in UI components, ProseMirror plugins, `WorkspaceCanvas.ts`, canvas utilities, stores, or client services.

## Rendering Decision

Choose the rendering approach by where the UI lives and what it does.

| Situation | First choice | Use when |
|-----------|--------------|----------|
| Canvas scene content | PIXI | Nodes, images, videos, sprites, shapes, hit-tested scene objects, high-frequency transforms, zoomed world content |
| Canvas-adjacent controls | D3 SVG | Menus, switches, sliders, playback controls, control bars, badges, handles, and similar UI that must track canvas geometry but needs precise interactive controls |
| Normal app UI | TypeScript `html` tagged template | Panels, dialogs, forms, settings, inspectors, app navigation, persistent screens, ProseMirror node views, and plugins covered by [`TYPESCRIPT.md`](./TYPESCRIPT.md) |
| Static icon or decorative SVG in DOM | Existing icon system | Import from [`@lixpi/ui-kit/svg`](../../packages/lixpi/ui-kit/src/svg/svgIcons.ts), then inject or parse according to the host renderer |

Do not use D3 for ordinary application DOM. Do not use HTML templates for canvas chrome when the control is expected to live in an SVG overlay. Do not use PIXI for form-like UI, menus, segmented switches, media controls, or text-heavy widgets unless there is a concrete rendering reason.

## Canvas Rule

When UI is located on or around the canvas:

1. Use PIXI first for actual canvas content.
2. Use D3 SVG for specialized UI controls that PIXI is bad at: menus, switches, sliders, playback controls, popups, focusable hit targets, and controls that need accessible DOM/SVG semantics.
3. Keep the D3/SVG layer thin. It should drive or annotate canvas state, not replace PIXI rendering for the scene.
4. Keep ownership clear. PIXI owns pixels and scene objects. D3 owns the SVG control elements. The feature or host owns application state.

The video player controls follow this split: the canvas media layer owns poster/geometry state, a browser-composited `HTMLVideoElement` owns completed playback, and D3 SVG renders the control bar that drives that element.

## D3 Policy

Use the latest stable D3 documentation and D3 packages. Do not pin coding guidance to a specific D3 minor version in docs because it becomes stale quickly.

Relevant official docs:

- [`d3-selection`](https://d3js.org/d3-selection)
- [`Selecting elements`](https://d3js.org/d3-selection/selecting)
- [`Modifying elements`](https://d3js.org/d3-selection/modifying)
- [`Handling events`](https://d3js.org/d3-selection/events)
- [`d3-transition`](https://d3js.org/d3-transition)
- [`d3-transition timing`](https://d3js.org/d3-transition/timing)
- [`d3-ease`](https://d3js.org/d3-ease)

Use modular imports from the D3 packages the component actually needs:

```typescript
import { select } from 'd3-selection'
import 'd3-transition'
import { easeCubicOut } from 'd3-ease'
```

Import `d3-transition` for side effects before calling `.transition()` on selections.

## D3 SVG Component Shape

D3 SVG UI components should render into a caller-provided SVG selection and expose a small imperative API.

```typescript
export type ExampleControlConfig = {
    id: string
    x: number
    y: number
    width: number
    height?: number
    className?: string
    onChange?: (value: string, id: string) => void
}

export type ExampleControlInstance = {
    render: () => void
    resize?: (x: number, y: number, width: number) => void
    destroy: () => void
}

class ExampleControl implements ExampleControlInstance {
    private readonly group: any
    private readonly background: any

    constructor(parent: any, private readonly config: ExampleControlConfig) {
        this.group = parent.append('g')
            .attr('class', `example-control-group ${config.className ?? ''}`)
            .attr('transform', `translate(${config.x}, ${config.y})`)
            .attr('data-example-control-id', config.id)

        this.background = this.group.append('rect')
            .attr('class', 'example-control-background')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', config.width)
            .attr('height', config.height ?? 24)
    }

    render(): void {
        this.background.attr('width', this.config.width)
    }

    destroy(): void {
        this.group.remove()
    }
}

export function createExampleControl(parent: any, config: ExampleControlConfig): ExampleControlInstance {
    return new ExampleControl(parent, config)
}
```

The public API should usually be `createX(parent, config)`. It appends one top-level SVG `<g>`, returns an instance object, and does not leak internal selections.

## Factory Or Class

Follow [`TYPESCRIPT.md`](./TYPESCRIPT.md) for class usage.

Use a class by default for UI components. A component that owns cohesive state, selections, layout, lifecycle cleanup, listeners, or a public imperative API must be class-backed. Keep the factory as the public entry point:

```typescript
class ExampleControl implements ExampleControlInstance {
    render = (): void => {}
    destroy = (): void => {}
}

export function createExampleControl(parent: any, config: ExampleControlConfig): ExampleControlInstance {
    return new ExampleControl(parent, config)
}
```

Closure-backed factories are not acceptable for reusable UI components, D3/SVG controls, canvas chrome controls, controllers, menus, switches, sliders, popovers, tooltips, or editor-backed UI. Use plain functions only for pure utilities, tiny adapters, simple callbacks, and small mappers with no retained state or cleanup.

Do not build deep inheritance hierarchies. Prefer composition and helper functions. Inheritance deeper than 3 levels is not allowed.

## SVG Rendering Rules

For D3 SVG UI:

- Render visuals with SVG elements: `g`, `rect`, `circle`, `text`, `path`, `line`, `polyline`, and similar.
- Position with SVG attributes: `x`, `y`, `cx`, `cy`, `r`, `width`, `height`, `rx`, `ry`, `transform`.
- Style with SVG attributes first: `fill`, `stroke`, `stroke-width`, `opacity`, `display`, `text-anchor`, `dominant-baseline`.
- Use `.style(...)` only when there is no clean SVG attribute equivalent, such as `cursor`.
- Use transparent SVG hit areas for pointer targets.
- Do not use `foreignObject` unless the requirement truly needs HTML inside SVG and the tradeoff is documented.
- Do not create ordinary HTML with D3.
- Do not move basic SVG geometry, color, hover, or animation into a stylesheet. Keep reusable constants in TypeScript and write attributes through D3.

Bad:

```typescript
const button = document.createElement('button')
button.className = 'canvas-control'
```

Good:

```typescript
const button = group.append('g')
    .attr('class', 'canvas-control-button')
    .attr('role', 'button')
    .attr('tabindex', 0)

button.append('rect')
    .attr('class', 'canvas-control-button-hit')
    .attr('width', BUTTON_SIZE)
    .attr('height', BUTTON_SIZE)
    .attr('fill', 'transparent')
```

## HTML Rules

Use the `html` tagged template from [`TYPESCRIPT.md`](./TYPESCRIPT.md) for `.ts` files that create normal DOM elements. This is mandatory for application UI, ProseMirror plugins, NodeViews, shared DOM utilities, and other TypeScript-built HTML.

Do not mix approaches inside one component without a clear boundary:

- A TypeScript DOM panel can host an `<svg>` and call a D3 SVG primitive.
- A ProseMirror NodeView can create a DOM shell with `html` and mount an SVG control inside it.
- A canvas chrome layer can position an SVG host and let D3 render inside it.
- A D3 SVG primitive should not create random HTML siblings.

## State Ownership

Every UI component must have one clear source of truth.

Patterns:

- Internal state: the component owns the value and exposes setters/getters.
- External state: the host owns the value and calls `render()` or setters when it changes.
- DOM/media state: a DOM object is the source of truth, and the component listens to its events.
- Store state: a Nano Store or app state object is the source of truth, and the component is a view/controller for it.

Do not maintain parallel state copies without a sync plan. If the component writes to external state, callbacks should report the change. If a setter is programmatic, document whether it fires callbacks.

## Config And Instance API

Config types should use `type`, not `interface`.

Common config fields:

- `id`: stable identity for `data-*` attributes and callbacks.
- Geometry: `x`, `y`, `width`, `height`, or `size`.
- `className`: optional caller-specific class.
- `disabled`, `selectedValue`, `checked`, or equivalent initial state.
- `onChange`: callback for user-driven changes.
- External source references only when intentional, such as `videoEl`.

Instance APIs should be small:

- `render()` to resync the UI.
- `resize(...)` when geometry changes after mount.
- `setValue(...)`, `setChecked(...)`, or similar setters.
- `getValue()` or `getChecked()` only when callers need internal state.
- `destroy()` for cleanup.

Do not expose internal D3 selections or DOM nodes unless the host genuinely needs them.

## Layout

For D3 SVG components:

- Compute geometry numerically, then write attributes.
- Define constants for padding, gaps, fixed widths, radii, timings, and colors.
- Use helper functions for repeated geometry.
- Use `transform="translate(x, y)"` for top-level positioning.
- Update numeric attributes directly instead of parsing strings.
- Clamp pointer-derived values.
- Hide unsupported controls with `display="none"` and remove or disable their hit areas.

For HTML components:

- Use existing layout primitives and CSS rules from nearby code.
- Keep app UI responsive through CSS, not D3 calculations.
- Avoid canvas-specific coordinate math unless the UI is explicitly mounted over the canvas.

## Events

Rules for all UI components:

- Stop propagation when the control sits on top of canvas, ProseMirror, or drag surfaces.
- Use `preventDefault()` for keyboard, pointer drag, and button-like interactions where browser behavior can interfere.
- Keep user-driven callbacks separate from programmatic setters.
- Cleanly detach global listeners.

D3 SVG controls should use `selection.on(...)` for SVG-owned elements:

```typescript
hitArea.on('click', (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    applyValue(option.value, true)
})
```

D3 event listeners receive the event argument directly. Do not use old `d3.event` patterns.

Use arrow functions when handlers need lexical class `this`. Use `function () { select(this) ... }` only when the current DOM element is required.

## Pointer Coordinates

For SVG-local pointer coordinates, prefer `d3.pointer(event, target)` when the target's SVG coordinate system matters.

For simple one-dimensional sliders in screen pixels, `getBoundingClientRect()` is acceptable. Clamp ratios:

```typescript
function ratioFromEvent(event: PointerEvent | MouseEvent, hit: SVGRectElement): number {
    const rect = hit.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return clamp((event.clientX - rect.left) / rect.width, 0, 1)
}
```

## Transitions

Use motion only when it clarifies state:

- Switch toggles.
- Slider handles.
- Segmented indicators.
- Menu open/close states.
- Brief opacity or color transitions.

Do not animate every render. Initial render and external sync renders should usually be immediate. User-driven state changes can animate.

For D3 transitions:

```typescript
indicator
    .transition()
    .duration(200)
    .ease(easeCubicOut)
    .attr('x', targetX)
```

Keep durations short. Use easing intentionally. Avoid playful easing unless the product surface is intentionally playful.

## Icons

Use existing icons from [`@lixpi/ui-kit/svg`](../../packages/lixpi/ui-kit/src/svg/svgIcons.ts).

For HTML, inject icon markup through the existing DOM/template patterns.

For D3 SVG controls, use `appendSvgPathIcon` from
[`svgIconPaths.ts`](../../packages/lixpi/ui-primitives/src/svg/svgIconPaths.ts) to
parse imported SVG markup and append scaled paths into an SVG group:

```typescript
import { appendSvgPathIcon, xIcon } from '@lixpi/ui-kit/svg'

appendSvgPathIcon(iconGroup, xIcon, { x: 0, y: 0, size: 14, fill: '#1a2744' })
```

Cache parsed path data if an icon is large or updated frequently.

## Tooltips

Native browser tooltips are forbidden. Never use an HTML or SVG `title` attribute, assign `element.title`, call `setAttribute('title', ...)`, or add an SVG `<title>` element to provide hover help.

All visible hover or focus help must use `@lixpi/ui-kit/components/help-tooltip`. Do not build one-off tooltip markup or CSS inside a feature component.

For simple icon-control help, keep the accessible name or description on the control and opt it into the application-level tooltip provider:

```html
<button aria-label="Add to library" data-help-tooltip="aria-label">...</button>
```

Use `data-help-tooltip="aria-description"` for a changing supplemental description. A literal attribute value is allowed when the visible help must differ from the accessible name. Use `data-help-tooltip-placement` only when a fixed `top`, `bottom`, `left`, or `right` placement is part of the surface contract.

Use `createHelpTooltip()` directly for rich content, interactive tooltip content, or a tooltip-owned trigger. The shared component owns the portal, viewport clamping, arrow, positioning, and cleanup in both modes. Do not add feature-local arrow markup or positioning CSS.

Do not opt in semantic regions, visible text labels, or every element with an ARIA attribute by default. If a control does not need visible help, give it the appropriate `aria-label`, `aria-labelledby`, `aria-description`, or `aria-describedby` without `data-help-tooltip`.

This rule does not apply to the document `<title>` element used for page metadata or to application data fields named `title`; those are not browser hover tooltips.

## Accessibility

UI components must expose accessible behavior appropriate to their renderer.

For D3 SVG controls:

- Add `role="button"` to clickable groups.
- Add `tabindex="0"` when keyboard focus is required.
- Add `aria-label` and update it when state changes.
- Add `aria-pressed` for toggle-like controls.
- For keyboard-interactive sliders, add `role="slider"`, `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`.
- Support `Enter` and `Space` for buttons.
- Support arrow keys for sliders, segmented controls, and menu movement when needed.

For HTML controls, use native controls when possible before recreating semantics manually.

Do not rely on color alone. Text, icon state, geometry, and ARIA should reflect the current value.

## Cleanup

Every imperative UI instance must expose `destroy()`.

`destroy()` must:

- Remove the top-level mounted element or SVG group.
- Remove external listeners added to `window`, `document`, media elements, stores, or other objects.
- Cancel active pointer-drag cleanup.
- Leave caller-owned containers and external data untouched.

If a D3 component uses only `.on(...)` listeners on SVG elements that are removed with the group, `group.remove()` is enough for those internal listeners. Anything outside the group must be removed explicitly.

## Tests

Follow the [`TypeScript Testing Guide`](../testing/TypeScript/TESTING-GUIDE.md) for test commands and conventions.

For D3 SVG UI:

- Mount into a real SVG element created with `document.createElementNS`.
- Use `select(svg)` to pass the host selection.
- Assert expected SVG classes and attributes.
- Dispatch `MouseEvent`, `KeyboardEvent`, or pointer-like events to hit areas.
- Stub external state sources such as `HTMLVideoElement`.
- Assert callbacks fire only when they should.
- Assert public setters update rendered state.
- Assert `destroy()` removes the group and external listeners.

For TypeScript DOM UI, use the existing test approach near the component. Do not use browser screenshots or manual browser inspection for agent verification.

## Documentation

Component docs should describe:

- Which renderer owns the UI: PIXI, D3 SVG, or TypeScript `html`.
- Where the component mounts.
- Public config and instance API.
- State ownership and callback behavior.
- Geometry and resize behavior.
- Animation behavior.
- Cleanup expectations.
- Known limitations.

If adding Mermaid diagrams, follow [`MERMAID-DIAGRAMS-STYLE-GUIDE.md`](../documentation-style-guides/MERMAID-DIAGRAMS-STYLE-GUIDE.md). Keep Mermaid syntax GitHub-safe: single-line theme config, ASCII labels when in doubt, full-width `Note over First, Last` for sequence phase titles, and paired activations in sequence diagrams.

## Review Checklist

Before merging a UI component, check:

- The renderer choice follows the decision table.
- Canvas scene content uses PIXI unless there is a documented reason not to.
- Canvas-adjacent controls use D3 SVG when they need menus, switches, sliders, control bars, or similar UI.
- Normal app UI uses the TypeScript `html` tagged template.
- State has one source of truth.
- Public API is small and explicit.
- Geometry and colors are centralized.
- User interactions stop propagation where needed.
- Keyboard and ARIA behavior are covered.
- Pointer hit areas are large enough.
- Transitions are short and meaningful.
- `destroy()` removes mounted UI and external listeners.
- Tests cover render, interaction, programmatic updates, and cleanup.
- Component docs are updated when behavior or API changes.
