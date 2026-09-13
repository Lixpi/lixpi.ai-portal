import {
    NATS_SUBJECTS,
    LoadingStatus,
} from '@lixpi/constants'
import type NatsService from '@lixpi/nats-service'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'

const { AI_MODELS_SUBJECTS } = NATS_SUBJECTS

import { aiModelsStore } from '$src/stores/aiModelsStore.ts'

export type AiModelServiceConfig = {
    auth: AuthTokenProvider
    nats: NatsService
}

export default class AiModelService {
    private readonly catalogSyncSubscription: { unsubscribe(): void } | null

    constructor(private readonly config: AiModelServiceConfig) {
        this.catalogSyncSubscription = config.nats.subscribe(AI_MODELS_SUBJECTS.MODELS_SYNC_COMPLETED, () => void this.getAvailableAiModels())
    }

    public async getAvailableAiModels(): Promise<void> {
        aiModelsStore.setMetaValues({ loadingStatus: LoadingStatus.loading })

        try {
            const availableModels: any = await this.config.nats.request(
                AI_MODELS_SUBJECTS.GET_AVAILABLE_MODELS,
                {
                    token: await this.config.auth.getTokenSilently(),
                },
            )

            if (Array.isArray(availableModels))
                aiModelsStore.setAiModels(availableModels)
            else if (Array.isArray(availableModels?.models))
                aiModelsStore.setAiModelsCatalog(availableModels)
            else
                aiModelsStore.setAiModels([])

            aiModelsStore.setMetaValues({ loadingStatus: LoadingStatus.success })
        } catch (error) {
            console.error('Failed to load AI models data:', error)
            aiModelsStore.setMetaValues({ loadingStatus: LoadingStatus.error })
        }
    }

    public destroy(): void {
        this.catalogSyncSubscription?.unsubscribe()
    }
}
