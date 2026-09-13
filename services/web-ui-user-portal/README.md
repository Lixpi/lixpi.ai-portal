# Web UI User Portal

`web-ui-user-portal` is the account-management SPA served from `user-portal.<domain>`. It uses authentication and user state from `@lixpi/auth-client`, the shared browser runtime and routing from `@lixpi/web-client-service-factory`, and renders its UI with `@lixpi/ui-kit-gentelella`.

The initial proof of concept exposes one authenticated route, `/`, which requests the current user through NATS and displays the returned profile.

## Local development

Run the service through Docker Compose. It is available at `http://localhost:3002` and uses the same local or hosted identity provider configuration as `web-ui`, with its own redirect URI. `VITE_USER_PORTAL_URL` is required in the environment file. `web-ui` reads it and opens this service in a new tab when the user clicks the sidebar avatar.

The identity-provider application must allow the portal origin as a callback URL, logout URL, and web origin. Sharing the Auth0 tenant and application gives the two SPAs single sign-on, while each origin maintains its own browser token cache.

## Tests and quality checks

Use the repository TypeScript test and quality runner containers. The runner domain is `web-ui-user-portal` for this service and `shared` for `@lixpi/auth-client` and `@lixpi/web-client-service-factory`.
