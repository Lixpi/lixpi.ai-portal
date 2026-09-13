import { fileURLToPath } from 'node:url'
import { createWebClientViteConfig } from '@lixpi/web-client-service-factory/vite'

const clientRoot = fileURLToPath(
    new URL('./src/client', import.meta.url),
)

export default createWebClientViteConfig({
    sourceRoot: clientRoot,
    workspacePackages: [
        '@lixpi/constants',
        '@lixpi/ui-kit-gentelella',
        '@lixpi/ui-primitives',
    ],
    overrides: {
        root: 'src/client',
        publicDir: false,
        resolve: {
            alias: {
                '@lixpi/ui-primitives/styles/transitions': fileURLToPath(
                    new URL('./packages/lixpi/ui-primitives/src/styles/_transitions.scss', import.meta.url),
                ),
            },
        },
        optimizeDeps: {
            include: [
                '@codemirror/lang-json',
                '@codemirror/language',
                '@codemirror/state',
                '@codemirror/view',
                'cm6-theme-basic-dark',
                'cm6-theme-basic-light',
                'cm6-theme-gruvbox-dark',
                'cm6-theme-gruvbox-light',
                'cm6-theme-material-dark',
                'cm6-theme-nord',
                'cm6-theme-solarized-dark',
                'cm6-theme-solarized-light',
            ],
        },
        build: {
            outDir: '../../public',
            emptyOutDir: true,
        },
        server: {
            port: Number(process.env.CLIENT_PORT ?? 3010),
            watch: {
                interval: 300,
            },
            proxy: {
                '/api': {
                    target: `http://127.0.0.1:${process.env.PORT ?? 3011}`,
                    changeOrigin: false,
                },
            },
        },
    },
})
