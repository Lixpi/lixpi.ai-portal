---
title: Using the Web Client Service Factory
description: How Lixpi browser applications share dependency-neutral startup, routing, view lifecycle, Vite configuration, and Sass foundations.
---

# Using the Web Client Service Factory

`@lixpi/web-client-service-factory` creates the browser runtime used by `web-ui`, `web-ui-user-portal`, and the AI Model Registry client. Applications supply route definitions, their root layout, product services, UI-kit resources, and any runtime dependencies.

## Runtime startup

`createWebClientService()` creates an isolated Nano Store-backed router from the supplied `routing` configuration and returns an idempotent `start()` and `destroy()` pair. Startup performs these operations:

1. Call the optional `createDependencies` function.
2. Pass its typed result to `initializeServices`.
3. Create resources and mount the root view at `#app`.
4. Initialize the router after the root view is in the document.
5. Pass the same dependency object to `startServices`.

Mounting tracks the root view and application resources. Shutdown destroys the root view and resources, destroys the router, runs `shutdownServices`, and calls `destroyDependencies`. Repeated shutdown calls share one promise. Startup failures run the same cleanup path for every part that initialized successfully.

## Dependency injection

The factory accepts an arbitrary application-owned dependency type:

```typescript
type ClientDependencies = {
    api: ApiClient
    updates: EventSource
}

createWebClientService<ClientDependencies>({
    createDependencies: async () => ({
        api: await createApiClient(),
        updates: new EventSource('/api/updates'),
    }),
    createView: ({
        dependencies,
        router,
    }) => createLayout({
        dependencies,
        router,
    }),
    destroyDependencies: async ({ api, updates }) => {
        updates.close()
        await api.disconnect()
    },
    routing: { routes },
})
```

The factory does not know what those dependencies do. Authentication, users, transports, API clients, and product services remain in the application or their own packages. A client with no dependencies omits `createDependencies` and receives `undefined` in the runtime context.

## Route-driven views

`createRouteViewOutlet()` subscribes to the factory-owned router and owns the active view. A route entry supplies the route pattern and an application-owned view factory. When the route path changes, the outlet destroys the previous view, inserts the matching view, then calls its optional `mount()` hook. The post-insertion hook supports views that need to query their mounted DOM.

Define one application-owned `RouteViewDefinition[]` and pass it through the factory's `routing.routes` configuration. The factory supplies the resulting router to `createView`, and the layout passes that router and the same route table to `createRouteViewOutlet()`. Extend the route type when navigation or document-title metadata is needed, then derive those consumers from the same entries instead of declaring route paths again.

Route view context is generic, so the layout can inject application dependencies without teaching the factory about them:

```typescript
type ClientRouteContext = RouteViewContext & {
    api: ApiClient
}

const routes: RouteViewDefinition<ClientRouteContext>[] = [{
    path: '/',
    createView: ({ api }) => createHomeView(api),
}]

createRouteViewOutlet({
    context: {
        api,
        router,
    },
    routes,
    target,
})
```

The outlet's optional `onRouteChange` callback keeps application navigation chrome synchronized without a second store subscription. The outlet does not choose a UI kit or build navigation.

The router supports route parameters, query strings, hashes, loaders, history, an optional fallback route, and an `onRouteChange` callback. A fallback route handles browser URLs that do not match the route table. The callback can update application-owned state such as the document title. Application services and components receive the router through the runtime context instead of importing a singleton.

## Vite and Sass foundations

Import browser runtime APIs from the package root. The `/vite` entrypoint stays separate because Vite configuration runs in Node, and `/styles/foundation` is a Sass asset rather than a browser TypeScript module.

`createWebClientViteConfig()` provides the `$src` alias, browser export condition, `index.html` dependency entry, workspace-package exclusions, and Docker-friendly polling. Its `overrides` option merges service-specific roots, output directories, proxies, aliases, and dependency optimization without copying the base setup.

`createWebClientVitestConfig()` supplies the matching test alias and Happy DOM setup. A client whose source is not under `src/` can set `sourceRoot` and `include`.

Import `@lixpi/web-client-service-factory/styles/foundation` once from the application entrypoint. It establishes border sizing and the full document, body, and `#app` mount surface. Application themes and component styles stay with their UI kit or service.

## Store ownership

`createStore()` is the only browser-store constructor exposed by the package. Every concrete application store goes through it instead of importing Nano Stores or a writable adapter directly. It clones the initial state, provides synchronous reads, writes, subscriptions, immutable updates, and reset behavior, then composes the methods returned by its optional method factory onto the public store. The method factory receives an untouched base-store API, so a domain method can reuse a name such as `get` or `set` without replacing the method that its own implementation calls.

State with `{ meta, data }` receives the base-store section helpers automatically:

```typescript
type CounterMethods = {
    increment: () => void
}

const initialState: {
    meta: CounterMeta
    data: CounterData
} = {
    meta: { loading: false },
    data: { count: 0 },
}

const counterStore = createStore({
    initialState,
    createMethods: (store): CounterMethods => ({
        increment: () => store.setDataValues({
            count: store.getData('count') + 1,
        }),
    }),
})
```

Plain state keeps its exact subscription payload. This is useful when an established port expects a map, boolean, or application-specific object rather than `{ meta, data }`:

```typescript
const selectionStore = createStore({
    initialState: { selectedId: null as string | null },
    createMethods: store => ({
        select: (selectedId: string): void => void store.update(
            state => ({
                ...state,
                selectedId,
            }),
        ),
    }),
})
```

Small browser preferences can use the same factory with JSON persistence:

```typescript
const panelStore = createStore({
    initialState: {
        isOpen: true,
        width: null as number | null,
    },
    persistence: {
        key: 'navigationSidePanel:state',
    },
})
```

The factory clones initial state before storing or resetting it, so stores created from the same arrays, maps, or objects do not share mutable initial data. Each router owns an isolated store and exposes route reads and subscriptions through its API. The lower-level writable adapter and Nano Store dependencies stay internal to this package.

Auth and user stores live in `@lixpi/auth-client`. Model catalog, canvas, workspace, service registry, and other product state stay in the application that owns them.
