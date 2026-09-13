export type WebClientView = {
    readonly el: HTMLElement
    destroy: () => void
    mount?: () => void
}

export type WebClientMountResource = {
    destroy: () => void
}

export type WebClientApplicationConfig = {
    createResources?: Array<() => WebClientMountResource>
    createView: () => WebClientView
    shutdown?: () => Promise<void>
    target: HTMLElement
}

export type WebClientApplicationInstance = {
    destroy: () => Promise<void>
}

class WebClientApplication implements WebClientApplicationInstance {
    private readonly resources: WebClientMountResource[] = []
    private view: WebClientView | null = null
    private destruction: Promise<void> | null = null

    constructor(private readonly config: WebClientApplicationConfig) {
        try {
            for (const createResource of config.createResources ?? [])
                this.resources.push(
                    createResource(),
                )

            this.view = config.createView()
            config.target.append(this.view.el)
            this.view.mount?.()
        } catch (error) {
            const errors: unknown[] = [error]
            this.destroyMountedParts(errors)
            const detail = error instanceof Error ? error.message : String(error)

            throw new AggregateError(errors, `Web client application mount failed: ${detail}`)
        }
    }

    destroy = (): Promise<void> => {
        this.destruction ??= this.dispose()

        return this.destruction
    }

    private destroyMountedParts(errors: unknown[]): void {
        try {
            this.view?.destroy()
        } catch (error) {
            errors.push(error)
        }

        this.view = null

        for (const resource of this.resources.reverse()) {
            try {
                resource.destroy()
            } catch (error) {
                errors.push(error)
            }
        }

        this.resources.length = 0
    }

    private async dispose(): Promise<void> {
        await Promise.resolve()
        const errors: unknown[] = []
        this.destroyMountedParts(errors)

        try {
            await this.config.shutdown?.()
        } catch (error) {
            errors.push(error)
        }

        if (errors.length > 0)
            throw new AggregateError(errors, 'Web client application shutdown failed')
    }
}

export const mountWebClientApplication = (config: WebClientApplicationConfig): WebClientApplicationInstance => new WebClientApplication(config)
