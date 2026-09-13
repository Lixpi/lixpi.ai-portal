import {
    WorkspaceAssetProjection,
    WorkspaceAssetSynchronization,
} from '@lixpi/canvas-components-lixpi-specific/shared'
import {
    getAssetEventSubject,
    NATS_SUBJECTS,
    type Asset,
    type AssetDocumentRole,
    type AssetMeta,
    type AssetPrimaryCategory,
    type AssetScope,
    type SubjectIdentityClassification,
    type GeneratedOutputReviewRequest,
    type GeneratedOutputReviewResponse,
} from '@lixpi/constants'
import {
    type AssetDocResumeResult,
    type AssetDocSnapshot,
    type AssetDocSnapshotReference,
} from '@lixpi/prosemirror'
import {
    type AuthTokenProvider,
    type UserStateStore,
} from '@lixpi/auth-client'

import { servicesStore } from '$src/stores/servicesStore.ts'
import { assetsStore } from '$src/stores/assetsStore.ts'
import {
    assetDocumentsStore,
    type AssetDocumentSnapshot,
} from '$src/stores/assetDocumentsStore.ts'
import { workspaceStore } from '$src/stores/workspaceStore.ts'

const { ASSET_SUBJECTS } = NATS_SUBJECTS
const ASSET_LOAD_CONCURRENCY = 8
const ASSET_DOCUMENT_RESUME_TIMEOUT_MS = 15000
const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

export type AssetServiceConfig = {
    auth: AuthTokenProvider
    userStore: UserStateStore
}

const mapWithConcurrency = async <T, R>(
    items: T[],
    concurrency: number,
    mapItem: (item: T) => Promise<R>,
): Promise<R[]> => {
    const results = new Array<R>(items.length)
    const entries = items.entries()

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        async () => {
            while (true) {
                const entry = entries.next()

                if (entry.done)
                    return

                const [index, item] = entry.value
                results[index] = await mapItem(item)
            }
        },
    )
    await Promise.all(workers)

    return results
}

export class AssetService {
    private readonly workspaceAssets: WorkspaceAssetProjection

    constructor(private readonly config: AssetServiceConfig) {
        this.workspaceAssets = new WorkspaceAssetProjection({
            get: (assetId, workspaceId) => this.get(assetId, workspaceId),
            hasDocument: (assetId, role) => Boolean(
                assetDocumentsStore.get(assetId, role),
            ),
            resumeDocument: coordinate => this.resumeDocumentSnapshot(coordinate),
            publishAssets: (workspaceId, assets) => assetsStore.setAssets(workspaceId, assets),
            publishDocuments: snapshots => assetDocumentsStore.setMany(snapshots),
            setLoading: workspaceId => assetsStore.setLoading(workspaceId),
            setError: error => assetsStore.setError(error),
            reportError: (message, error) => console.warn(
                '[AssetService]',
                message,
                error,
            ),
        })
    }

    private async request<T>(
        subject: string,
        payload: Record<string, unknown>,
        timeout?: number,
    ): Promise<T> {
        const nats = servicesStore.getData('nats')

        if (!nats)
            throw new Error('NATS service unavailable')

        return (await nats.request(
            subject,
            {
                token: await this.config.auth.getTokenSilently(),
                ...payload,
            },
            timeout,
        )) as T
    }

    private async loadAssetsById(
        assetIds: readonly string[],
        workspaceId?: string,
    ): Promise<Asset[]> {
        const results = await mapWithConcurrency(
            [...assetIds],
            ASSET_LOAD_CONCURRENCY,
            async assetId => {
                try {
                    return await this.get(assetId, workspaceId)
                } catch (error) {
                    console.warn(
                        '[AssetService] Asset load failed; synchronization will retry it',
                        {
                            assetId,
                            error,
                        },
                    )

                    return { error: 'ASSET_LOAD_FAILED' }
                }
            },
        )

        return results.filter((result): result is Asset => !('error' in result))
    }

