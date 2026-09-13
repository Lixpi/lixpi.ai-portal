import {
    mountWebClientApplication,
    type WebClientApplicationInstance,
    type WebClientMountResource,
    type WebClientView,
} from './application.ts'
import {
    createRouterService,
    type RouterServiceConfig,
    type WebClientRouterService,
} from '../routing/routerService.ts'

type Awaitable<Value> = Promise<Value> | Value

export type WebClientRuntimeContext<Dependencies = undefined> = {
    dependencies: Dependencies
    router: WebClientRouterService
}

export type WebClientServiceConfig<Dependencies = undefined> = {
    createDependencies?: () => Awaitable<Dependencies>
    createResources?: Array<(context: WebClientRuntimeContext<Dependencies>) => WebClientMountResource>
    createView: (context: WebClientRuntimeContext<Dependencies>) => WebClientView
    destroyDependencies?: (dependencies: Dependencies) => Awaitable<void>
    document?: Document
    initializeServices?: (context: WebClientRuntimeContext<Dependencies>) => Awaitable<void>
    mountTargetId?: string
    onError?: (error: unknown) => void
    routing: RouterServiceConfig
    shutdownServices?: (context: WebClientRuntimeContext<Dependencies>) => Awaitable<void>
    startServices?: (context: WebClientRuntimeContext<Dependencies>) => Awaitable<void>
}

export type WebClientServiceInstance = {
    destroy: () => Promise<void>
    start: () => Promise<void>
}

class WebClientService<Dependencies> implements WebClientServiceInstance {
    private application: WebClientApplicationInstance | null = null
    private dependencies: Dependencies | undefined
    private dependenciesInitialized = false
    private destruction: Promise<void> | null = null
    private readonly router: WebClientRouterService
    private serviceLifecycleStarted = false
    private startup: Promise<void> | null = null

    constructor(private readonly config: WebClientServiceConfig<Dependencies>) {
        this.router = createRouterService(config.routing)
    }

    start = (): Promise<void> => {
        this.startup ??= this.initialize()

        return this.startup
    }

    destroy = (): Promise<void> => {
        this.destruction ??= this.disposeAfterStartup()

        return this.destruction
    }

    private async initialize(): Promise<void> {
        try {
            this.dependencies = await this.config.createDependencies?.()
            this.dependenciesInitialized = true
            const context = this.getContext()
            this.serviceLifecycleStarted = true
            await this.config.initializeServices?.(context)

            const document = this.config.document ?? globalThis.document
            const mountTargetId = this.config.mountTargetId ?? 'app'
            const target = document.getElementById(mountTargetId)

            if (!target)
                throw new Error(`Web client mount target #${mountTargetId} not found`)

            this.application = mountWebClientApplication({
                target,
                createResources: this.config.createResources?.map(createResource => () => createResource(context)),
                createView: () => this.config.createView(context),
            })
            await this.router.init()
            await this.config.startServices?.(context)
        } catch (error) {
            const errors: unknown[] = [error]

            try {
                await this.disposeOwnedResources()
            } catch (cleanupError) {
                errors.push(cleanupError)
            }

            this.config.onError?.(
                errors.length === 1
                    ? error
                    : new AggregateError(errors, 'Web client startup failed and cleanup did not complete'),
            )
        }
    }

    private getContext(): WebClientRuntimeContext<Dependencies> {
        if (!this.dependenciesInitialized)
            throw new Error('Web client dependencies have not been initialized')

        return {
            dependencies: this.dependencies as Dependencies,
            router: this.router,
        }
    }

    private async disposeAfterStartup(): Promise<void> {
        await this.startup
        await this.disposeOwnedResources()
    }

    private async disposeOwnedResources(): Promise<void> {
        const errors: unknown[] = []

        try {
            await this.application?.destroy()
        } catch (error) {
            errors.push(error)
        }

        this.application = null

        try {
            this.router.destroy()
        } catch (error) {
            errors.push(error)
        }

        if (this.serviceLifecycleStarted) {
            try {
                await this.config.shutdownServices?.(
                    this.getContext(),
                )
            } catch (error) {
                errors.push(error)
            }
        }

        this.serviceLifecycleStarted = false

        if (this.dependenciesInitialized) {
            try {
                await this.config.destroyDependencies?.(this.dependencies as Dependencies)
            } catch (error) {
                errors.push(error)
            }
        }

        this.dependencies = undefined
        this.dependenciesInitialized = false

        if (errors.length > 0)
            throw new AggregateError(errors, 'Web client shutdown failed')
    }
}

export const createWebClientService = <Dependencies = undefined>(config: WebClientServiceConfig<Dependencies>): WebClientServiceInstance =>
    new WebClientService(config)
