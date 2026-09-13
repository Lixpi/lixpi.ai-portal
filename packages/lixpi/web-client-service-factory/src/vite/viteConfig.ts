import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    defineConfig,
    mergeConfig,
    type UserConfig,
} from 'vite'
import { defineConfig as defineVitestConfig } from 'vitest/config'

export type WebClientViteConfig = {
    overrides?: UserConfig
    sourceRoot?: string
    workspacePackages?: string[]
}

export const createWebClientViteConfig = (config: WebClientViteConfig = {}) => {
    const sourceRoot = config.sourceRoot ?? './src'

    const baseConfig = defineConfig({
        server: {
            host: true,
            strictPort: true,
            port: 5173,
            watch: {
                usePolling: true,
                interval: 3000,
                binaryInterval: 6000,
            },
        },
        optimizeDeps: {
            entries: [
                'index.html',
            ],
            exclude: [
                '@lixpi/web-client-service-factory',
                ...(config.workspacePackages ?? []),
            ],
        },
        resolve: {
            alias: {
                $src: path.resolve(sourceRoot),
            },
            conditions: ['browser'],
        },
        css: {
            preprocessorOptions: {
                scss: {
                    importers: [{
                        findFileUrl(url: string) {
                            if (!url.startsWith('$src/'))
                                return null

                            return pathToFileURL(
                                path.resolve(
                                    sourceRoot,
                                    url.slice(5),
                                ),
                            )
                        },
                    }],
                },
            },
        },
    })

    return config.overrides
        ? mergeConfig(baseConfig, config.overrides)
        : baseConfig
}

export type WebClientVitestConfig = {
    include?: string[]
    sourceRoot?: string
}

export const createWebClientVitestConfig = (config: WebClientVitestConfig = {}) => {
    const sourceRoot = config.sourceRoot ?? './src'

    return defineVitestConfig({
        test: {
            environment: 'happy-dom',
            globals: true,
            include: config.include ?? ['src/**/*.test.ts'],
            alias: {
                $src: path.resolve(sourceRoot),
            },
        },
        resolve: {
            alias: {
                $src: path.resolve(sourceRoot),
            },
        },
    })
}