    async fetchDocumentSnapshot(reference: AssetDocSnapshotReference): Promise<AssetDocSnapshot> {
        const response = await fetch(
            `${API_BASE_URL}${reference.url}`,
            {
                headers: { Authorization: `Bearer ${await this.config.auth.getTokenSilently()}` },
            },
        )

        if (!response.ok)
            throw new Error(`Asset document snapshot fetch failed: ${response.status}`)

        const snapshot = (await response.json()) as AssetDocSnapshot

        if (
            snapshot.assetId !== reference.assetId
            || snapshot.organizationId !== reference.organizationId
            || snapshot.role !== reference.role
        )
            throw new Error('ASSET_DOCUMENT_SNAPSHOT_COORDINATE_MISMATCH')

        return snapshot
    }

    async get(
        assetId: string,
        workspaceId?: string,
    ): Promise<Asset | { error: string }> {
        return await this.request(
            ASSET_SUBJECTS.GET,
            {
                assetId,
                ...(workspaceId ? { workspaceId } : {}),
            },
        )
    }

    async ensureAssetsLoaded(assetIds: readonly string[]): Promise<Asset[]> {
        const missingAssetIds = [...new Set(assetIds)].filter(assetId => assetId && !assetsStore.get(assetId))
        const loadedAssets = await this.loadAssetsById(missingAssetIds)

        for (const asset of loadedAssets)
            assetsStore.upsert(asset)

        return loadedAssets
    }

    async refresh(
        assetId: string,
        workspaceId?: string,
    ): Promise<Asset | { error: string }> {
        const asset = await this.get(assetId, workspaceId)

        if ('error' in asset)
            return asset

        assetsStore.upsert(asset)

        for (const role of Object.keys(asset.documents) as AssetDocumentRole[]) {
            if (assetDocumentsStore.get(asset.assetId, role))
                continue

            await this.resumeDocument({
                organizationId: asset.organizationId,
                assetId: asset.assetId,
                role,
            })
        }

        return asset
    }

    startWorkspaceSynchronization(workspaceId: string): () => void {
        const owner = new WorkspaceAssetSynchronization(
            workspaceId,
            {
                subscribe: listener => {
                    const nats = servicesStore.getData('nats')
                    const userId = this.config.userStore.getData('userId') as string
                    const subscriptions: { unsubscribe: () => void }[] = []
                    const release = (): void => {
                        const errors: unknown[] = []

                        for (const subscription of subscriptions.splice(0)) {
                            try {
                                subscription.unsubscribe()
                            } catch (error) {
                                errors.push(error)
                            }
                        }

                        if (errors.length)
                            throw new AggregateError(errors, 'Asset event subscription cleanup failed')
                    }

                    try {
                        if (
                            nats
                            && userId
                        ) {
                            for (const [eventName, canonicalSubject] of Object.entries(ASSET_SUBJECTS.EVENTS)) {
                                subscriptions.push(
                                    nats.subscribe(
                                        getAssetEventSubject(userId, canonicalSubject),
                                        (data: unknown) => {
                                            const assetId = data
                                                && typeof data === 'object'
                                                && 'assetId' in data
                                                && typeof data.assetId === 'string'
                                                ? data.assetId
                                                : ''
                                            listener({
                                                assetId,
                                                deleted: eventName === 'DELETED',
                                            })
                                        },
                                    ),
                                )
                            }
                        }

                        return release
                    } catch (error) {
                        try {
                            release()
                        } catch (cleanupError) {
                            throw new AggregateError([error, cleanupError], 'Asset event subscription failed')
                        }

                        throw error
                    }
                },
                setInterval: (callback, delay) => {
                    const timer = setInterval(callback, delay)

                    return () => clearInterval(timer)
                },
                load: current => this.loadWorkspaceAssets(workspaceId, current),
                read: assetId => assetsStore.get(assetId),
                fetch: (assetId, sourceWorkspaceId) => this.get(assetId, sourceWorkspaceId),
                publish: asset => assetsStore.upsert(asset),
                hydrate: (assets, current) => this.workspaceAssets.hydrate(assets, current),
                remove: assetId => assetsStore.remove(assetId),
                reportError: error => console.error('[AssetService] Asset synchronization failed', error),
            },
        )

        return owner.destroy
    }

