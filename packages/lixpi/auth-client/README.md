# Auth Client

`@lixpi/auth-client` contains browser authentication and current-user loading for Lixpi web clients. Each client instance owns its Auth0 or LocalAuth0 adapter, auth and user Nano Stores, authenticated session, and `users.get` request flow.

The package does not start a browser application, connect to NATS, or mount UI. A service composition root maps its transport-neutral auth session into its own connection dependency, then injects that dependency into `@lixpi/web-client-service-factory`.

```typescript
import { createAuthClient } from '@lixpi/auth-client'

const authClient = createAuthClient({
    auth: {
        audience,
        clientId,
        domain,
        logoutReturnTo,
        redirectUri,
    },
})

const session = await authClient.initializeSession()
await authClient.loadCurrentUser({ requestClient })

authClient.authStore.subscribe(renderIdentity)
authClient.userStore.subscribe(renderCurrentUser)
```

`features.auth` and `features.currentUser` default to `true`. Disable either operation in the auth-client configuration when a browser application does not use it. When `features.auth` is `false`, omit the `auth` configuration entirely.

Read [Using the Auth Client](documentation/USING-AUTH-CLIENT.md) for the runtime contract, stores, and feature injection.

Run its tests and quality checks through the repository Docker runners:

```bash
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-test-runner shared auth-client
docker compose --profile dev --profile main run --rm --no-deps -T lixpi-typescript-quality-runner shared auth-client validate
```
