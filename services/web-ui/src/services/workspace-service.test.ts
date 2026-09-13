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

const mocks = vi.hoisted(() => {
    const workspaceData: {
        workspaceId: string
        updatedAt: number
        canvasStateUpdatedAt?: number
        canvasState: any
        requiresSave: boolean
    } = {
        workspaceId: 'workspace-1',
        updatedAt: 10,
        canvasStateUpdatedAt: 5,
        canvasState: {
            viewport: {
                x: 0,
                y: 0,
                zoom: 1,
            },
            nodes: [],
            edges: [],
        },
        requiresSave: false,
    }
    let routeWorkspaceId = 'workspace-1'

    return {
        workspaceData,
        routeWorkspaceId,
        request: vi.fn(),
        navigateTo: vi.fn(),
        getTokenSilently: vi.fn(),
        setDataValues: vi.fn((values: Record<string, any>) => {
            if (values.canvasState)
                workspaceData.canvasState = values.canvasState

            if (typeof values.updatedAt === 'number')
                workspaceData.updatedAt = values.updatedAt

            if (typeof values.canvasStateUpdatedAt === 'number')
                workspaceData.canvasStateUpdatedAt = values.canvasStateUpdatedAt
        }),
        setMetaValues: vi.fn((values: { requiresSave?: boolean }) => {
            if (typeof values.requiresSave === 'boolean')
                workspaceData.requiresSave = values.requiresSave
        }),
        beginWorkspaceLoad: vi.fn(),
        updateWorkspace: vi.fn(),
    }
})

vi.mock('$src/stores/servicesStore.ts', () => ({
    servicesStore: {
        getData: vi.fn((key: string) => {
            if (key === 'nats')
                return { request: mocks.request }

            return null
        }),
    },
}))

vi.mock('$src/stores/workspaceStore.ts', () => ({
    workspaceStore: {
        getData: vi.fn((key: string) => {
            if (key === 'workspaceId')
                return mocks.workspaceData.workspaceId

            if (key === 'canvasState')
                return mocks.workspaceData.canvasState

            if (key === 'updatedAt')
                return mocks.workspaceData.updatedAt

            if (key === 'canvasStateUpdatedAt')
                return mocks.workspaceData.canvasStateUpdatedAt

            return undefined
        }),
        setDataValues: mocks.setDataValues,
        getMeta: vi.fn(() => mocks.workspaceData.requiresSave),
        setMetaValues: mocks.setMetaValues,
        beginWorkspaceLoad: mocks.beginWorkspaceLoad,
    },
}))

vi.mock('$src/stores/workspacesStore.ts', () => ({
    workspacesStore: {
        updateWorkspace: mocks.updateWorkspace,
    },
}))

import WorkspaceService from './workspace-service.ts'

const createWorkspaceService = (router: ConstructorParameters<typeof WorkspaceService>[0]['router']): WorkspaceService => new WorkspaceService({
    auth: { getTokenSilently: mocks.getTokenSilently },
    router,
})
import { WORKSPACE_ROUTE_LOAD_REQUEST_TIMEOUT_MS } from './requestTimeouts.ts'

const router = {
    getRouteParams: () => ({ workspaceId: mocks.routeWorkspaceId }),
    navigateTo: mocks.navigateTo,
}

const makeCanvasState = (nodeId: string) => ({
    viewport: {
        x: 0,
        y: 0,
        zoom: 1,
    },
    nodes: [{
        nodeId,
        type: 'image',
        fileId: `${nodeId}-file`,
    }],
    edges: [],
} as any)

// =============================================================================
// CANVAS SAVE QUEUE
// =============================================================================

