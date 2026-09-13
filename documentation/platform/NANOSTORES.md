---
title: Nano Stores
description: How Lixpi constructs browser stores, persists local preferences, and exposes consistent store APIs.
---

# Nano Stores

Lixpi uses Nano Stores for focused browser state shared by UI modules and plain TypeScript code. Application and shared-package code does not construct Nano Stores directly. Every concrete browser store goes through `createStore()` from `@lixpi/web-client-service-factory`.

Use browser stores for state such as panel visibility, local UI dimensions, current route state, and client-side projections used by several components. Do not treat them as the authority for billing, authorization, generated-media lineage, or data that must remain correct across clients and service restarts.

## Package boundary

Import the factory from its package root:

```typescript
import { createStore } from '@lixpi/web-client-service-factory'
```

Do not import `nanostores`, `@nanostores/persistent`, or the factory's internal writable adapter from an application or another shared package. `@lixpi/web-client-service-factory` owns those implementation dependencies. Auth and user stores live in `@lixpi/auth-client`; canvas, workspace, model-catalog, and other product state stays with the application that owns it.

## Plain state

Pass plain state when subscribers must receive that exact scalar, map, array, or object:

```typescript
export const accountDrawerStore = createStore({ initialState: false })
```

The result provides `get()`, `set()`, `update()`, `listen()`, `subscribe()`, and `resetStore()`.

## Structured state

State with `{ meta, data }` receives `getMeta()`, `getData()`, `setMetaValues()`, and `setDataValues()` in addition to the standard store methods:

```typescript
type ItemsStoreState = {
    meta: {
        loading: boolean
    }
    data: {
        items: Item[]
    }
}

const initialState: ItemsStoreState = {
    meta: {
        loading: false,
    },
    data: {
        items: [],
    },
}

export const itemsStore = createStore({ initialState })
```

Give the initial state an explicit type when empty arrays, `null`, or literal values need a wider application type.

## Domain methods

Return domain methods from the method factory. They are attached to the concrete store without a wrapper object or caller-side spread:

```typescript
type PanelState = {
    isOpen: boolean
    width: number | null
}

const initialState: PanelState = {
    isOpen: true,
    width: null,
}

export const panelStore = createStore({
    initialState,
    createMethods: store => ({
        setValues: (values: Partial<PanelState> = {}): void => void store.update(
            state => ({
                ...state,
                ...values,
            }),
        ),
    }),
})
```

Use `store.get()` inside domain methods. Do not reimplement synchronous reads by subscribing and immediately unsubscribing.

The method factory receives an untouched base-store API. A public domain method can reuse a base method name when its contract requires it, such as `get(assetId)`, while its implementation still calls the original zero-argument `store.get()` state reader.

## Persistent state

Pass a persistence key when the whole state should survive reloads:

```typescript
export const panelStore = createStore({
    initialState,
    createMethods: store => ({
        setValues: (values: Partial<PanelState> = {}): void => void store.update(
            state => ({
                ...state,
                ...values,
            }),
        ),
    }),
    persistence: {
        key: 'navigationSidePanel:state',
    },
})
```

Persistence is for small JSON-compatible UI preferences, not server-owned state.

## Updates and ownership

Use immutable updates. Copy maps, arrays, and objects before changing them, and clone caller-owned mutable values before storing them. `createStore()` clones initial state when a store is created and when it is reset, so separate stores do not share nested mutable initial data.

Use `listen()` or `subscribe()` for lifecycle-bound reactions and clean up the returned unsubscribe function when the component is destroyed. `subscribe()` immediately receives the current state; `listen()` waits for the next change.

Keep each store focused. A component should read from one store or receive one external value from its host instead of maintaining a hidden duplicate.