    async list({
        workspaceId,
        primaryCategory,
        limit = 50,
        cursor,
    }: {
        workspaceId?: string
        primaryCategory?: AssetPrimaryCategory
        limit?: number
        cursor?: string
    } = {}): Promise<{
        items: AssetMeta[]
        cursor?: string
    }> {
        const result = await this.request<{
            items: AssetMeta[]
            cursor?: string
        } | { error: string }>(
            ASSET_SUBJECTS.LIST,
            {
                workspaceId,
                primaryCategory,
                limit,
                cursor,
            },
        )

        if ('error' in result)
            throw new Error(`Asset list failed: ${result.error}`)

        if (!Array.isArray(result.items))
            throw new Error('Asset list failed: invalid response')

        return result
    }

    async loadWorkspaceAssets(
        workspaceId: string,
        current: () => boolean = () => true,
    ): Promise<Asset[]> {
        const workspace = workspaceStore.getData()

        if (workspace?.workspaceId !== workspaceId)
            return []

        return this.workspaceAssets.load(
            workspaceId,
            workspace.canvasState,
            () => current() && workspaceStore.getData('workspaceId') === workspaceId,
        )
    }

    async resumeDocument({
        organizationId,
        assetId,
        role,
        localVersion = 0,
        localStreamSeq = 0,
    }: {
        organizationId: string
        assetId: string
        role: AssetDocumentRole
        localVersion?: number
        localStreamSeq?: number
    }): Promise<any> {
        const {
            result,
            snapshot,
        } = await this.requestDocumentResume({
            organizationId,
            assetId,
            role,
            localVersion,
            localStreamSeq,
        })

        if (snapshot)
            assetDocumentsStore.set(snapshot)

        return result
    }

    private async resumeDocumentSnapshot({
        organizationId,
        assetId,
        role,
        localVersion = 0,
        localStreamSeq = 0,
    }: {
        organizationId: string
        assetId: string
        role: AssetDocumentRole
        localVersion?: number
        localStreamSeq?: number
    }): Promise<AssetDocumentSnapshot | null> {
        const { snapshot } = await this.requestDocumentResume({
            organizationId,
            assetId,
            role,
            localVersion,
            localStreamSeq,
        })

        return snapshot
    }

    private async requestDocumentResume({
        organizationId,
        assetId,
        role,
        localVersion,
        localStreamSeq,
    }: {
        organizationId: string
        assetId: string
        role: AssetDocumentRole
        localVersion: number
        localStreamSeq: number
    }): Promise<{
        result: AssetDocResumeResult
        snapshot: AssetDocumentSnapshot | null
    }> {
        const result = await this.request<AssetDocResumeResult>(
            ASSET_SUBJECTS.DOCUMENT_RESUME,
            {
                organizationId,
                assetId,
                role,
                localVersion,
                localStreamSeq,
            },
            ASSET_DOCUMENT_RESUME_TIMEOUT_MS,
        )

        if (result.snapshot) {
            const snapshot = await this.fetchDocumentSnapshot(result.snapshot)

            return {
                result,
                snapshot: {
                    assetId,
                    role,
                    version: snapshot.version,
                    doc: snapshot.doc,
                },
            }
        }

        return {
            result,
            snapshot: null,
        }
    }

    async create({
        organizationId,
        workspaceId,
        title,
        primaryCategory,
        initialDoc,
        assetId,
    }: {
        organizationId: string
        workspaceId: string
        title: string
        primaryCategory: 'document' | 'conversation'
        initialDoc?: object
        assetId?: string
    }): Promise<Asset> {
        const result = await this.request<Asset | { error: string }>(
            ASSET_SUBJECTS.CREATE,
            {
                organizationId,
                originWorkspaceId: workspaceId,
                scope: 'workspace',
                scopeOwnerId: workspaceId,
                title,
                primaryCategory,
                ...(assetId ? { assetId } : {}),
                ...(initialDoc ? { initialDoc } : {}),
            },
        )

        if ('error' in result)
            throw new Error(`Asset creation failed: ${result.error}`)

        assetsStore.upsert(result)

        return result
    }

