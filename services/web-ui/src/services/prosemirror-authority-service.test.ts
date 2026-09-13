import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { NATS_SUBJECTS } from '@lixpi/constants'
import {
    getAssetDocumentEventSubject,
    type AssetStepStreamEvent,
    type SubmitResult,
} from '@lixpi/prosemirror'

import { ProseMirrorAuthorityService } from '$src/services/prosemirror-authority-service.ts'

const {
    DOCUMENT_SUBMIT_STEPS: DOC_SUBMIT_STEPS,
    DOCUMENT_RESUME: DOC_RESUME,
} = NATS_SUBJECTS.ASSET_SUBJECTS

const mocks = vi.hoisted(() => ({
    getData: vi.fn(),
    getTokenSilently: vi.fn(),
    uuid: vi.fn(() => 'client-uuid'),
    stepFromJSON: vi.fn(),
    acquireLease: vi.fn(),
    renewLease: vi.fn(),
    releaseLease: vi.fn(),
    get: vi.fn(),
    fetchDocumentSnapshot: vi.fn(),
}))

let consoleErrorSpy: { mockRestore: () => void } | null = null

vi.mock('uuid', () => ({ v4: mocks.uuid }))

vi.mock('$src/stores/servicesStore.ts', () => ({
    servicesStore: {
        getData: mocks.getData,
    },
}))

vi.mock('@lixpi/prosemirror', async () => {
    const actual = await vi.importActual<typeof import('@lixpi/prosemirror')>('@lixpi/prosemirror')

    return {
        ...actual,
        Step: {
            ...actual.Step,
            fromJSON: mocks.stepFromJSON,
        },
    }
})

type MockTransaction = {
    metadata: Map<string, unknown>
    setMeta: ReturnType<typeof vi.fn>
    replaceWith: ReturnType<typeof vi.fn>
    step: ReturnType<typeof vi.fn>
}

const flushPromises = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const createDeferred = <T>(): {
    promise: Promise<T>
    resolve: (value: T) => void
} => {
    let resolvePromise: ((value: T) => void) | undefined
    const promise = new Promise<T>((resolve) => void (resolvePromise = resolve))

    return {
        promise,
        resolve: (value: T) => resolvePromise?.(value),
    }
}

const createTransaction = (): MockTransaction => {
    const transaction: MockTransaction = {
        metadata: new Map(),
        setMeta: vi.fn((key: string, value: unknown) => {
            transaction.metadata.set(key, value)

            return transaction
        }),
        replaceWith: vi.fn(() => transaction),
        step: vi.fn(() => transaction),
    }

    return transaction
}

const createView = () => {
    const transactions: MockTransaction[] = []
    const doc = {
        content: { size: 0 },
        toJSON: vi.fn(() => ({
            type: 'doc',
            content: [],
        })),
    }

    return {
        transactions,
        view: {
            state: {
                doc,
                schema: {
                    nodeFromJSON: vi.fn(() => ({
                        content: { size: 0 },
                    })),
                },
                get tr() {
                    const transaction = createTransaction()
                    transactions.push(transaction)

                    return transaction
                },
            },
            dispatch: vi.fn(),
        },
    }
}

const createNats = () => {
    return {
        subscribe: vi.fn(),
        request: vi.fn(),
    }
}

const createEvent = (overrides: Record<string, unknown>) => {
    return {
        organizationId: 'org-1',
        assetId: 'asset-1',
        role: 'content',
        ...overrides,
    }
}

const coordinate = {
    organizationId: 'org-1',
    workspaceId: 'workspace-1',
    assetId: 'asset-1',
    role: 'content' as const,
}

const eventSubject = getAssetDocumentEventSubject('user-1', {
    organizationId: coordinate.organizationId,
    assetId: coordinate.assetId,
    role: coordinate.role,
})

const dependencies = {
    assetService: {
        acquireLease: mocks.acquireLease,
        renewLease: mocks.renewLease,
        releaseLease: mocks.releaseLease,
        get: mocks.get,
        fetchDocumentSnapshot: mocks.fetchDocumentSnapshot,
    } as never,
    auth: { getTokenSilently: mocks.getTokenSilently },
    userStore: { getData: () => 'user-1' } as never,
}