describe('WorkspaceService canvas save queue', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.request.mockReset()
        mocks.getTokenSilently.mockReset()
        mocks.workspaceData.updatedAt = 10
        mocks.workspaceData.canvasStateUpdatedAt = 5
        mocks.routeWorkspaceId = 'workspace-1'
        mocks.getTokenSilently.mockResolvedValue('token-1')
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
        consoleErrorSpy?.mockRestore()
        consoleErrorSpy = null
    })

    it('serializes canvas saves and sends the latest pending state with the acknowledged canvas save token', async () => {
        let resolveFirstSave: ((value: unknown) => void) | null = null
        mocks.request
            .mockImplementationOnce(() =>
                new Promise((resolve) => void (resolveFirstSave = resolve))
            )
            .mockResolvedValueOnce({
                success: true,
                workspaceId: 'workspace-1',
                updatedAt: 12,
                canvasStateUpdatedAt: 7,
            })

        const service = createWorkspaceService(router)
        const firstState = makeCanvasState('first-node')
        const secondState = makeCanvasState('second-node')

        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: firstState,
        })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(1))
        expect(mocks.request.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            canvasState: firstState,
            expectedCanvasStateUpdatedAt: 5,
        }))

        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: secondState,
        })

        resolveFirstSave?.({
            error: 'STALE_CANVAS_STATE',
            currentUpdatedAt: 11,
            currentCanvasStateUpdatedAt: 6,
        })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(2))

        expect(mocks.request.mock.calls[1]?.[0]).toBe(NATS_SUBJECTS.WORKSPACE_SUBJECTS.UPDATE_CANVAS_STATE)
        expect(mocks.request.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
            canvasState: secondState,
            expectedCanvasStateUpdatedAt: 6,
        }))
        await vi.waitFor(() => void expect(mocks.setDataValues).toHaveBeenCalledWith({ updatedAt: 12 }))
        await vi.waitFor(() => void expect(mocks.setDataValues).toHaveBeenCalledWith({ canvasStateUpdatedAt: 7 }))
    })

    it('forwards persistViewport across stale retry and preserves it on queued follow-up saves', async () => {
        let resolveFirstSave: ((value: unknown) => void) | null = null
        mocks.request
            .mockImplementationOnce(() =>
                new Promise((resolve) => void (resolveFirstSave = resolve))
            )
            .mockResolvedValueOnce({
                error: 'STALE_CANVAS_STATE',
                currentUpdatedAt: 11,
                currentCanvasStateUpdatedAt: 6,
            })
            .mockResolvedValueOnce({
                success: true,
                workspaceId: 'workspace-1',
                updatedAt: 12,
                canvasStateUpdatedAt: 7,
            })

        const service = createWorkspaceService(router)
        const firstState = makeCanvasState('persisted-node')
        const secondState = makeCanvasState('queued-node')

        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: firstState,
            persistViewport: true,
        })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(1))
        expect(mocks.request.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            canvasState: firstState,
            persistViewport: true,
            expectedCanvasStateUpdatedAt: 5,
        }))

        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: secondState,
        })

        resolveFirstSave?.({
            error: 'STALE_CANVAS_STATE',
            currentUpdatedAt: 11,
            currentCanvasStateUpdatedAt: 6,
        })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(3))
        expect(mocks.request.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
            canvasState: secondState,
            persistViewport: true,
            expectedCanvasStateUpdatedAt: 6,
        }))
        expect(mocks.request.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
            canvasState: secondState,
            persistViewport: true,
            expectedCanvasStateUpdatedAt: 6,
        }))
    })

    it('does not use workspace updatedAt as the canvas save token after file upload changes metadata', async () => {
        mocks.workspaceData.updatedAt = 99
        mocks.workspaceData.canvasStateUpdatedAt = 5
        mocks.request.mockResolvedValueOnce({
            success: true,
            workspaceId: 'workspace-1',
            updatedAt: 100,
            canvasStateUpdatedAt: 6,
        })

        const service = createWorkspaceService(router)
        const uploadedImageState = makeCanvasState('uploaded-image')

        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: uploadedImageState,
        })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(1))

        expect(mocks.request.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            canvasState: uploadedImageState,
            expectedCanvasStateUpdatedAt: 5,
        }))
        expect(mocks.request.mock.calls[0]?.[1]).not.toEqual(expect.objectContaining({
            expectedUpdatedAt: 99,
        }))
    })

    it('falls back to legacy updatedAt when the loaded workspace has no canvas save token', async () => {
        mocks.workspaceData.updatedAt = 10
        mocks.workspaceData.canvasStateUpdatedAt = undefined
        mocks.request.mockResolvedValueOnce({
            success: true,
            workspaceId: 'workspace-1',
            updatedAt: 12,
            canvasStateUpdatedAt: 11,
        })

        const service = createWorkspaceService(router)
        const firstLegacyState = makeCanvasState('legacy-upload-image')

        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: firstLegacyState,
        })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(1))

        expect(mocks.request.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            canvasState: firstLegacyState,
            expectedCanvasStateUpdatedAt: 10,
        }))
        expect(mocks.request.mock.calls[0]?.[1]).not.toEqual(expect.objectContaining({
            expectedUpdatedAt: 10,
        }))
    })

    it('refreshes through the snapshot port when the server reports stale canvas state', async () => {
        mocks.request.mockResolvedValueOnce({ error: 'STALE_CANVAS_STATE' })
            .mockResolvedValueOnce({
                workspaceId: 'workspace-1',
                updatedAt: 20,
                canvasState: makeCanvasState('authoritative'),
            })
        const service = createWorkspaceService(router)
        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: makeCanvasState('stale-node'),
        })
        await service.canvasSessions.drain()
        expect(mocks.request).toHaveBeenCalledTimes(2)
        expect(mocks.request.mock.calls[1][0]).toBe(NATS_SUBJECTS.WORKSPACE_SUBJECTS.GET_WORKSPACE)
        expect(mocks.setDataValues).toHaveBeenCalledWith({ canvasState: makeCanvasState('authoritative') })
        expect(mocks.setMetaValues).toHaveBeenCalledWith({ requiresSave: false })
    })

    it('refreshes a detached session without patching the newly active workspace', async () => {
        mocks.routeWorkspaceId = 'workspace-2'
        mocks.request.mockResolvedValueOnce({ error: 'STALE_CANVAS_STATE' })
            .mockResolvedValueOnce({
                workspaceId: 'workspace-1',
                updatedAt: 20,
                canvasState: makeCanvasState('authoritative'),
            })
        const service = createWorkspaceService(router)
        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: makeCanvasState('stale-node'),
        })
        await service.canvasSessions.drain()
        expect(mocks.request).toHaveBeenCalledTimes(2)
        expect(mocks.setDataValues).not.toHaveBeenCalled()
        expect(mocks.setMetaValues).not.toHaveBeenCalled()
        expect(mocks.updateWorkspace).toHaveBeenCalledWith('workspace-1', { updatedAt: 20 })
    })

    it('does not include an optimistic canvas save token when none is available', async () => {
        mocks.workspaceData.updatedAt = Number.NaN
        mocks.workspaceData.canvasStateUpdatedAt = undefined
        mocks.request.mockResolvedValueOnce({
            success: true,
            workspaceId: 'workspace-1',
            updatedAt: 12,
            canvasStateUpdatedAt: 13,
        })

        const service = createWorkspaceService(router)
        const staleState = makeCanvasState('no-token')

        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: staleState,
        })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(1))
        expect(mocks.request.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            canvasState: staleState,
            token: 'token-1',
        }))
        expect(mocks.request.mock.calls[0]?.[1]).not.toHaveProperty('expectedCanvasStateUpdatedAt')
    })

    it('retries queued canvas updates after a non-stale error, then marks save complete on success', async () => {
        let resolveFirstSave: ((value: unknown) => void) | null = null
        mocks.request
            .mockImplementationOnce(() =>
                new Promise((resolve) => void (resolveFirstSave = resolve))
            )
            .mockResolvedValueOnce({
                success: true,
                workspaceId: 'workspace-1',
                updatedAt: 20,
                canvasStateUpdatedAt: 19,
            })

        const service = createWorkspaceService(router)
        const stateA = makeCanvasState('state-a')
        const stateB = makeCanvasState('state-b')

        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: stateA,
        })
        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(1))
        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: stateB,
        })
        resolveFirstSave?.({ error: 'UNAVAILABLE' })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(2))

        expect(mocks.setMetaValues).toHaveBeenCalledWith({ requiresSave: true })
        expect(mocks.setMetaValues).toHaveBeenCalledWith({ requiresSave: false })
        expect(mocks.setDataValues).toHaveBeenCalledWith({ updatedAt: 20 })
        expect(mocks.setDataValues).toHaveBeenCalledWith({ canvasStateUpdatedAt: 19 })
        expect(mocks.request.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
            canvasState: stateB,
            expectedCanvasStateUpdatedAt: 5,
        }))
    })

    // =========================================================================
    // STALE_CANVAS_STATE RETRY WITH REFRESHED TOKEN
    // =========================================================================

    it('retries a stale save with the server-supplied token instead of refetching the whole workspace', async () => {
        mocks.request
            .mockResolvedValueOnce({
                error: 'STALE_CANVAS_STATE',
                currentUpdatedAt: 11,
                currentCanvasStateUpdatedAt: 6,
            })
            .mockResolvedValueOnce({
                success: true,
                workspaceId: 'workspace-1',
                updatedAt: 12,
                canvasStateUpdatedAt: 7,
            })

        const service = createWorkspaceService(router)
        const getWorkspaceSpy = vi.spyOn(service as unknown as { getWorkspace: (args: { workspaceId: string }) => Promise<void> }, 'getWorkspace')
            .mockResolvedValue(undefined)
        const staleState = makeCanvasState('stale-node')

        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: staleState,
        })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(2))

        expect(getWorkspaceSpy).not.toHaveBeenCalled()
        expect(mocks.request.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
            canvasState: staleState,
            expectedCanvasStateUpdatedAt: 6,
        }))
        expect(mocks.updateWorkspace).toHaveBeenCalledWith('workspace-1', { updatedAt: 11 })
        expect(mocks.setDataValues).toHaveBeenCalledWith({ updatedAt: 11 })
        expect(mocks.setDataValues).toHaveBeenCalledWith({ canvasStateUpdatedAt: 6 })
        await vi.waitFor(() => void expect(mocks.setMetaValues).toHaveBeenCalledWith({ requiresSave: false }))
    })

    it('retries accepted writes after navigation without adopting their versions into another workspace', async () => {
        mocks.routeWorkspaceId = 'workspace-2'
        mocks.request.mockResolvedValueOnce({
            error: 'STALE_CANVAS_STATE',
            currentUpdatedAt: 11,
            currentCanvasStateUpdatedAt: 6,
        })
            .mockResolvedValueOnce({
                success: true,
                workspaceId: 'workspace-1',
                updatedAt: 12,
                canvasStateUpdatedAt: 7,
            })
        const service = createWorkspaceService(router)
        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: makeCanvasState('stale-node'),
        })
        await service.canvasSessions.drain()
        expect(mocks.request).toHaveBeenCalledTimes(2)
        expect(mocks.request.mock.calls[1][1].expectedCanvasStateUpdatedAt).toBe(6)
        expect(mocks.setDataValues).not.toHaveBeenCalled()
        expect(mocks.setMetaValues).not.toHaveBeenCalled()
    })

    it('falls back to a snapshot refetch after exhausting the stale-retry budget', async () => {
        mocks.request
            .mockResolvedValueOnce({
                error: 'STALE_CANVAS_STATE',
                currentUpdatedAt: 11,
                currentCanvasStateUpdatedAt: 6,
            })
            .mockResolvedValueOnce({
                error: 'STALE_CANVAS_STATE',
                currentUpdatedAt: 12,
                currentCanvasStateUpdatedAt: 7,
            })
            .mockResolvedValueOnce({
                error: 'STALE_CANVAS_STATE',
                currentUpdatedAt: 13,
                currentCanvasStateUpdatedAt: 8,
            })
            .mockResolvedValueOnce({
                error: 'STALE_CANVAS_STATE',
                currentUpdatedAt: 14,
                currentCanvasStateUpdatedAt: 9,
            })
            .mockResolvedValueOnce({
                workspaceId: 'workspace-1',
                updatedAt: 20,
                canvasState: makeCanvasState('authoritative'),
            })
        const service = createWorkspaceService(router)
        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: makeCanvasState('stale-node'),
        })
        await service.canvasSessions.drain()
        expect(mocks.request).toHaveBeenCalledTimes(5)
        expect(mocks.request.mock.calls[4][0]).toBe(NATS_SUBJECTS.WORKSPACE_SUBJECTS.GET_WORKSPACE)
        expect(mocks.setMetaValues).toHaveBeenCalledWith({ requiresSave: false })
    })

    it('refetches when a stale response omits the canvas version', async () => {
        mocks.request.mockResolvedValueOnce({
            error: 'STALE_CANVAS_STATE',
            currentUpdatedAt: 11,
        })
            .mockResolvedValueOnce({
                workspaceId: 'workspace-1',
                updatedAt: 20,
                canvasState: makeCanvasState('authoritative'),
            })
        const service = createWorkspaceService(router)
        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: makeCanvasState('stale-node'),
        })
        await service.canvasSessions.drain()
        expect(mocks.request).toHaveBeenCalledTimes(2)
        expect(mocks.request.mock.calls[1][0]).toBe(NATS_SUBJECTS.WORKSPACE_SUBJECTS.GET_WORKSPACE)
    })

    it('resets the stale-retry budget once a subsequent save succeeds', async () => {
        mocks.request
            .mockResolvedValueOnce({
                error: 'STALE_CANVAS_STATE',
                currentUpdatedAt: 11,
                currentCanvasStateUpdatedAt: 6,
            })
            .mockResolvedValueOnce({
                success: true,
                workspaceId: 'workspace-1',
                updatedAt: 12,
                canvasStateUpdatedAt: 7,
            })

        const service = createWorkspaceService(router)
        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: makeCanvasState('first-node'),
        })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => void expect(mocks.setMetaValues).toHaveBeenCalledWith({ requiresSave: false }))

        mocks.request.mockClear()
        mocks.request
            .mockResolvedValueOnce({
                error: 'STALE_CANVAS_STATE',
                currentUpdatedAt: 21,
                currentCanvasStateUpdatedAt: 20,
            })
            .mockResolvedValueOnce({
                success: true,
                workspaceId: 'workspace-1',
                updatedAt: 22,
                canvasStateUpdatedAt: 21,
            })

        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: makeCanvasState('second-node'),
        })

        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(2))
        expect(mocks.request.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
            expectedCanvasStateUpdatedAt: 20,
        }))
    })

    // =========================================================================
    // CANVAS MEMBERSHIP WRITE COORDINATION
    // =========================================================================

    it('serializes three overlapping membership mutations and exposes the latest revision to each next mutation', async () => {
        let releaseFirstMutation: (() => void) | null = null
        const firstMutationStarted = new Promise<void>((resolve) => void (releaseFirstMutation = resolve))
        let startFirstMutation: (() => void) | null = null
        const firstMutationEntered = new Promise<void>((resolve) => void (startFirstMutation = resolve))
        const observedRevisions: number[] = []
        let secondMutationStarted = false
        let thirdMutationStarted = false
        const service = createWorkspaceService(router)

        const firstMutation = service.runCanvasMembershipMutation({
            workspaceId: 'workspace-1',
            mutation: async () => {
                observedRevisions.push(mocks.workspaceData.canvasStateUpdatedAt ?? 0)
                startFirstMutation?.()
                await firstMutationStarted
                mocks.workspaceData.canvasStateUpdatedAt = 6

                return 'first'
            },
        })

        await firstMutationEntered
        const secondMutation = service.runCanvasMembershipMutation({
            workspaceId: 'workspace-1',
            mutation: async () => {
                secondMutationStarted = true
                observedRevisions.push(mocks.workspaceData.canvasStateUpdatedAt ?? 0)
                mocks.workspaceData.canvasStateUpdatedAt = 7

                return 'second'
            },
        })
        const thirdMutation = service.runCanvasMembershipMutation({
            workspaceId: 'workspace-1',
            mutation: async () => {
                thirdMutationStarted = true
                observedRevisions.push(mocks.workspaceData.canvasStateUpdatedAt ?? 0)

                return 'third'
            },
        })

        await Promise.resolve()
        expect(secondMutationStarted).toBe(false)
        expect(thirdMutationStarted).toBe(false)

        releaseFirstMutation?.()
        await expect(firstMutation).resolves.toBe('first')
        await expect(secondMutation).resolves.toBe('second')
        await expect(thirdMutation).resolves.toBe('third')
        expect(observedRevisions).toEqual([5, 6, 7])
    })

    it('holds normal saves until an in-flight membership mutation has committed', async () => {
        let releaseMutation: (() => void) | null = null
        const mutationReleased = new Promise<void>((resolve) => void (releaseMutation = resolve))
        let markMutationStarted: (() => void) | null = null
        const mutationStarted = new Promise<void>((resolve) => void (markMutationStarted = resolve))
        mocks.request.mockResolvedValueOnce({
            success: true,
            workspaceId: 'workspace-1',
            updatedAt: 12,
            canvasStateUpdatedAt: 7,
        })

        const service = createWorkspaceService(router)
        const membershipMutation = service.runCanvasMembershipMutation({
            workspaceId: 'workspace-1',
            mutation: async () => {
                markMutationStarted?.()
                await mutationReleased
                mocks.workspaceData.canvasStateUpdatedAt = 6
            },
        })

        await mutationStarted
        const queuedState = makeCanvasState('queued-during-attach')
        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: queuedState,
        })
        await Promise.resolve()
        expect(mocks.request).not.toHaveBeenCalled()

        releaseMutation?.()
        await membershipMutation
        await vi.waitFor(() => void expect(mocks.request).toHaveBeenCalledTimes(1))
        expect(mocks.request.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            canvasState: queuedState,
            expectedCanvasStateUpdatedAt: 6,
        }))
    })

    it('drops queued saves included in the next serialized membership mutation', async () => {
        const service = createWorkspaceService(router)
        const first = Promise.withResolvers<void>()
        const firstMutation = service.runCanvasMembershipMutation({
            workspaceId: 'workspace-1',
            mutation: async () => await first.promise,
        })
        const secondMutation = service.runCanvasMembershipMutation({
            workspaceId: 'workspace-1',
            mutation: async () => 'attached',
        })
        service.updateCanvasState({
            workspaceId: 'workspace-1',
            canvasState: makeCanvasState('included-in-membership'),
        })
        first.resolve()
        await firstMutation
        expect(await secondMutation).toBe('attached')
        await service.canvasSessions.drain()
        expect(mocks.request).not.toHaveBeenCalled()
        expect(mocks.setMetaValues).toHaveBeenCalledWith({ requiresSave: false })
    })
})