    async updateMetadata(
        assetId: string,
        expectedRevision: number,
        updates: {
            title?: string
            descriptor?: Asset['descriptor']
        },
    ): Promise<Asset | { error: string }> {
        const result = await this.request<Asset | { error: string }>(
            ASSET_SUBJECTS.UPDATE_METADATA,
            {
                assetId,
                expectedRevision,
                ...updates,
            },
        )

        if (!('error' in result))
            assetsStore.upsert(result)

        return result
    }

    async attestSubjectIdentity(
        assetId: string,
        assetRevision: number,
        classification: SubjectIdentityClassification,
    ): Promise<Asset | { error: string }> {
        const result = await this.request<Asset | { error: string }>(
            ASSET_SUBJECTS.SUBJECT_IDENTITY_ATTEST,
            {
                assetId,
                assetRevision,
                classification,
            },
        )

        if (!('error' in result))
            assetsStore.upsert(result)

        return result
    }

    async changeScope(
        assetId: string,
        expectedRevision: number,
        scope: AssetScope,
        scopeOwnerId: string,
    ): Promise<Asset | { error: string }> {
        const result = await this.request<Asset | { error: string }>(
            ASSET_SUBJECTS.CHANGE_SCOPE,
            {
                assetId,
                expectedRevision,
                scope,
                scopeOwnerId,
            },
        )

        if (!('error' in result))
            assetsStore.upsert(result)

        return result
    }

    async reviewGeneratedOutput(payload: GeneratedOutputReviewRequest): Promise<GeneratedOutputReviewResponse | { error: string }> {
        const result = await this.request<GeneratedOutputReviewResponse | { error: string }>(ASSET_SUBJECTS.REVIEW_GENERATED_OUTPUT, payload)

        if (!('error' in result))
            await Promise.all(
                result.affectedAssetIds.map(async assetId => await this.refresh(assetId)),
            )

        return result
    }

    async attach(payload: {
        assetId: string
        workspaceId: string
        nodeId?: string
        surfaceId?: string
        workspaceMutation?: Record<string, unknown>
    }): Promise<unknown> {
        return await this.request(ASSET_SUBJECTS.ATTACH, payload)
    }

    async detach(payload: {
        assetId: string
        workspaceId?: string
        nodeId?: string
        surfaceId?: string
        referenceType?: 'workspace' | 'catalog'
        workspaceMutation?: Record<string, unknown>
    }): Promise<unknown> {
        return await this.request(ASSET_SUBJECTS.DETACH, payload)
    }

    async acquireLease(
        assetId: string,
        workspaceId: string,
        holderId: string,
    ): Promise<Asset['editLease'] | { error: string }> {
        return await this.request(
            ASSET_SUBJECTS.ACQUIRE_LEASE,
            {
                assetId,
                workspaceId,
                holderId,
            },
        )
    }

    async renewLease(
        assetId: string,
        workspaceId: string,
        leaseId: string,
        holderId: string,
    ): Promise<Asset['editLease'] | { error: string }> {
        return await this.request(
            ASSET_SUBJECTS.RENEW_LEASE,
            {
                assetId,
                workspaceId,
                leaseId,
                holderId,
            },
        )
    }

    async releaseLease(
        assetId: string,
        workspaceId: string,
        leaseId: string,
        holderId: string,
    ): Promise<void> {
        await this.request(
            ASSET_SUBJECTS.RELEASE_LEASE,
            {
                assetId,
                workspaceId,
                leaseId,
                holderId,
            },
        )
    }

    getRenditionUrl(
        assetId: string,
        rendition: string,
    ): string {
        return `/api/assets/${assetId}/renditions/${rendition}`
    }
}

export default AssetService
