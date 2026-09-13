import {
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import {
    getMediaGenerationUserEventSubject,
    NATS_SUBJECTS,
    type MediaGenerationRequestEvent,
} from '@lixpi/constants'

import {
    getMediaGenerationRequestEventStreamName,
    getMediaGenerationRequestEventSubject,
    getMediaGenerationRequestProgressSubject,
    getMediaGenerationRequestReplaySubject,
    MediaGenerationRequestEventLog,
} from './media-generation-request-event-log.ts'

// A JetStream lookup failure carrying the numeric code the purge path treats as missing.
class JetStreamLookupError extends Error {
    readonly code: number

    constructor(
        message: string,
        code: number,
    ) {
        super(message)
        this.code = code
    }
}

const event = (sequence: number): MediaGenerationRequestEvent => ({
    eventId: `event-${sequence}`,
    generationRequestId: 'request-1',
    sequence,
    status: 'MEDIA_GENERATION_REQUEST_STATUS',
    requestRevision: sequence,
    payload: { status: 'running' },
    createdAt: sequence,
})

describe('MediaGenerationRequestEventLog', () => {
    it('uses non-expiring per-workspace streams and deduplicated event IDs', async () => {
        const nats = {
            ensureJetStreamStream: vi.fn(async () => undefined),
            publishJetStream: vi.fn(async () => ({ seq: 7 })),
            publish: vi.fn(),
        }
        const log = new MediaGenerationRequestEventLog(nats as any)

        const appended = await log.append({
            userId: 'user-1',
            workspaceId: 'workspace/1',
            event: event(3),
        })

        expect(nats.ensureJetStreamStream).toHaveBeenCalledWith(expect.objectContaining({
            name: 'MEDIA_GENERATION_REQUEST_EVENTS_workspace_1',
            max_age: 0,
            max_msgs_per_subject: 10000,
        }))
        expect(nats.publishJetStream).toHaveBeenCalledWith(
            getMediaGenerationRequestEventSubject('workspace/1', 'request-1'),
            expect.any(Object),
            expect.objectContaining({ msgID: 'event-3' }),
        )
        expect(nats.publish).toHaveBeenCalledWith(
            `${
                getMediaGenerationUserEventSubject(
                    'user-1',
                    NATS_SUBJECTS.AI_INTERACTION_SUBJECTS.MEDIA_GENERATION_REQUEST.STATUS,
                )
            }.workspace_1.request-1`,
            expect.objectContaining({
                event: expect.objectContaining({ eventId: 'event-3' }),
                streamSequence: 7,
            }),
        )
        expect(appended.streamSequence).toBe(7)
    })

    it('stores each run progress stream on its own optimistic-concurrency subject', async () => {
        const nats = {
            ensureJetStreamStream: vi.fn(async () => undefined),
            publishJetStream: vi.fn(async () => ({ seq: 19 })),
            publish: vi.fn(),
        }
        const log = new MediaGenerationRequestEventLog(nats as any)

        await log.append({
            userId: 'user-1',
            workspaceId: 'workspace-1',
            expectedLastSubjectSequence: 12,
            event: {
                ...event(3),
                status: 'MEDIA_GENERATION_PROGRESS',
                payload: {
                    generationRun: 2,
                    progress: { phase: 'rendering' },
                },
            },
        })

        expect(nats.publishJetStream).toHaveBeenCalledWith(
            getMediaGenerationRequestProgressSubject('workspace-1', 'request-1', 2),
            expect.any(Object),
            expect.objectContaining({
                msgID: 'event-3',
                expect: expect.objectContaining({ lastSubjectSequence: 12 }),
            }),
        )
    })

    it('replays only the request subject in stream order and reports pagination', async () => {
        const envelopes = new Map([
            [4, {
                data: {
                    userId: 'user-1',
                    workspaceId: 'workspace-1',
                    event: event(1),
                    streamSequence: 0,
                },
                seq: 4,
            }],
            [9, {
                data: {
                    userId: 'user-1',
                    workspaceId: 'workspace-1',
                    event: event(2),
                    streamSequence: 0,
                },
                seq: 9,
            }],
            [12, {
                data: {
                    userId: 'user-1',
                    workspaceId: 'workspace-1',
                    event: event(3),
                    streamSequence: 0,
                },
                seq: 12,
            }],
        ])
        const getJetStreamMessage = vi.fn(async (_stream: string, selector: {
            last_by_subj?: string
            seq?: number
        }) => {
            if (selector.last_by_subj)
                return envelopes.get(12)

            return [...envelopes.entries()].find(([sequence]) => sequence >= (selector.seq ?? 1))?.[1]
        })
        const log = new MediaGenerationRequestEventLog({ getJetStreamMessage } as any)

        const replay = await log.replay({
            workspaceId: 'workspace-1',
            generationRequestId: 'request-1',
            startStreamSequence: 4,
            maxMessages: 2,
        })

        expect(replay.events.map(item => item.streamSequence)).toEqual([4, 9])
        expect(replay.hasMore).toBe(true)
        expect(replay.streamName).toBe(getMediaGenerationRequestEventStreamName('workspace-1'))
        expect(getJetStreamMessage).toHaveBeenCalledWith(
            getMediaGenerationRequestEventStreamName('workspace-1'),
            { last_by_subj: getMediaGenerationRequestReplaySubject('workspace-1', 'request-1') },
        )
    })

    it('reads the latest accumulated progress for one run without replaying the request', async () => {
        const progressEvent = {
            ...event(4),
            status: 'MEDIA_GENERATION_PROGRESS' as const,
            payload: {
                generationRun: 3,
                progress: { phase: 'assessing' },
            },
        }
        const getJetStreamMessage = vi.fn(async () => ({
            data: {
                userId: 'user-1',
                workspaceId: 'workspace-1',
                event: progressEvent,
                streamSequence: 0,
            },
            seq: 44,
        }))
        const log = new MediaGenerationRequestEventLog({ getJetStreamMessage } as any)

        const latest = await log.getLatestRunProgress({
            workspaceId: 'workspace-1',
            generationRequestId: 'request-1',
            generationRun: 3,
        })

        expect(getJetStreamMessage).toHaveBeenCalledWith(
            getMediaGenerationRequestEventStreamName('workspace-1'),
            { last_by_subj: getMediaGenerationRequestProgressSubject('workspace-1', 'request-1', 3) },
        )
        expect(latest?.streamSequence).toBe(44)
    })

    it('rejects event payloads above the bounded durable envelope size', async () => {
        const nats = {
            ensureJetStreamStream: vi.fn(async () => undefined),
            publishJetStream: vi.fn(),
        }
        const log = new MediaGenerationRequestEventLog(nats as any)

        await expect(log.append({
            userId: 'user-1',
            workspaceId: 'workspace-1',
            event: {
                ...event(1),
                payload: { detail: 'x'.repeat(70 * 1024) },
            },
        })).rejects.toThrow('MEDIA_REQUEST_EVENT_TOO_LARGE')
        expect(nats.publishJetStream).not.toHaveBeenCalled()
    })

    it('purges request events idempotently after their retention condition', async () => {
        const purgeJetStreamSubject = vi.fn(async () => {
            throw new JetStreamLookupError('no stream', 404)
        })
        const log = new MediaGenerationRequestEventLog({ purgeJetStreamSubject } as any)

        await expect(log.purgeRequest({
            workspaceId: 'workspace-1',
            generationRequestId: 'request-1',
        })).resolves.toBeUndefined()
        expect(purgeJetStreamSubject).toHaveBeenCalledWith(
            getMediaGenerationRequestEventStreamName('workspace-1'),
            getMediaGenerationRequestReplaySubject('workspace-1', 'request-1'),
        )
    })
})
