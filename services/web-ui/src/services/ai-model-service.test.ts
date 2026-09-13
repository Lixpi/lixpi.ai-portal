import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    LoadingStatus,
    NATS_SUBJECTS,
} from '@lixpi/constants'
import AiModelService from '$src/services/ai-model-service.ts'

const { AI_MODELS_SUBJECTS } = NATS_SUBJECTS

const requestMock = vi.hoisted(() => vi.fn())
const subscribeMock = vi.hoisted(() => vi.fn(() => ({ unsubscribe: vi.fn() })))
const getTokenSilentlyMock = vi.hoisted(() => vi.fn())
const setAiModelsMock = vi.hoisted(() => vi.fn())
const setAiModelsCatalogMock = vi.hoisted(() => vi.fn())
const setMetaValuesMock = vi.hoisted(() => vi.fn())
let consoleErrorSpy: { mockRestore: () => void } | null = null
let consoleWarnSpy: { mockRestore: () => void } | null = null

vi.mock('$src/stores/aiModelsStore.ts', () => ({
    aiModelsStore: {
        setAiModels: setAiModelsMock,
        setAiModelsCatalog: setAiModelsCatalogMock,
        setMetaValues: setMetaValuesMock,
    },
}))

describe('AiModelService', () => {
    let service: AiModelService

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.clearAllMocks()
        getTokenSilentlyMock.mockResolvedValue('auth-token')

        service = new AiModelService({
            auth: { getTokenSilently: getTokenSilentlyMock },
            nats: {
                request: requestMock,
                subscribe: subscribeMock,
            } as never,
        })
    })

    afterEach(() => {
        consoleErrorSpy?.mockRestore()
        consoleWarnSpy?.mockRestore()
        consoleErrorSpy = null
        consoleWarnSpy = null
    })

    it('sets loading and stores direct model arrays from NATS', async () => {
        const response = [
            {
                provider: 'openai',
                model: 'gpt-4o',
                version: '1',
            },
            {
                provider: 'google',
                model: 'gemini',
                version: '1',
            },
        ] as const

        requestMock.mockResolvedValue(response)

        await service.getAvailableAiModels()

        expect(requestMock).toHaveBeenCalledWith(AI_MODELS_SUBJECTS.GET_AVAILABLE_MODELS, {
            token: 'auth-token',
        })
        expect(setMetaValuesMock).toHaveBeenCalledWith({ loadingStatus: LoadingStatus.loading })
        expect(setAiModelsMock).toHaveBeenCalledWith(response as any)
        expect(setMetaValuesMock).toHaveBeenNthCalledWith(2, { loadingStatus: LoadingStatus.success })
        expect(setAiModelsCatalogMock).not.toHaveBeenCalled()
    })

    it('stores model catalog responses with matrix when returned', async () => {
        const catalog = {
            models: [
                {
                    provider: 'openai',
                    model: 'gpt-4o',
                },
                {
                    provider: 'google',
                    model: 'gemini-flash',
                },
            ],
            mediaGenerationConfigMatrix: {
                version: 'media-generation-config-matrix-v1',
                groups: [{
                    provider: 'openai',
                    models: [],
                }],
            },
        } as const

        requestMock.mockResolvedValue(catalog)

        await service.getAvailableAiModels()

        expect(setAiModelsCatalogMock).toHaveBeenCalledWith(catalog as any)
        expect(setAiModelsMock).not.toHaveBeenCalled()
        expect(setMetaValuesMock).toHaveBeenNthCalledWith(2, { loadingStatus: LoadingStatus.success })
    })

    it('falls back to empty model list when response shape is unknown', async () => {
        requestMock.mockResolvedValue({
            kind: 'unknown',
            notModels: [],
        })

        await service.getAvailableAiModels()

        expect(setAiModelsMock).toHaveBeenCalledWith([])
        expect(setAiModelsCatalogMock).not.toHaveBeenCalled()
        expect(setMetaValuesMock).toHaveBeenNthCalledWith(2, { loadingStatus: LoadingStatus.success })
    })

    it('flags loading error on NATS failures', async () => {
        requestMock.mockRejectedValue(new Error('chat service unavailable'))

        await service.getAvailableAiModels()

        expect(setMetaValuesMock).toHaveBeenNthCalledWith(1, { loadingStatus: LoadingStatus.loading })
        expect(setMetaValuesMock).toHaveBeenCalledWith({ loadingStatus: LoadingStatus.error })
        expect(setAiModelsMock).not.toHaveBeenCalled()
        expect(setAiModelsCatalogMock).not.toHaveBeenCalled()
    })
})
