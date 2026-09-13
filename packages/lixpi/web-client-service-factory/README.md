# Web Client Service Factory

`@lixpi/web-client-service-factory` supplies the common runtime for Lixpi's framework-free browser applications. It owns application mounting and teardown, routing, route-driven view replacement, concrete Nano Store creation, shared Vite configuration, and the base Sass document surface.

The package has no authentication, user, NATS, API-client, or product-service dependency. An application supplies an optional typed dependency lifecycle, and the factory passes the resulting dependency object to its resources, root view, and service hooks.

## Create a client

```typescript
import { createWebClientService } from '@lixpi/web-client-service-factory'

type ClientDependencies = {
    updates: EventSource
}

const application = createWebClientService<ClientDependencies>({
    createDependencies: () => ({
        updates: new EventSource('/api/updates'),
    }),
    createView: ({
        dependencies,
        router,
    }) => createLayout({
        router,
        updates: dependencies.updates,
    }),
    destroyDependencies: ({ updates }) => updates.close(),
    routing: { routes },
})

void application.start()
```

Omit `createDependencies` for a client such as the AI Model Registry browser UI that needs only routing, mounting, and view lifecycle.

`createStore()` passes an untouched base-store API to its method factory and composes the returned domain methods onto a separate public store object. Domain stores can reuse names such as `get` or `set` without changing the methods used inside their own implementations.

Import `@lixpi/web-client-service-factory/styles/foundation` once before application styles. Build Vite and Vitest configuration through `@lixpi/web-client-service-factory/vite`.

Read [Using the Web Client Service Factory](documentation/USING-WEB-CLIENT-SERVICE-FACTORY.md) for dependency injection, startup hooks, route views, Vite, Sass, and cleanup.

Run its tests and quality checks through the repository Docker runners:

```bash
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner shared web-client-service-factory
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner shared web-client-service-factory validate
```