describe('WorkspaceService state loading', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.request.mockReset()
        mocks.getTokenSilently.mockReset()
        mocks.workspaceData.updatedAt = 10
        mocks.workspaceData.canvasStateUpdatedAt = 5
        mocks.routeWorkspaceId = 'workspace-1'
        mocks.getTokenSilently.mockResolvedValue('token-1')
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
        consoleErrorSpy?.mockRestore()
        consoleErrorSpy = null
    })

    it('loads workspace data and normalizes missing canvas state edges', async () => {
        const service = createWorkspaceService(router)
        mocks.request.mockResolvedValueOnce({
            workspaceId: 'workspace-1',
            name: 'Project',
            updatedAt: 10,
            canvasState: {
                nodes: [{
                    nodeId: 'n1',
                    type: 'image',
                }],
                dimensions: {
                    width: 100,
                    height: 100,
                },
            },
        })

        await service.getWorkspace({ workspaceId: 'workspace-1' })

        expect(mocks.beginWorkspaceLoad).toHaveBeenCalledWith('workspace-1')
        expect(mocks.request).toHaveBeenCalledWith(NATS_SUBJECTS.WORKSPACE_SUBJECTS.GET_WORKSPACE, {
            token: 'token-1',
            workspaceId: 'workspace-1',
        }, WORKSPACE_ROUTE_LOAD_REQUEST_TIMEOUT_MS)
        expect(mocks.setMetaValues).toHaveBeenCalledWith({ loadingStatus: LoadingStatus.success })
        expect(mocks.setDataValues).toHaveBeenCalledWith(expect.objectContaining({
            workspaceId: 'workspace-1',
            updatedAt: 10,
            canvasStateUpdatedAt: 10,
            canvasState: expect.objectContaining({
                edges: [],
            }),
        }))
    })

    it('does nothing with workspace payload when the active route changed', async () => {
        mocks.routeWorkspaceId = 'other-workspace'
        const service = createWorkspaceService(router)
        mocks.request.mockResolvedValueOnce({
            workspaceId: 'workspace-1',
            updatedAt: 10,
            canvasState: {
                nodes: [],
                edges: [],
            },
        })

        await service.getWorkspace({ workspaceId: 'workspace-1' })

        expect(mocks.beginWorkspaceLoad).not.toHaveBeenCalled()
        expect(mocks.setMetaValues).not.toHaveBeenCalledWith({ loadingStatus: LoadingStatus.success })
        expect(mocks.setDataValues).not.toHaveBeenCalled()
    })

    it('keeps stale canvas cleared when the active workspace load times out', async () => {
        const timeout = new Error('timeout')
        const service = createWorkspaceService(router)
        mocks.request.mockRejectedValueOnce(timeout)

        await service.getWorkspace({ workspaceId: 'workspace-1' })

        expect(mocks.beginWorkspaceLoad).toHaveBeenCalledWith('workspace-1')
        expect(mocks.setMetaValues).toHaveBeenCalledWith({ loadingStatus: LoadingStatus.error })
        expect(mocks.setDataValues).toHaveBeenCalledWith({ error: timeout })
        expect(mocks.setDataValues).not.toHaveBeenCalledWith(expect.objectContaining({
            canvasState: expect.objectContaining({
                nodes: expect.arrayContaining([expect.anything()]),
            }),
        }))
    })
})