describe('ProseMirrorAuthorityService', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        mocks.getTokenSilently.mockResolvedValue('auth-token')
        mocks.stepFromJSON.mockReturnValue({
            toJSON: vi.fn(() => ({ type: 'replace' })),
            invert: vi.fn(() => ({})),
            getMap: vi.fn(() => ({})),
        })
        mocks.acquireLease.mockResolvedValue({
            leaseId: 'lease-1',
            workspaceId: coordinate.workspaceId,
            expiresAt: 999,
        })
        mocks.renewLease.mockResolvedValue({ leaseId: 'lease-1' })
        mocks.releaseLease.mockResolvedValue(undefined)
        mocks.get.mockResolvedValue({ editLease: undefined })
        mocks.fetchDocumentSnapshot.mockImplementation(async (reference: any) => reference)
    })

    afterEach(() => {
        vi.useRealTimers()
        consoleErrorSpy?.mockRestore()
        consoleErrorSpy = null
    })

    it('acquires a lease, subscribes to the asset document event subject, and resumes authority state', async () => {
        const nats = createNats()
        nats.request.mockResolvedValue({
            snapshot: null,
            currentVersion: 0,
            currentStreamSeq: 0,
            events: [],
            liveSubject: eventSubject,
        })
        mocks.getData.mockReturnValue(nats)

        const { view } = createView()
        const onLeaseStateChange = vi.fn()

        const service = new ProseMirrorAuthorityService({
            ...dependencies,
            ...coordinate,
            baseVersion: 0,
            getView: () => view,
            onLeaseStateChange,
        })

        await flushPromises()

        expect(mocks.acquireLease).toHaveBeenCalledWith(coordinate.assetId, coordinate.workspaceId, 'client-uuid')
        expect(onLeaseStateChange).toHaveBeenCalledWith({ readOnly: false })
        expect(nats.subscribe).toHaveBeenCalledWith(eventSubject, expect.any(Function))
        expect(nats.request).toHaveBeenCalledWith(
            DOC_RESUME,
            expect.objectContaining({
                token: 'auth-token',
                organizationId: coordinate.organizationId,
                assetId: coordinate.assetId,
                role: coordinate.role,
                localVersion: 0,
                localStreamSeq: 0,
                acceptSnapshot: true,
                activateLiveRelay: true,
            }),
            expect.any(Number),
        )
        service.disconnect()
    })

    it('does not acquire a lease or submit local transactions in receive-only mode', async () => {
        const nats = createNats()
        nats.request.mockResolvedValue({
            snapshot: null,
            currentVersion: 0,
            currentStreamSeq: 0,
            events: [],
            liveSubject: eventSubject,
        })
        mocks.getData.mockReturnValue(nats)
        const { view } = createView()

        const service = new ProseMirrorAuthorityService({
            ...dependencies,
            ...coordinate,
            baseVersion: 0,
            receiveOnly: true,
            getView: () => view,
        })

        await flushPromises()

        expect(mocks.acquireLease).not.toHaveBeenCalled()

        service.submitLocalTransaction({
            docChanged: true,
            getMeta: vi.fn(() => false),
            steps: [{ toJSON: () => ({
                type: 'replace',
                index: 1,
            }) }],
            docs: [{}],
        } as any)

        expect(view.dispatch).not.toHaveBeenCalled()
        expect(nats.request).toHaveBeenCalledTimes(1)
        service.disconnect()
    })

    it('releases a lease resolved after disconnect without notifying or subscribing', async () => {
        const nats = createNats()
        mocks.getData.mockReturnValue(nats)
        const deferredLease = createDeferred<{
            leaseId: string
            workspaceId: string
            expiresAt: number
        }>()
        mocks.acquireLease.mockReturnValue(deferredLease.promise)
        const { view } = createView()
        const onLeaseStateChange = vi.fn()

        const service = new ProseMirrorAuthorityService({
            ...dependencies,
            ...coordinate,
            baseVersion: 0,
            getView: () => view,
            onLeaseStateChange,
        })
        service.disconnect()
        deferredLease.resolve({
            leaseId: 'late-lease',
            workspaceId: coordinate.workspaceId,
            expiresAt: 999,
        })
        await flushPromises()

        expect(mocks.releaseLease).toHaveBeenCalledWith(
            coordinate.assetId,
            coordinate.workspaceId,
            'late-lease',
            'client-uuid',
        )
        expect(onLeaseStateChange).not.toHaveBeenCalled()
        expect(nats.subscribe).not.toHaveBeenCalled()
        expect(nats.request).not.toHaveBeenCalled()
    })

    it('applies out-of-order steps once replayed and drains backlog', async () => {
        vi.useFakeTimers()
        const nats = createNats()
        nats.request
            .mockResolvedValueOnce({
                snapshot: null,
                currentVersion: 0,
                currentStreamSeq: 0,
                events: [],
                liveSubject: eventSubject,
            })
            .mockResolvedValueOnce({
                snapshot: null,
                currentVersion: 1,
                currentStreamSeq: 2,
                liveSubject: eventSubject,
                events: [
                    createEvent({
                        kind: 'STEP',
                        version: 1,
                        step: { stepType: 'replace' },
                        streamSequence: 2,
                    }),
                ],
            })
        mocks.getData.mockReturnValue(nats)

        const { view } = createView()
        const onRemoteDocumentChange = vi.fn()
        let subscriptionHandler: (event: AssetStepStreamEvent) => void = () => undefined
        nats.subscribe.mockImplementation((_subject: string, handler: (event: AssetStepStreamEvent) => void) => {
            subscriptionHandler = handler

            return { unsubscribe: vi.fn() }
        })

        const service = new ProseMirrorAuthorityService({
            ...dependencies,
            ...coordinate,
            baseVersion: 0,
            getView: () => view,
            onRemoteDocumentChange,
        })

        await vi.advanceTimersByTimeAsync(0)

        subscriptionHandler(createEvent({
            kind: 'STEP',
            version: 2,
            step: { stepType: 'replace' },
            streamSequence: 2,
        }) as AssetStepStreamEvent)
        await vi.advanceTimersByTimeAsync(0)
        await Promise.resolve()

        expect(onRemoteDocumentChange).toHaveBeenCalledTimes(2)
        expect(nats.request).toHaveBeenCalledTimes(2)
        // The out-of-order STEP is only queued (not applied) at the moment resume()
        // is re-triggered, so localStreamSeq has not advanced past the initial value yet.
        expect(nats.request).toHaveBeenNthCalledWith(
            2,
            DOC_RESUME,
            expect.objectContaining({
                localVersion: 0,
                localStreamSeq: 0,
            }),
            expect.any(Number),
        )

        service.disconnect()
    })

    it('applies a snapshot from resume and updates expected version for future local submits', async () => {
        vi.useFakeTimers()
        const nats = createNats()
        nats.request
            .mockResolvedValueOnce({
                snapshot: {
                    assetId: coordinate.assetId,
                    organizationId: coordinate.organizationId,
                    role: coordinate.role,
                    version: 2,
                    doc: {
                        type: 'doc',
                        content: [],
                    },
                },
                currentVersion: 2,
                currentStreamSeq: 3,
                liveSubject: eventSubject,
                events: [],
            })
            .mockResolvedValueOnce({
                status: 'ACCEPTED',
                version: 2,
            })
        mocks.getData.mockReturnValue(nats)

        const { view } = createView()

        const service = new ProseMirrorAuthorityService({
            ...dependencies,
            ...coordinate,
            baseVersion: 0,
            getView: () => view,
        })

        await vi.advanceTimersByTimeAsync(0)
        service.submitLocalTransaction({
            docChanged: true,
            getMeta: vi.fn(() => false),
            steps: [{ toJSON: () => ({
                type: 'replace',
                index: 1,
            }) }],
            docs: [{}],
        } as any)

        expect(nats.request).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(100)
        await Promise.resolve()

        expect(view.state.schema.nodeFromJSON).toHaveBeenCalledWith({
            type: 'doc',
            content: [],
        })
        expect(nats.request).toHaveBeenNthCalledWith(
            2,
            DOC_SUBMIT_STEPS,
            expect.objectContaining({
                expectedVersion: 2,
            }),
        )

        service.disconnect()
    })

    it('batches multiple local steps and submits one request after the debounce window', async () => {
        vi.useFakeTimers()
        const nats = createNats()
        nats.request
            .mockResolvedValueOnce({
                snapshot: null,
                currentVersion: 0,
                currentStreamSeq: 0,
                events: [],
                liveSubject: eventSubject,
            })
            .mockResolvedValueOnce({
                status: 'ACCEPTED',
                version: 2,
            })
        mocks.getData.mockReturnValue(nats)

        const { view } = createView()

        const service = new ProseMirrorAuthorityService({
            ...dependencies,
            ...coordinate,
            baseVersion: 0,
            getView: () => view,
        })

        await vi.advanceTimersByTimeAsync(0)

        service.submitLocalTransaction({
            docChanged: true,
            getMeta: vi.fn(() => false),
            steps: [
                { toJSON: () => ({
                    type: 'replace',
                    index: 1,
                }) },
                { toJSON: () => ({
                    type: 'replace',
                    index: 2,
                }) },
            ],
            docs: [{}, {}],
        } as any)

        expect(nats.request).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(100)
        await Promise.resolve()

        expect(nats.request).toHaveBeenCalledTimes(2)
        expect(nats.request).toHaveBeenNthCalledWith(
            2,
            DOC_SUBMIT_STEPS,
            expect.objectContaining({
                token: 'auth-token',
                organizationId: coordinate.organizationId,
                assetId: coordinate.assetId,
                role: coordinate.role,
                workspaceId: coordinate.workspaceId,
                leaseId: 'lease-1',
                expectedVersion: 0,
                steps: [
                    expect.objectContaining({
                        msgId: expect.stringContaining('asset-pm-client-uuid-'),
                        clientId: 'client-uuid',
                    }),
                    expect.objectContaining({
                        msgId: expect.stringContaining('asset-pm-client-uuid-'),
                        clientId: 'client-uuid',
                    }),
                ],
            }),
        )

        service.disconnect()
    })

    it('flushes immediately when local batch reaches max size', async () => {
        vi.useFakeTimers()
        const nats = createNats()
        const submitResponse: SubmitResult = {
            status: 'ACCEPTED',
            version: 50,
        }
        nats.request
            .mockResolvedValueOnce({
                snapshot: null,
                currentVersion: 0,
                currentStreamSeq: 0,
                events: [],
                liveSubject: eventSubject,
            })
            .mockResolvedValueOnce(submitResponse)
        mocks.getData.mockReturnValue(nats)

        const { view } = createView()

        const service = new ProseMirrorAuthorityService({
            ...dependencies,
            ...coordinate,
            baseVersion: 0,
            getView: () => view,
        })

        await vi.advanceTimersByTimeAsync(0)

        const steps = Array.from({ length: 50 }, (_, index) => ({ toJSON: () => ({
            type: 'replace',
            index,
        }) }))
        service.submitLocalTransaction({
            docChanged: true,
            getMeta: vi.fn(() => false),
            steps,
            docs: Array.from({ length: 50 }, () => ({})),
        } as any)

        await vi.advanceTimersByTimeAsync(0)
        await Promise.resolve()

        expect(nats.request).toHaveBeenCalledTimes(2)
        expect(nats.request).toHaveBeenNthCalledWith(
            2,
            DOC_SUBMIT_STEPS,
            expect.objectContaining({
                expectedVersion: 0,
                steps: expect.arrayContaining([
                    expect.objectContaining({
                        clientId: 'client-uuid',
                    }),
                ]),
            }),
        )
        service.disconnect()
    })

    it('retries resume until events stop arriving faster than local processing (hasMore drains in a loop)', async () => {
        vi.useFakeTimers()
        const nats = createNats()
        nats.request
            .mockResolvedValueOnce({
                snapshot: null,
                currentVersion: 0,
                currentStreamSeq: 1,
                liveSubject: eventSubject,
                hasMore: true,
                events: [
                    createEvent({
                        kind: 'STEP',
                        version: 1,
                        step: { stepType: 'replace' },
                        streamSequence: 1,
                    }),
                ],
            })
            .mockResolvedValueOnce({
                snapshot: null,
                currentVersion: 2,
                currentStreamSeq: 2,
                liveSubject: eventSubject,
                hasMore: false,
                events: [
                    createEvent({
                        kind: 'STEP',
                        version: 2,
                        step: { stepType: 'replace' },
                        streamSequence: 2,
                    }),
                ],
            })
        mocks.getData.mockReturnValue(nats)

        const { view } = createView()

        const service = new ProseMirrorAuthorityService({
            ...dependencies,
            ...coordinate,
            baseVersion: 0,
            getView: () => view,
        })

        await vi.advanceTimersByTimeAsync(0)
        await Promise.resolve()
        await Promise.resolve()

        expect(nats.request).toHaveBeenCalledTimes(2)
        expect(view.dispatch).toHaveBeenCalledTimes(2)

        service.disconnect()
    })

    it('releases the lease and unsubscribes on disconnect, preventing further submission', async () => {
        vi.useFakeTimers()
        const nats = createNats()
        nats.request.mockResolvedValue({
            snapshot: null,
            currentVersion: 0,
            currentStreamSeq: 0,
            events: [],
            liveSubject: eventSubject,
        })
        const unsubscribeMock = vi.fn()
        nats.subscribe.mockReturnValue({ unsubscribe: unsubscribeMock })
        mocks.getData.mockReturnValue(nats)

        const { view } = createView()
        const service = new ProseMirrorAuthorityService({
            ...dependencies,
            ...coordinate,
            baseVersion: 0,
            getView: () => view,
        })

        await vi.advanceTimersByTimeAsync(0)
        await Promise.resolve()
        await Promise.resolve()
        service.disconnect()

        expect(unsubscribeMock).toHaveBeenCalled()
        expect(mocks.releaseLease).toHaveBeenCalledWith(coordinate.assetId, coordinate.workspaceId, 'lease-1', 'client-uuid')

        service.submitLocalTransaction({
            docChanged: true,
            getMeta: vi.fn(() => false),
            steps: [{ toJSON: () => ({
                type: 'replace',
                index: 1,
            }) }],
            docs: [{}],
        } as any)

        await vi.advanceTimersByTimeAsync(100)
        expect(nats.request).toHaveBeenCalledTimes(1)
    })
})
