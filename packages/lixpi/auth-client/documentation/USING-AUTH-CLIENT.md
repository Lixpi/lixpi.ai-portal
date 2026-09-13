---
title: Using the Auth Client
description: How browser applications configure identity-provider authentication and load the current Lixpi user.
---

# Using the Auth Client

`@lixpi/auth-client` creates composed clients with authentication and current-user operations. The caller supplies environment-specific Auth0 or LocalAuth0 configuration. `features.auth` and `features.currentUser` both default to `true` and can be disabled independently. When authentication is disabled, the caller omits the `auth` configuration and no authentication adapter is created.

## Authentication

`createAuthClient()` selects Auth0 or LocalAuth0 from the `auth.mock.enabled` flag. The resulting client exposes `init()`, `login()`, `logout()`, and `getTokenSilently()`. Auth0 uses its local-storage cache and enables silent iframe fallback when a refresh token is unavailable on a newly opened origin. LocalAuth0 stores the token under its configured storage key.

The main UI and user portal create separate clients because their redirect origins differ. Both can use the same Auth0 application and Universal Login session. `initializeSession()` initializes enabled authentication and returns an access token plus token-read and token-refresh functions. The session does not name a transport, so each service maps it into its own NATS or HTTP connection options.

## Current-user loading

`loadCurrentUser()` accepts a request client. It gets the token from the same auth client instance, sends the existing `users.get` request, then updates that client's user store with loading, success, or error state.

The service composition root calls `loadCurrentUser()` after its request dependency is connected and the application is mounted. A client that disables authentication must also disable current-user loading. The web-client factory does not inspect or invoke auth-client APIs.

## Store ownership

Every client owns isolated auth and user stores, exposed as `client.authStore` and `client.userStore`. `createAuthStore()` and `createUserStore()` remain public for tests or callers that need to inject preconfigured stores. The package does not export process-wide store instances. Generic writable, base, and router stores remain in `@lixpi/web-client-service-factory`.
