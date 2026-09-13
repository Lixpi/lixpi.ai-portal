/// <reference types="vite/client" />
interface ImportMetaEnv {
    readonly VITE_API_URL: string
    readonly VITE_AUTH0_LOGIN_URL: string
    readonly VITE_AUTH0_DOMAIN: string
    readonly VITE_AUTH0_CLIENT_ID: string
    readonly VITE_AUTH0_AUDIENCE: string
    readonly VITE_AUTH0_REDIRECT_URI: string
    readonly VITE_USER_PORTAL_URL: string
}
interface ImportMeta {
    readonly env: ImportMetaEnv
}
