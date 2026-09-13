import { readFile } from 'node:fs/promises'

import sharp from 'sharp'
import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import {
    type OperationProgressItem,
} from '@lixpi/constants'

import {
    type CapabilityMediaExecutionContext,
} from '../../../../backend/capability-media-strategy.ts'
import { buildCharacterSheetLayout } from '../../shared/character-sheet-layout.ts'
import { buildCharacterSheetRenderPlan } from '../../shared/character-sheet-media-plan.ts'
import {
    CharacterSheetStrategy,
    type CharacterSheetStrategyDeps,
} from './character-sheet-strategy.ts'

// A provider transport failure carrying the HTTP status the retry classifier reads.
class ProviderStatusError extends Error {
    readonly status: number

    constructor(
        message: string,
        status: number,
    ) {
        super(message)
        this.status = status
    }
}

const mocks = {
    clear: vi.fn(async () => undefined),
    compose: vi.fn(async () => ({
        bytes: Buffer.from('composed-sheet'),
        sha256: 'c'.repeat(64),
        width: 3840 as const,
        height: 2560 as const,
        sourceCoverageNote: 'Source coverage: prompt-derived.',
    })),
    getAuthorizedAsset: vi.fn(),
    putWithCoordinate: vi.fn(async (args: {
        bytes: Uint8Array
        revision: number
    }) => ({
        coordinate: {
            organizationId: 'org-1',
            bucketName: 'transient-media-org-1-files',
            objectKey: `partial-${String(args.revision).padStart(64, '0')}.png`,
            mimeType: 'image/png' as const,
            byteLength: args.bytes.byteLength,
        },
    })),
    readBlob: vi.fn(),
    render: vi.fn(),
}

type CharacterImageGenerationRequest = Parameters<
    NonNullable<CharacterSheetStrategyDeps['imageGeneration']>['generate']
>[0]

const providerResult = (request: CharacterImageGenerationRequest) => ({
    image: panelPng.toString('base64'),
    providerOperationId: request.operationKey,
    // The platform adapter resolves the requested size against the model's
    // supported sizes and reports back what it actually sent.
    resolvedImageSize: '1024x1536',
    includedReferenceRoles: [...new Set(request.references.map(reference => reference.role))],
    omittedReferenceRoles: [],
})

let panelPng: Buffer

const plan = () =>
    buildCharacterSheetRenderPlan({
        capabilityRunId: 'run-1',
        sourceAssetIds: [],
        userPrompt: 'A courier',
    })

const context = (mediaRunId = 'media-1'): CapabilityMediaExecutionContext => ({
    organizationId: 'org-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    conversationAssetId: 'thread-1',
    generationRequestId: 'request-1',
    mediaRunId,
    reasoningModel: {
        provider: 'OpenAI',
        modelVersion: 'reasoning-v1',
    },
    imageModel: {
        provider: 'OpenAI',
        modelVersion: 'image-v1',
        meta: {
            provider: 'OpenAI',
            model: 'image',
            modelVersion: 'image-v1',
            imageReferenceCapabilities: {
                maxReferenceImages: 8,
                maxIdentityReferenceImages: 5,
                conditioningModes: ['edit', 'identity'],
                inputFidelity: 'high',
                supportsIterativeEdit: true,
                supportsMask: false,
                supportsStructureControl: false,
                supportsPoseControl: false,
                supportsDeterministicSeed: false,
                maxOutputPixels: 2_359_296,
                supportedAspectRatios: ['1:1'],
            },
        },
    },
    sharedState: {
        authoritativePrompt: 'A courier',
        mediaReferenceAliases: [],
        sourceSubjectIdentityClassifications: [],
        capabilityInstructions: [],
        capabilityReferences: [],
        capabilityOutputs: [],
    },
    eventMeta: {
        organizationId: 'org-1',
        userId: 'user-1',
    },
})

const assessment = (
    failed: boolean,
    score = failed ? 0.4 : 0.95,
    failedDimension = 'clothing',
) => ({
    dimensions: [
        'single-panel-composition',
        'template-conformance',
        'target-view',
        'framing',
        ...(![
                'single-panel-composition',
                'template-conformance',
                'target-view',
                'framing',
            ].includes(failedDimension)
            ? [failedDimension]
            : []),
    ].map(dimension => ({
        dimension,
        score: failed
            && dimension === failedDimension
            ? score
            : 0.95,
        mismatchCodes: failed
            && dimension === failedDimension
            ? ['TEST_MISMATCH']
            : [],
    })),
    assessor: 'test/reasoning-v1',
})

const runtime = (): CharacterSheetStrategyDeps => ({
    referenceAssets: {
        getAuthorizedAsset: mocks.getAuthorizedAsset,
        readBlob: mocks.readBlob,
    },
    transientMedia: {
        create: () => ({
            putWithCoordinate: mocks.putWithCoordinate,
            clear: mocks.clear,
        }),
    },
    imageGeneration: { generate: mocks.render },
    structuredVlm: {
        call: async () => {
            throw new Error('Unexpected structured VLM call')
        },
    },
    fidelity: {
        assess: async () => {
            throw new Error('Unexpected fidelity call')
        },
    },
    compositor: mocks.compose,
    providerConcurrency: 4,
})

const strategy = (assess: (request: Parameters<NonNullable<CharacterSheetStrategyDeps['panelAssessor']>['assess']>[0]) => Promise<ReturnType<typeof assessment>>) =>
    new CharacterSheetStrategy({
        ...runtime(),
        panelAssessor: { assess },
        evidenceAnalyzer: { analyze: async () => ({ medium: 'unknown' }) },
    })

const createFlattenedSheet = async (executionPlan: ReturnType<typeof plan>): Promise<Buffer> => {
    const layout = buildCharacterSheetLayout(executionPlan.panels)
    const width = 1200
    const height = 800
    const overlays = await Promise.all(layout.cells.map(async (cell, index) => {
        const scaledWidth = Math.round(cell.width * width / layout.width)
        const scaledHeight = Math.round(cell.height * height / layout.height)
        const source = await sharp({
            create: {
                width: Math.max(20, Math.round(scaledWidth * 0.2)),
                height: Math.max(40, Math.round(scaledHeight * 0.65)),
                channels: 3,
                background: index === 0 ? '#223344' : index === 1 ? '#445566' : '#667788',
            },
        }).png().toBuffer()
        const sourceMetadata = await sharp(source).metadata()

        return {
            input: source,
            left: Math.round(cell.x * width / layout.width + (scaledWidth - sourceMetadata.width!) / 2),
            top: Math.round(cell.y * height / layout.height + (scaledHeight - sourceMetadata.height!) / 2),
        }
    }))

    return await sharp({
        create: {
            width,
            height,
            channels: 3,
            background: '#ffffff',
        },
    }).composite(overlays).png().toBuffer()
}

