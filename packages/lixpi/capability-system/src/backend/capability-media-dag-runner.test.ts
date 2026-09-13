import {
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import { CapabilityMediaDagRunner } from './capability-media-dag-runner.ts'

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

describe('CapabilityMediaDagRunner', () => {
    const nodes = [
        {
            nodeId: 'front',
            dependsOn: [],
        },
        {
            nodeId: 'profile',
            dependsOn: ['front'],
        },
        {
            nodeId: 'back',
            dependsOn: ['profile'],
        },
    ]

    it('executes dependencies and emits declaration-ordered events', async () => {
        const result = await new CapabilityMediaDagRunner(nodes, 2, 0).run({
            execute: async node => node.nodeId,
        })

        expect([...result.results.values()]).toEqual(['front', 'profile', 'back'])
        expect(result.events.filter(event => event.type === 'completed').map(event => event.nodeId))
            .toEqual(['front', 'profile', 'back'])
    })

    it('retries only retryable transport failures and always cleans up', async () => {
        const cleanup = vi.fn(async () => undefined)
        let attempts = 0
        await new CapabilityMediaDagRunner([nodes[0]!], 1, 1).run({
            execute: async () => {
                attempts += 1

                if (attempts === 1)
                    throw new ProviderStatusError('capacity', 429)

                return 'ok'
            },
            cleanup,
        })

        expect(attempts).toBe(2)
        expect(cleanup).toHaveBeenCalledOnce()
    })

    it('propagates cancellation and cleans up', async () => {
        const controller = new AbortController()
        const cleanup = vi.fn(async () => undefined)
        controller.abort(new Error('cancelled'))

        await expect(new CapabilityMediaDagRunner(nodes, 1, 0).run({
            execute: async () => 'unused',
            signal: controller.signal,
            cleanup,
        })).rejects.toThrow('cancelled')
        expect(cleanup).toHaveBeenCalledOnce()
    })

    it('records an allowed optional failure and continues independent work', async () => {
        const result = await new CapabilityMediaDagRunner(
            [
                {
                    nodeId: 'required',
                    dependsOn: [],
                },
                {
                    nodeId: 'optional',
                    dependsOn: [],
                },
            ],
            2,
            0,
        ).run({
            execute: async node => {
                if (node.nodeId === 'optional')
                    throw new Error('optional output unavailable')

                return node.nodeId
            },
            allowTerminalFailure: node => node.nodeId === 'optional',
        })

        expect(result.results.get('required')).toBe('required')
        expect(result.results.has('optional')).toBe(false)
        expect(result.events).toContainEqual(expect.objectContaining({
            nodeId: 'optional',
            type: 'failed',
        }))
    })

    it('supplies only declared producer outputs through configurable binding keys', async () => {
        const seenBindings = new Map<string, string[]>()
        const result = await new CapabilityMediaDagRunner(
            [
                {
                    nodeId: 'identity',
                    dependsOn: [],
                    outputBindings: [],
                },
                {
                    nodeId: 'outfit',
                    dependsOn: ['identity'],
                    outputBindings: [{
                        bindingKey: 'identity-anchor',
                        sourceNodeId: 'identity',
                        required: true,
                    }],
                },
                {
                    nodeId: 'back',
                    dependsOn: ['identity', 'outfit'],
                    outputBindings: [
                        {
                            bindingKey: 'identity-anchor',
                            sourceNodeId: 'identity',
                            required: true,
                        },
                        {
                            bindingKey: 'outfit-anchor',
                            sourceNodeId: 'outfit',
                            required: true,
                        },
                    ],
                },
            ],
            3,
            0,
        ).run({
            execute: async (node, context) => {
                seenBindings.set(node.nodeId, [...context.boundOutputs.keys()])

                return node.nodeId
            },
        })

        expect(seenBindings).toEqual(
            new Map([
                ['identity', []],
                ['outfit', ['identity-anchor']],
                ['back', ['identity-anchor', 'outfit-anchor']],
            ]),
        )
        expect([...result.results.keys()]).toEqual(['identity', 'outfit', 'back'])
    })

    it('uses durable initial outputs to satisfy dependencies without executing their producer nodes', async () => {
        const execute = vi.fn(async (node: { nodeId: string }) => `${node.nodeId}-new`)
        const result = await new CapabilityMediaDagRunner(
            [
                {
                    nodeId: 'identity',
                    dependsOn: [],
                    outputBindings: [],
                },
                {
                    nodeId: 'outfit',
                    dependsOn: ['identity'],
                    outputBindings: [{
                        bindingKey: 'identity-anchor',
                        sourceNodeId: 'identity',
                        required: true,
                    }],
                },
                {
                    nodeId: 'back',
                    dependsOn: ['identity', 'outfit'],
                    outputBindings: [
                        {
                            bindingKey: 'identity-anchor',
                            sourceNodeId: 'identity',
                            required: true,
                        },
                        {
                            bindingKey: 'outfit-anchor',
                            sourceNodeId: 'outfit',
                            required: true,
                        },
                    ],
                },
            ],
            2,
            0,
        ).run({
            initialResults: new Map([
                ['identity', 'identity-stored'],
                ['back', 'back-stored'],
            ]),
            execute,
        })

        expect(execute).toHaveBeenCalledOnce()
        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({ nodeId: 'outfit' }),
            expect.objectContaining({
                boundOutputs: new Map([['identity-anchor', 'identity-stored']]),
            }),
            undefined,
        )
        expect(result.results).toEqual(
            new Map([
                ['identity', 'identity-stored'],
                ['back', 'back-stored'],
                ['outfit', 'outfit-new'],
            ]),
        )
        expect(result.events.map(event => event.nodeId)).toEqual(['outfit', 'outfit'])
    })

    it('blocks missing required outputs and releases independent consumers in parallel after their barriers', async () => {
        let releaseConsumers = (): void => void (undefined)
        const consumerGate = new Promise<void>(resolve => void (releaseConsumers = resolve))
        let releaseStarted = (): void => void (undefined)
        const consumersStarted = new Promise<void>(resolve => void (releaseStarted = resolve))
        let activeConsumers = 0
        const parallelRunner = new CapabilityMediaDagRunner(
            [
                {
                    nodeId: 'identity',
                    dependsOn: [],
                    outputBindings: [],
                },
                {
                    nodeId: 'outfit',
                    dependsOn: ['identity'],
                    outputBindings: [{
                        bindingKey: 'identity-anchor',
                        sourceNodeId: 'identity',
                        required: true,
                    }],
                },
                {
                    nodeId: 'back',
                    dependsOn: ['identity', 'outfit'],
                    outputBindings: [
                        {
                            bindingKey: 'identity-anchor',
                            sourceNodeId: 'identity',
                            required: true,
                        },
                        {
                            bindingKey: 'outfit-anchor',
                            sourceNodeId: 'outfit',
                            required: true,
                        },
                    ],
                },
                {
                    nodeId: 'profile',
                    dependsOn: ['identity', 'outfit', 'back'],
                    outputBindings: [
                        {
                            bindingKey: 'identity-anchor',
                            sourceNodeId: 'identity',
                            required: true,
                        },
                        {
                            bindingKey: 'outfit-anchor',
                            sourceNodeId: 'outfit',
                            required: true,
                        },
                        {
                            bindingKey: 'back-anchor',
                            sourceNodeId: 'back',
                            required: true,
                        },
                    ],
                },
                {
                    nodeId: 'action',
                    dependsOn: ['identity', 'outfit', 'back'],
                    outputBindings: [
                        {
                            bindingKey: 'identity-anchor',
                            sourceNodeId: 'identity',
                            required: true,
                        },
                        {
                            bindingKey: 'outfit-anchor',
                            sourceNodeId: 'outfit',
                            required: true,
                        },
                        {
                            bindingKey: 'back-anchor',
                            sourceNodeId: 'back',
                            required: true,
                        },
                    ],
                },
            ],
            2,
            0,
        )
        const parallelRun = parallelRunner.run({
            execute: async node => {
                if (
                    node.nodeId === 'profile'
                    || node.nodeId === 'action'
                ) {
                    activeConsumers += 1

                    if (activeConsumers === 2)
                        releaseStarted()

                    await consumerGate
                }

                return node.nodeId
            },
        })

        await consumersStarted
        expect(activeConsumers).toBe(2)
        releaseConsumers()
        await parallelRun

        const blocked = await new CapabilityMediaDagRunner(
            [
                {
                    nodeId: 'identity',
                    dependsOn: [],
                    outputBindings: [],
                },
                {
                    nodeId: 'outfit',
                    dependsOn: ['identity'],
                    outputBindings: [{
                        bindingKey: 'identity-anchor',
                        sourceNodeId: 'identity',
                        required: true,
                    }],
                },
            ],
            2,
            0,
        ).run({
            execute: async node => {
                if (node.nodeId === 'identity')
                    throw new Error('unavailable')

                return node.nodeId
            },
            allowTerminalFailure: () => true,
        })

        expect(blocked.blockedNodes.get('outfit')).toEqual({
            missingBindingKeys: ['identity-anchor'],
            missingOutputNodeIds: ['identity'],
        })
    })
})
