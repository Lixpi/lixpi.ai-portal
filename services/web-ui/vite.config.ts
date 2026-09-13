import { createWebClientViteConfig } from '@lixpi/web-client-service-factory/vite'

export default createWebClientViteConfig({
    workspacePackages: [
        '@lixpi/capability-system',
        '@lixpi/canvas-engine',
        '@lixpi/canvas-components',
        '@lixpi/canvas-components-lixpi-specific',
        '@lixpi/constants',
        '@lixpi/nats-service',
        '@lixpi/prosemirror',
        '@lixpi/ui-kit',
        '@lixpi/ui-primitives',
    ],
})