describe('CharacterSheetStrategy', () => {
    beforeAll(async () => {
        panelPng = await sharp({
            create: {
                width: 256,
                height: 256,
                channels: 3,
                background: '#6688aa',
            },
        }).png().toBuffer()
    })

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getAuthorizedAsset.mockResolvedValue({
            assetId: 'asset-1',
            organizationId: 'org-1',
            media: {
                renditions: {
                    canonical: {
                        status: 'ready',
                        blobHash: 'blob-1',
                        mimeType: 'image/png',
                    },
                },
            },
        })
        mocks.readBlob.mockResolvedValue(panelPng)
        mocks.render.mockImplementation(async request => providerResult(request))
    })

    it('executes the configured three-shot barrier chain and carries the first two anchors into the back shot', async () => {
        const executionPlan = plan()
        const result = await strategy(async () => assessment(false)).execute(context(), executionPlan, {})
        const trace = result.capabilityMediaTrace as Record<string, unknown>
        const operationKeys = mocks.render.mock.calls.map(([request]) => request.operationKey)
        const frontRequest = mocks.render.mock.calls.find(([request]) => (
            request.operationKey.includes(':body-front:')
        ))?.[0]
        const backRequest = mocks.render.mock.calls.find(([request]) => (
            request.operationKey.includes(':body-back:')
        ))?.[0]

        expect(mocks.render).toHaveBeenCalledTimes(executionPlan.panels.length)
        expect(trace.totalProviderOperations).toBe(executionPlan.panels.length)
        expect(trace.panels).toHaveLength(executionPlan.panels.length)
        expect(operationKeys.findIndex(key => key.includes(':head-front-neutral:')))
            .toBeLessThan(operationKeys.findIndex(key => key.includes(':body-front:')))
        expect(operationKeys.findIndex(key => key.includes(':body-front:')))
            .toBeLessThan(operationKeys.findIndex(key => key.includes(':body-back:')))
        expect(frontRequest?.references).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'canonical-anchor',
                fileName: 'GENERATED_IDENTITY_ANCHOR.png',
            }),
        ]))
        expect(backRequest?.references).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'adjacent-angle',
                fileName: 'GENERATED_IDENTITY_ANCHOR.png',
            }),
            expect.objectContaining({
                role: 'canonical-anchor',
                fileName: 'GENERATED_OUTFIT_ANCHOR.png',
            }),
        ]))
        expect(mocks.clear).toHaveBeenCalledOnce()
    })

    it('feeds all three declared anchors, and no unrelated completed shot, into optional shots', async () => {
        const executionPlan = buildCharacterSheetRenderPlan({
            capabilityRunId: 'run-optional',
            sourceAssetIds: [],
            userPrompt: 'A courier in four shots',
        })
        const serialStrategy = new CharacterSheetStrategy({
            ...runtime(),
            providerConcurrency: 1,
            panelAssessor: { assess: async () => assessment(false) },
            evidenceAnalyzer: { analyze: async () => ({ medium: 'unknown' }) },
        })

        await serialStrategy.execute(context(), executionPlan, {})

        const profileRequest = mocks.render.mock.calls.find(([request]) => (
            request.operationKey.includes(':body-profile:')
        ))?.[0]
        expect(
            profileRequest?.references.filter(reference => (
                ['canonical-anchor', 'adjacent-angle', 'opposite-angle'].includes(reference.role)
            )),
        ).toEqual([
            expect.objectContaining({
                role: 'adjacent-angle',
                fileName: 'GENERATED_IDENTITY_ANCHOR.png',
            }),
            expect.objectContaining({
                role: 'canonical-anchor',
                fileName: 'GENERATED_OUTFIT_ANCHOR.png',
            }),
            expect.objectContaining({
                role: 'opposite-angle',
                fileName: 'GENERATED_BACK_OUTFIT_ANCHOR.png',
            }),
        ])
    })

    it('reuses durable component shots and regenerates only the explicitly targeted view', async () => {
        const executionPlan = buildCharacterSheetRenderPlan({
            capabilityRunId: 'run-edit',
            sourceAssetIds: ['sheet-1'],
            userPrompt: 'Fix only the last shot: the back view has bare arms.',
        })
        const executionContext = context()
        executionContext.sharedState.authoritativePrompt = executionPlan.userPrompt
        executionContext.sharedState.editTargetAssetId = 'sheet-1'
        mocks.getAuthorizedAsset.mockImplementation(async ({ assetId }) =>
            assetId === 'sheet-1'
                ? {
                    assetId: 'sheet-1',
                    organizationId: 'org-1',
                    composition: {
                        schemaVersion: 'asset-media-composition-v1',
                        kind: 'character-sheet',
                        capabilityId: 'global.character-creator',
                        sourceAssetIds: ['source-1'],
                        components: executionPlan.panels.map(panel => ({
                            componentId: panel.panelId,
                            role: 'character-sheet-panel',
                            title: panel.title,
                            blobHash: `${panel.panelId}-hash`,
                            mimeType: 'image/png',
                            byteSize: panelPng.byteLength,
                        })),
                    },
                }
                : {
                    assetId: 'source-1',
                    organizationId: 'org-1',
                    media: {
                        renditions: {
                            canonical: {
                                status: 'ready',
                                blobHash: 'source-hash',
                                mimeType: 'image/png',
                            },
                        },
                    },
                }
        )
        const editStrategy = new CharacterSheetStrategy({
            ...runtime(),
            panelAssessor: { assess: async () => assessment(false) },
            evidenceAnalyzer: {
                analyze: async () => ({
                    medium: 'unknown',
                    regenerationScope: 'selected-panels',
                    affectedPanelIds: ['body-back'],
                }),
            },
        })

        const result = await editStrategy.execute(executionContext, executionPlan, {})
        const trace = result.capabilityMediaTrace as {
            totalProviderOperations: number
            panels: Array<{
                panelId: string
                attempts: number
                vlmAssessor: string
            }>
        }
        const backRequest = mocks.render.mock.calls[0]?.[0]

        expect(mocks.render).toHaveBeenCalledOnce()
        expect(backRequest?.operationKey).toContain(':body-back:')
        expect(backRequest?.references).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'adjacent-angle',
                fileName: 'GENERATED_IDENTITY_ANCHOR.png',
            }),
            expect.objectContaining({
                role: 'canonical-anchor',
                fileName: 'GENERATED_OUTFIT_ANCHOR.png',
            }),
        ]))
        expect(trace.totalProviderOperations).toBe(1)
        expect(trace.panels).toEqual(expect.arrayContaining([
            expect.objectContaining({
                panelId: 'head-front-neutral',
                attempts: 0,
                vlmAssessor: 'durable-composition-component',
            }),
            expect.objectContaining({
                panelId: 'body-front',
                attempts: 0,
                vlmAssessor: 'durable-composition-component',
            }),
            expect.objectContaining({
                panelId: 'body-back',
                attempts: 1,
            }),
        ]))
        expect(result.mediaComposition?.sourceAssetIds).toEqual(['source-1'])
        expect(result.mediaComposition?.components.map(component => component.componentId))
            .toEqual(executionPlan.panels.map(panel => panel.panelId))
    })

    it('isolates legacy flattened sheet panels and sends only the matching panel to an edited shot', async () => {
        const executionPlan = buildCharacterSheetRenderPlan({
            capabilityRunId: 'run-legacy-edit',
            sourceAssetIds: ['legacy-sheet'],
            userPrompt: 'Fix only the last shot: correct the back view.',
        })
        const executionContext = context()
        executionContext.sharedState.authoritativePrompt = executionPlan.userPrompt
        executionContext.sharedState.editTargetAssetId = 'legacy-sheet'
        mocks.getAuthorizedAsset.mockResolvedValue({
            assetId: 'legacy-sheet',
            organizationId: 'org-1',
            media: {
                renditions: {
                    canonical: {
                        status: 'ready',
                        blobHash: 'legacy-sheet-hash',
                        mimeType: 'image/png',
                    },
                },
            },
        })
        mocks.readBlob.mockResolvedValue(await createFlattenedSheet(executionPlan))
        const editStrategy = new CharacterSheetStrategy({
            ...runtime(),
            panelAssessor: { assess: async () => assessment(false) },
            evidenceAnalyzer: {
                analyze: async () => ({
                    medium: 'unknown',
                    regenerationScope: 'selected-panels',
                    affectedPanelIds: ['body-back'],
                }),
            },
        })

        const result = await editStrategy.execute(executionContext, executionPlan, {})
        const backRequest = mocks.render.mock.calls[0]?.[0]
        const flattenedReferenceFiles = backRequest?.references
            .map(reference => reference.fileName)
            .filter(fileName => fileName?.startsWith('EDIT_TARGET_'))

        expect(mocks.render).toHaveBeenCalledOnce()
        expect(backRequest?.operationKey).toContain(':body-back:')
        expect(flattenedReferenceFiles).toEqual(['EDIT_TARGET_body-back.png'])
        expect(backRequest?.references).toContainEqual(expect.objectContaining({
            role: 'edit-target',
            fileName: 'EDIT_TARGET_body-back.png',
        }))
        expect(backRequest?.references).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'adjacent-angle',
                fileName: 'GENERATED_IDENTITY_ANCHOR.png',
            }),
            expect.objectContaining({
                role: 'canonical-anchor',
                fileName: 'GENERATED_OUTFIT_ANCHOR.png',
            }),
        ]))
        expect(result.mediaComposition?.sourceAssetIds).toEqual([])
        expect(result.mediaComposition?.components.map(component => component.componentId))
            .toEqual(executionPlan.panels.map(panel => panel.panelId))
    })

    it('distinguishes the existing panel from authoritative source evidence during a full-sheet edit', async () => {
        const userPrompt = [
            'Remove the hair completely and replace it with short antennas.',
            'Keep the robot face, but redo all clothing to match the original drawing.',
            'Move the bag much lower and print Lixpi in red and ai in black.',
        ].join(' ')
        const executionPlan = buildCharacterSheetRenderPlan({
            capabilityRunId: 'run-full-edit',
            sourceAssetIds: ['sheet-1'],
            userPrompt,
        })
        const executionContext = context()
        executionContext.sharedState.authoritativePrompt = userPrompt
        executionContext.sharedState.editTargetAssetId = 'sheet-1'
        executionContext.sharedState.mediaReferenceAliases = [
            {
                assetId: 'source-1',
                alias: 'REFERENCE_1',
            },
            {
                assetId: 'sheet-1',
                alias: 'REFERENCE_2',
            },
        ]
        mocks.getAuthorizedAsset.mockImplementation(async ({ assetId }) =>
            assetId === 'sheet-1'
                ? {
                    assetId: 'sheet-1',
                    organizationId: 'org-1',
                    composition: {
                        schemaVersion: 'asset-media-composition-v1',
                        kind: 'character-sheet',
                        capabilityId: 'global.character-creator',
                        sourceAssetIds: ['source-1'],
                        components: executionPlan.panels.map(panel => ({
                            componentId: panel.panelId,
                            role: 'character-sheet-panel',
                            title: panel.title,
                            blobHash: `${panel.panelId}-hash`,
                            mimeType: 'image/png',
                            byteSize: panelPng.byteLength,
                        })),
                    },
                }
                : {
                    assetId: 'source-1',
                    organizationId: 'org-1',
                    media: {
                        renditions: {
                            canonical: {
                                status: 'ready',
                                blobHash: 'source-hash',
                                mimeType: 'image/png',
                            },
                        },
                    },
                }
        )
        const editStrategy = new CharacterSheetStrategy({
            ...runtime(),
            panelAssessor: { assess: async () => assessment(false) },
            evidenceAnalyzer: {
                analyze: async () => ({
                    medium: 'illustration',
                    editTargetPolicy: 'identity-only',
                    editTargetApprovedRegions: ['face'],
                    editTargetRejectedRegions: ['body', 'outfit', 'hands', 'feet', 'prop'],
                    regenerationScope: 'full-sheet',
                    affectedPanelIds: executionPlan.panels.map(panel => panel.panelId),
                    promptDirectives: [
                        'Remove the hair and replace it with short antennas.',
                        'Rebuild the clothing and lower bag from the original reference.',
                    ],
                    promptChangedFeatures: ['hair', 'clothing', 'bag placement'],
                    facts: [
                        {
                            feature: 'clothing',
                            value: 'gray herringbone coat with fully covered arms',
                            region: 'outfit' as const,
                            requestAuthority: 'assigned' as const,
                            visibility: 'observed' as const,
                            sourceRegion: {
                                x: 10,
                                y: 10,
                                width: 200,
                                height: 230,
                            },
                            targetAngles: ['back' as const],
                            confidence: 1,
                        },
                        {
                            feature: 'bag placement',
                            value: 'long bag hanging low against the hip and thigh',
                            region: 'prop' as const,
                            requestAuthority: 'assigned' as const,
                            visibility: 'observed' as const,
                            sourceAssetId: 'source-1',
                            sourceRegion: {
                                x: 50,
                                y: 60,
                                width: 100,
                                height: 180,
                            },
                            targetAngles: ['back' as const],
                            confidence: 1,
                        },
                    ],
                }),
            },
        })

        await editStrategy.execute(executionContext, executionPlan, {})

        const headRequest = mocks.render.mock.calls.find(([request]) => (
            request.operationKey.includes(':head-front-neutral:')
        ))?.[0]
        const frontRequest = mocks.render.mock.calls.find(([request]) => (
            request.operationKey.includes(':body-front:')
        ))?.[0]
        const backRequest = mocks.render.mock.calls.find(([request]) => (
            request.operationKey.includes(':body-back:')
        ))?.[0]

        expect(
            headRequest?.references.some(reference =>
                reference.role === 'edit-target-identity'
                && reference.fileName === 'EDIT_TARGET_IDENTITY_FACE.png'
            ),
        ).toBe(true)
        expect(
            headRequest?.references.some(reference =>
                reference.role === 'original-source'
                || reference.role === 'face-crop'
            ),
        ).toBe(false)
        expect(
            headRequest?.references.some(reference =>
                reference.role === 'body-outfit-crop'
                || reference.role === 'prop-crop'
            ),
        ).toBe(false)
        expect(
            frontRequest?.references.some(reference =>
                reference.role === 'edit-target'
                || reference.role === 'edit-target-identity'
            ),
        ).toBe(false)
        expect(
            backRequest?.references.some(reference =>
                reference.role === 'edit-target'
                || reference.role === 'edit-target-identity'
            ),
        ).toBe(false)
        expect(frontRequest?.references).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'original-source',
                fileName: 'REFERENCE_1.png',
            }),
            expect.objectContaining({
                role: 'body-outfit-crop',
                fileName: 'REFERENCE_1_BODY_OUTFIT_CROP.png',
            }),
            expect.objectContaining({
                role: 'prop-crop',
                fileName: 'REFERENCE_1_PROP_CROP.png',
            }),
        ]))
        expect(backRequest?.references).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'original-source',
                fileName: 'REFERENCE_1.png',
            }),
            expect.objectContaining({
                role: 'body-outfit-crop',
                fileName: 'REFERENCE_1_BODY_OUTFIT_CROP.png',
            }),
            expect.objectContaining({
                role: 'prop-crop',
                fileName: 'REFERENCE_1_PROP_CROP.png',
            }),
        ]))
        expect(frontRequest?.references.filter(reference => reference.role === 'original-source'))
            .toHaveLength(1)
        expect(frontRequest?.prompt).toContain('[REQUEST-CHANGED] [REFERENCE_1] clothing: gray herringbone coat with fully covered arms')
        expect(frontRequest?.prompt).toContain('[REQUEST-CHANGED] [REFERENCE_1] bag placement: long bag hanging low against the hip and thigh')
        expect(frontRequest?.prompt).toContain('Render exact lettering required by the authoritative request')
        expect(frontRequest?.prompt).not.toContain('No text, letters, numbers')
        expect(frontRequest?.prompt).toContain(userPrompt)
        expect(headRequest?.prompt).toContain('This provider call renders only head-front-neutral')
        expect(headRequest?.prompt).toContain('Do not show a full-body figure, back view, alternate pose')
        expect(headRequest?.prompt).toContain('No contact sheet, montage, lineup, split frame, inset, second pose')
        expect(headRequest?.prompt).toContain('approved edit-target identity crop defines only')
        expect(headRequest?.prompt).not.toContain('original source image or images remain independent')
    })

    it('applies the authoritative shared request before source fidelity and carries sibling Capability state into every shot', async () => {
        const executionPlan = buildCharacterSheetRenderPlan({
            capabilityRunId: 'run-1',
            sourceAssetIds: ['asset-1'],
            userPrompt: 'Create a character sheet.',
        })
        const executionContext = context()
        executionContext.sharedState = {
            authoritativePrompt: 'Transform the referenced woman into a visibly undead zombie.',
            mediaReferenceAliases: [],
            sourceSubjectIdentityClassifications: ['self'],
            capabilityInstructions: ['Render the transformed character with rough watercolor texture.'],
            capabilityReferences: [{
                imageUrl: `data:image/png;base64,${panelPng.toString('base64')}`,
                traceUrl: '/api/capabilities/watercolor/resources/sample-1',
            }],
            capabilityOutputs: [
                {
                    capabilityId: 'character-creator',
                    runId: 'character-run',
                    output: {},
                },
                {
                    capabilityId: 'watercolor-style',
                    runId: 'style-run',
                    output: {},
                },
            ],
        }
        const assess = vi.fn(async () => assessment(false))
        const intentAwareStrategy = new CharacterSheetStrategy({
            ...runtime(),
            evidenceAnalyzer: {
                analyze: async () => ({
                    medium: 'illustration',
                    promptDirectives: ['Make the subject visibly undead.'],
                    promptChangedFeatures: ['skin condition'],
                    facts: [
                        {
                            feature: 'skin condition',
                            value: 'healthy natural skin',
                            visibility: 'observed',
                            sourceAssetId: 'asset-1',
                            targetAngles: ['front'],
                            confidence: 1,
                        },
                        {
                            feature: 'facial identity',
                            value: 'recognizable oval facial structure',
                            visibility: 'observed',
                            sourceAssetId: 'asset-1',
                            targetAngles: ['front'],
                            confidence: 1,
                        },
                    ],
                }),
            },
            panelAssessor: { assess },
        })

        await intentAwareStrategy.execute(executionContext, executionPlan, {})

        const headRequest = mocks.render.mock.calls.find(([request]) => (
            request.operationKey.includes(':head-front-neutral:')
        ))?.[0]
        const bodyRequest = mocks.render.mock.calls.find(([request]) => (
            request.operationKey.includes(':body-front:')
        ))?.[0]
        const backRequest = mocks.render.mock.calls.find(([request]) => (
            request.operationKey.includes(':body-back:')
        ))?.[0]
        expect(headRequest?.prompt).toContain('Transform the referenced woman into a visibly undead zombie.')
        expect(headRequest?.prompt).toContain('rough watercolor texture')
        expect(headRequest?.prompt).toContain('Make the subject visibly undead.')
        expect(headRequest?.prompt).toContain('classified as the requesting user’s own identity')
        expect(headRequest?.prompt).not.toContain('NON-GRAPHIC ZOMBIE DESIGN')
        expect(headRequest?.prompt).not.toContain('pallid mottled skin')
        expect(headRequest?.prompt).toContain('must not suppress any requested visual attribute')
        expect(headRequest?.prompt).toContain('facial identity: recognizable oval facial structure')
        expect(headRequest?.prompt).toContain('[REQUEST-CHANGED] skin condition: healthy natural skin')
        expect(headRequest?.prompt).toContain('are not preservation defaults')
        expect(headRequest?.prompt).not.toContain('Change only the camera, crop, and pose')
        expect(headRequest?.references).toContainEqual(expect.objectContaining({
            role: 'capability-reference',
            fileName: 'CAPABILITY_REFERENCE_1.png',
        }))
        expect(bodyRequest?.prompt).toContain('GENERATED_IDENTITY_ANCHOR.png')
        expect(bodyRequest?.references).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'canonical-anchor' }),
            expect.objectContaining({ role: 'capability-reference' }),
        ]))
        expect(backRequest?.prompt).toContain('GENERATED_OUTFIT_ANCHOR.png')
        expect(backRequest?.prompt).toContain('full-body proportions, outfit construction')
        expect(backRequest?.references).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'canonical-anchor',
                fileName: 'GENERATED_OUTFIT_ANCHOR.png',
            }),
            expect.objectContaining({
                role: 'adjacent-angle',
                fileName: 'GENERATED_IDENTITY_ANCHOR.png',
            }),
        ]))
        expect(assess).toHaveBeenCalledWith(expect.objectContaining({
            authoritativePrompt: 'Transform the referenced woman into a visibly undead zombie.',
            capabilityInstructions: ['Render the transformed character with rough watercolor texture.'],
            capabilityReferenceDataUrls: [expect.stringMatching(/^data:image\/png;base64,/u)],
        }))
    })

    it('preserves a photographic source medium and uses the evidence interpretation of an obvious archetype typo', async () => {
        const executionPlan = buildCharacterSheetRenderPlan({
            capabilityRunId: 'run-1',
            sourceAssetIds: ['asset-1'],
            userPrompt: 'Create a combie character out of this photo.',
        })
        const executionContext = context()
        executionContext.sharedState.authoritativePrompt = 'Create a combie character out of this photo.'
        const analyze = vi.fn(async () => ({
            medium: 'photograph' as const,
            promptDirectives: ['Interpret "combie character" as "zombie character" and make the subject visibly undead.'],
            promptChangedFeatures: ['skin condition'],
            facts: [{
                feature: 'skin condition',
                value: 'healthy natural skin',
                visibility: 'observed' as const,
                sourceAssetId: 'asset-1',
                targetAngles: ['front' as const],
                confidence: 1,
            }],
        }))
        const intentAwareStrategy = new CharacterSheetStrategy({
            ...runtime(),
            evidenceAnalyzer: { analyze },
            panelAssessor: { assess: async () => assessment(false) },
        })

        await intentAwareStrategy.execute(executionContext, executionPlan, {})

        expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
            userPrompt: 'Create a combie character out of this photo.',
        }))
        const headRequest = mocks.render.mock.calls.find(([request]) => (
            request.operationKey.includes(':head-front-neutral:')
        ))?.[0]
        expect(headRequest?.prompt).toContain('Create a combie character out of this photo.')
        expect(headRequest?.prompt).toContain('"zombie character" and make the subject visibly undead')
        expect(headRequest?.prompt).toContain('SOURCE DEPICTION MEDIUM — PHOTOGRAPH')
        expect(headRequest?.prompt).toContain('Preserve a realistic photographic depiction')
        expect(headRequest?.prompt).toContain('does not by itself authorize a depiction-medium or visual-style change')
        expect(headRequest?.prompt).not.toContain('adorable chibi')
        expect(headRequest?.prompt).not.toContain('large head and small body')
    })

    it('publishes provider partials before the validated terminal panel releases the next shot', async () => {
        const lifecycle: string[] = []
        mocks.render.mockImplementation(async request => {
            if (request.operationKey.includes(':head-front-neutral:1')) {
                await request.onImagePartial?.(panelPng.toString('base64'), 1)
                lifecycle.push(`terminal:${request.context.mediaRunId}`)
            }

            return providerResult(request)
        })

        const publishImagePartial = vi.fn(async () => void lifecycle.push('published'))
        await strategy(async () => assessment(false)).execute(
            context('media-google'),
            plan(),
            { publishImagePartial },
        )
        await strategy(async () => assessment(false)).execute(
            context('media-openai'),
            plan(),
            {},
        )

        const plannedOperationCount = plan().panels.length
        const operationKeys = mocks.render.mock.calls.map(([request]) => request.operationKey)
        expect(operationKeys.filter(key => key.startsWith('media-google:'))).toHaveLength(plannedOperationCount)
        expect(operationKeys.filter(key => key.startsWith('media-openai:'))).toHaveLength(plannedOperationCount)
        expect(new Set(operationKeys)).toHaveLength(plannedOperationCount * 2)
        expect(publishImagePartial).toHaveBeenCalled()
        expect(lifecycle.indexOf('published')).toBeLessThan(lifecycle.indexOf('terminal:media-google'))
    })

    it('does not silently regenerate panels when comparison reports a failed dimension', async () => {
        const attempts = new Map<string, number>()
        const executionPlan = plan()
        const result = await strategy(async request => {
            const count = (attempts.get(request.panel.panelId) ?? 0) + 1
            attempts.set(request.panel.panelId, count)

            return assessment(count === 1)
        }).execute(context(), executionPlan, {})
        const trace = result.capabilityMediaTrace as Record<string, unknown>

        expect(mocks.render).toHaveBeenCalledTimes(executionPlan.panels.length)
        expect(trace.totalProviderOperations).toBe(executionPlan.panels.length)
        expect([...attempts.values()]).toEqual(executionPlan.panels.map(() => 1))
        expect(mocks.render.mock.calls.some(([request]) => request.operationKey.endsWith(':2'))).toBe(false)
    })

    it('retains panels with non-structural comparison warnings for explicit user review', async () => {
        const executionPlan = plan()
        const result = await strategy(async () => assessment(true, 0.6)).execute(context(), executionPlan, {})
        const trace = result.capabilityMediaTrace as {
            totalProviderOperations: number
            panels: unknown[]
        }

        expect(trace.totalProviderOperations).toBe(executionPlan.panels.length)
        expect(trace.panels).toEqual(expect.arrayContaining([
            expect.objectContaining({
                status: 'needs-review',
                failedDimensions: ['clothing'],
            }),
        ]))
        expect(mocks.clear).toHaveBeenCalledOnce()
    })

    it('retains template and framing variance without discarding a completed provider result', async () => {
        const executionPlan = plan()
        const result = await strategy(async () => {
            const result = assessment(false)

            return {
                ...result,
                dimensions: result.dimensions.map(dimension => (
                    dimension.dimension === 'template-conformance'
                        || dimension.dimension === 'framing'
                        ? {
                            ...dimension,
                            score: 0.6,
                            mismatchCodes: [`${dimension.dimension.toLocaleUpperCase()}_VARIANCE`],
                        }
                        : dimension
                )),
            }
        }).execute(context(), executionPlan, {})
        const trace = result.capabilityMediaTrace as {
            panels: Array<{
                panelId: string
                failedDimensions: string[]
            }>
        }

        expect(mocks.render).toHaveBeenCalledTimes(executionPlan.panels.length)
        expect(trace.panels).toEqual(expect.arrayContaining([
            expect.objectContaining({
                panelId: 'head-front-neutral',
                failedDimensions: expect.arrayContaining(['template-conformance', 'framing']),
            }),
        ]))
    })

    it('keeps generated anchors moving when the comparison response is unusable', async () => {
        const executionPlan = plan()
        const result = await strategy(async () => ({
            dimensions: [],
            assessor: 'Anthropic/claude-sonnet-5',
            error: {
                code: 'CHARACTER_PANEL_ASSESSMENT_RESPONSE_INVALID',
                message: 'The evaluator returned no usable per-dimension score list.',
                diagnostic: 'The structured response dimensions field was a string.',
            },
        })).execute(context(), executionPlan, {})
        const trace = result.capabilityMediaTrace as {
            panels: Array<{
                status: string
                failedDimensions: string[]
            }>
        }

        expect(mocks.render).toHaveBeenCalledTimes(executionPlan.panels.length)
        expect(result.mediaComposition?.components).toHaveLength(executionPlan.panels.length)
        expect(
            result.mediaComposition?.components.every(component => (
                component.role === 'character-sheet-panel'
            )),
        ).toBe(true)
        expect(trace.panels).toEqual(expect.arrayContaining([
            expect.objectContaining({
                status: 'needs-review',
                failedDimensions: expect.arrayContaining([
                    'comparison-unavailable',
                    'per-dimension-evaluation-unavailable',
                ]),
            }),
        ]))
    })

    it('retains a structurally rejected terminal for review without releasing it as an anchor', async () => {
        const executionPlan = plan()
        const providerPartial = await sharp({
            create: {
                width: 96,
                height: 96,
                channels: 3,
                background: '#aa4466',
            },
        }).png().toBuffer()
        mocks.render.mockImplementation(async request => {
            await request.onImagePartial?.(providerPartial.toString('base64'), 1)

            return providerResult(request)
        })
        const publishImagePartial = vi.fn(async () => undefined)

        const result = await strategy(async () =>
            assessment(
                true,
                0.1,
                'single-panel-composition',
            )
        ).execute(context(), executionPlan, { publishImagePartial })
        const trace = result.capabilityMediaTrace as {
            panels: Array<{
                panelId: string
                status: string
                warning?: string
            }>
        }

        expect(mocks.render).toHaveBeenCalledOnce()
        expect(publishImagePartial).toHaveBeenCalledTimes(2)
        expect(mocks.compose).toHaveBeenCalledTimes(3)
        expect(mocks.compose.mock.calls[0]?.[0].panels).toEqual([{
            panelId: 'head-front-neutral',
            bytes: providerPartial,
        }])
        const retainedTerminal = mocks.compose.mock.calls[1]?.[0].panels[0]?.bytes
        const finalTerminal = mocks.compose.mock.calls.at(-1)?.[0].panels[0]?.bytes
        expect(Buffer.isBuffer(retainedTerminal)).toBe(true)
        expect(
            retainedTerminal?.equals(providerPartial),
            'the structurally rejected terminal should replace the earlier provider partial',
        ).toBe(false)
        expect(
            finalTerminal?.equals(retainedTerminal),
            'final composition should retain the same rejected terminal shown in the failed preview',
        ).toBe(true)
        expect(result.mediaComposition?.components).toEqual([
            expect.objectContaining({
                componentId: 'head-front-neutral',
                role: 'character-sheet-panel-review-only',
            }),
        ])
        expect(trace.panels).toContainEqual(expect.objectContaining({
            panelId: 'head-front-neutral',
            status: 'needs-review',
            warning: 'CHARACTER_PANEL_STRUCTURAL_CONTRACT_FAILED:head-front-neutral:single-panel-composition',
        }))
    })

    it('retains the last provider partial when the provider fails before terminal output', async () => {
        const providerPartial = await sharp({
            create: {
                width: 96,
                height: 96,
                channels: 3,
                background: '#aa4466',
            },
        }).png().toBuffer()
        mocks.render.mockImplementationOnce(async request => {
            await request.onImagePartial?.(providerPartial.toString('base64'), 1)

            throw new Error('provider disconnected')
        })

        const result = await strategy(async () => assessment(false)).execute(context(), plan(), {})

        expect(mocks.render).toHaveBeenCalledOnce()
        expect(mocks.compose.mock.calls.at(-1)?.[0].panels).toEqual([{
            panelId: 'head-front-neutral',
            bytes: providerPartial,
        }])
        expect(result.mediaComposition?.components).toEqual([
            expect.objectContaining({
                componentId: 'head-front-neutral',
                role: 'character-sheet-panel-review-only',
                imageBase64: providerPartial.toString('base64'),
            }),
        ])
    })

    it('propagates provider failure and cancellation while cleaning all transient objects', async () => {
        mocks.render.mockImplementationOnce(async () => {
            throw new Error('provider rejected')
        })
        await expect(strategy(async () => assessment(false)).execute(context(), plan(), {}))
            .rejects.toThrow('provider rejected')
        expect(mocks.clear).toHaveBeenCalledOnce()

        vi.clearAllMocks()
        const controller = new AbortController()
        controller.abort(new Error('cancelled'))
        await expect(strategy(async () => assessment(false)).execute(context(), plan(), { signal: controller.signal }))
            .rejects.toThrow('cancelled')
        expect(mocks.render).not.toHaveBeenCalled()
        expect(mocks.clear).toHaveBeenCalledOnce()
    })

    it('propagates a provider abort without converting it into a failed required shot', async () => {
        mocks.render.mockRejectedValueOnce(new Error('Abort'))

        await expect(strategy(async () => assessment(false)).execute(context(), plan(), {}))
            .rejects.toMatchObject({ message: 'Abort' })
        expect(mocks.clear).toHaveBeenCalledOnce()
    })

    it('keeps the final sheet when only the optional generated prop fails', async () => {
        const executionPlan = buildCharacterSheetRenderPlan({
            capabilityRunId: 'run-1',
            sourceAssetIds: [],
            userPrompt: 'A courier; include their belongings',
        })
        mocks.render.mockImplementation(async request => {
            if (request.operationKey.includes(':prop-primary:'))
                throw new Error('prop unavailable')

            return providerResult(request)
        })

        const result = await strategy(async () => assessment(false)).execute(context(), executionPlan, {})
        const trace = result.capabilityMediaTrace as {
            totalProviderOperations: number
            panels: unknown[]
        }

        expect(result.generatedImages).toEqual([Buffer.from('composed-sheet').toString('base64')])
        expect(trace.totalProviderOperations).toBe(executionPlan.panels.length)
        expect(trace.panels).toContainEqual(expect.objectContaining({
            panelId: 'prop-primary',
            status: 'unavailable',
            warning: 'prop unavailable',
        }))
    })

    it('does not silently rerun a failed required identity anchor', async () => {
        mocks.render.mockRejectedValueOnce(new ProviderStatusError('capacity', 429))
        mocks.render.mockImplementation(async request => providerResult(request))

        await expect(strategy(async () => assessment(false)).execute(context(), plan(), {}))
            .rejects.toThrow('capacity')
        expect(mocks.render).toHaveBeenCalledOnce()
    })

    it('keeps accepted progress and blocks every later shot when the required outfit anchor fails', async () => {
        mocks.render.mockImplementation(async request => {
            if (request.operationKey.includes(':body-front:'))
                throw new Error('outfit unavailable')

            return providerResult(request)
        })

        const result = await strategy(async () => assessment(false)).execute(context(), plan(), {})

        expect(mocks.render).toHaveBeenCalledTimes(2)
        expect(mocks.render.mock.calls.some(([request]) => request.operationKey.includes(':body-back:')))
            .toBe(false)
        expect(result.mediaComposition?.components.map(component => component.componentId))
            .toEqual(['head-front-neutral'])
    })

    it('keeps accepted progress and blocks optional shots when the required back outfit anchor fails', async () => {
        const executionPlan = buildCharacterSheetRenderPlan({
            capabilityRunId: 'run-optional',
            sourceAssetIds: [],
            userPrompt: 'A courier in four shots',
        })
        mocks.render.mockImplementation(async request => {
            if (request.operationKey.includes(':body-back:'))
                throw new Error('back outfit unavailable')

            return providerResult(request)
        })

        const result = await strategy(async () => assessment(false)).execute(context(), executionPlan, {})

        expect(mocks.render).toHaveBeenCalledTimes(3)
        expect(mocks.render.mock.calls.some(([request]) => request.operationKey.includes(':body-profile:')))
            .toBe(false)
        expect(result.mediaComposition?.components.map(component => component.componentId))
            .toEqual(['head-front-neutral', 'body-front'])
    })

    it('retains a rejected body-front candidate while preventing back-body generation', async () => {
        const result = await strategy(async request =>
            request.panel.panelId === 'body-front'
                ? assessment(true, 0.1, 'target-view')
                : assessment(false)
        ).execute(context(), plan(), {})
        const trace = result.capabilityMediaTrace as {
            panels: Array<{
                panelId: string
                status: string
                warning?: string
            }>
        }

        expect(mocks.render).toHaveBeenCalledTimes(2)
        expect(mocks.render.mock.calls.some(([request]) => request.operationKey.includes(':body-back:')))
            .toBe(false)
        expect(result.mediaComposition?.components).toEqual([
            expect.objectContaining({
                componentId: 'head-front-neutral',
                role: 'character-sheet-panel',
            }),
            expect.objectContaining({
                componentId: 'body-front',
                role: 'character-sheet-panel-review-only',
            }),
        ])
        expect(trace.panels).toContainEqual(expect.objectContaining({
            panelId: 'body-front',
            status: 'needs-review',
            warning: 'CHARACTER_PANEL_STRUCTURAL_CONTRACT_FAILED:body-front:target-view',
        }))
        expect(trace.panels).toContainEqual(expect.objectContaining({
            panelId: 'body-back',
            status: 'unavailable',
        }))
    })

    it('rejects models that cannot carry all generated anchors required by the selected graph', async () => {
        const executionContext = context()
        executionContext.imageModel.meta.imageReferenceCapabilities!.maxIdentityReferenceImages = 2
        const executionPlan = buildCharacterSheetRenderPlan({
            capabilityRunId: 'run-optional',
            sourceAssetIds: [],
            userPrompt: 'A courier in four shots',
        })

        await expect(strategy(async () => assessment(false)).execute(executionContext, executionPlan, {}))
            .rejects.toThrow('CHARACTER_CREATOR_GENERATED_REFERENCE_BUDGET_UNSUPPORTED')
        expect(mocks.render).not.toHaveBeenCalled()
        expect(mocks.clear).not.toHaveBeenCalled()
    })

    it('continues with authorized source evidence and records a warning when analysis is unavailable', async () => {
        const executionPlan = plan()
        executionPlan.sourceAssetIds = ['asset-1']
        const failing = new CharacterSheetStrategy({
            ...runtime(),
            evidenceAnalyzer: {
                analyze: async () => {
                    throw new Error('analysis failed')
                },
            },
            panelAssessor: { assess: async () => assessment(false) },
        })

        const result = await failing.execute(context(), executionPlan, {})
        const trace = result.capabilityMediaTrace as { steps: Array<{
            stepId: string
            issues: string[]
        }> }

        expect(trace.steps).toContainEqual(expect.objectContaining({
            stepId: 'source-evidence',
            issues: [expect.stringContaining('analysis failed')],
        }))
        expect(mocks.clear).toHaveBeenCalledOnce()
    })

    it('keeps provider names out of Character and capability-media common layers', async () => {
        const sources = await Promise.all([
            new URL('./character-sheet-strategy.ts', import.meta.url),
            new URL('../../../../backend/capability-media-strategy.ts', import.meta.url),
            new URL('../../../../backend/capability-media-strategy-registry.ts', import.meta.url),
            new URL('../../../../backend/capability-media-dag-runner.ts', import.meta.url),
        ].map(async url => await readFile(url, 'utf8')))

        expect(sources.join('\n')).not.toMatch(/\b(?:OpenAI|Google|Stability)\b/u)
    })
})

