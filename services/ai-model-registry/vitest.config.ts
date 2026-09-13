import { createWebClientVitestConfig } from '@lixpi/web-client-service-factory/vite'

export default createWebClientVitestConfig({
    include: ['src/client/**/*.test.ts'],
    sourceRoot: './src/client',
})