// =============================================================================
// PIPELINE EXECUTION TRACES
// =============================================================================

describe('CharacterSheetStrategy — execution traces', () => {
    beforeAll(async () => {
        panelPng = await sharp({
            create: {
                width: 256,
                height: 256,
                channels: 3,
                background: '#6688aa',
            },
        }).png().toBuffer()
    })

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getAuthorizedAsset.mockResolvedValue({
            assetId: 'asset-1',
            organizationId: 'org-1',
            media: {
                renditions: {
                    canonical: {
                        status: 'ready',
                        blobHash: 'blob-1',
                        mimeType: 'image/png',
                    },
                },
            },
        })
        mocks.readBlob.mockResolvedValue(panelPng)
        mocks.render.mockImplementation(async request => providerResult(request))
    })

    const runWithProgress = async (): Promise<OperationProgressItem[]> => {
        const snapshots: OperationProgressItem[][] = []
        const executionPlan = buildCharacterSheetRenderPlan({
            capabilityRunId: 'run-1',
            sourceAssetIds: ['asset-1'],
            userPrompt: 'A courier',
        })
        await strategy(async () => assessment(false)).execute(context(), executionPlan, {
            reportProgress: async progress => {
                if (progress.items)
                    snapshots.push(progress.items)
            },
        })

        return snapshots.at(-1) ?? []
    }

    const findItem = (items: readonly OperationProgressItem[], id: string): OperationProgressItem | undefined => {
        for (const item of items) {
            if (item.id === id)
                return item

            const nested = findItem(item.children ?? [], id)

            if (nested)
                return nested
        }

        return undefined
    }

    it('traces the source references it resolved for the request', async () => {
        const items = await runWithProgress()

        const resolve = findItem(items, 'resolve-source-references')
        expect(resolve?.trace?.handles).toEqual([{
            kind: 'media',
            id: 'asset-1',
            displayName: 'asset-1',
            mediaKind: 'image',
            role: 'source-reference',
        }])
        expect(resolve?.trace?.facts).toContainEqual({
            label: 'Authorized source images',
            value: '1',
        })
    })

    it('traces the image model, its size param, its prompt, and its references for each rendered shot', async () => {
        const items = await runWithProgress()

        const render = findItem(items, 'render:head-front-neutral')
        const modelCall = render?.trace?.modelCalls?.[0]
        expect(modelCall).toMatchObject({
            role: 'media',
            provider: 'OpenAI',
            modelId: 'image-v1',
        })
        expect(modelCall?.params).toContainEqual({
            name: 'size',
            value: '1024x1536',
        })
        expect(modelCall?.params).toContainEqual({
            name: 'attempt',
            value: '1',
        })
        expect(modelCall?.prompt).toBeTruthy()
        expect(modelCall?.inputHandles?.length).toBeGreaterThan(0)
        expect(render?.trace?.facts?.some(fact => fact.label === 'References accepted by provider')).toBe(true)
    })

    it('names generated anchors handed to a later shot as run-generated rather than as Assets', async () => {
        const items = await runWithProgress()

        const backShot = findItem(items, 'render:body-back')
        const generated = backShot?.trace?.modelCalls?.[0]?.inputHandles
            ?.filter(handle => handle.note === 'Generated during this run') ?? []

        expect(generated.map(handle => handle.role)).toContain('canonical-anchor')
    })

    it('traces the assessor model and its per-dimension scores for each shot', async () => {
        const items = await runWithProgress()

        const assess = findItem(items, 'assess:head-front-neutral')
        const modelCall = assess?.trace?.modelCalls?.[0]
        expect(modelCall).toMatchObject({
            role: 'assessor',
            modelId: 'test/reasoning-v1',
        })
        expect(modelCall?.params).toContainEqual({
            name: 'target-view',
            value: '0.95',
        })
        expect(assess?.trace?.facts).toContainEqual({
            label: 'Verdict',
            value: 'passed',
        })
    })

    it('traces the compositor and what it placed', async () => {
        const items = await runWithProgress()

        expect(findItem(items, 'assemble-sheet')?.trace?.facts).toContainEqual({
            label: 'Compositor',
            value: 'sharp-character-sheet-3840x2560-v3',
        })
    })
})
