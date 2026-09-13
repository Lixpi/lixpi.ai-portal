import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import {
    err as debugError,
    info as debugInfo,
    warn as debugWarn,
} from '@lixpi/debug-tools'
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb'

import DynamoDBService, { isTransactionConditionalCheckFailure } from './dynamodb-service.ts'

// The service logs through @lixpi/debug-tools, which colours the message and runs every
// non-string argument through util.inspect before reaching console. Asserting on the
// debug-tools call keeps these expectations on the message and the error object the
// service actually reports, rather than on the console formatting.
vi.mock('@lixpi/debug-tools', () => ({
    err: vi.fn(),
    info: vi.fn(),
    infoStr: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
}))

type SendMock = ReturnType<typeof vi.fn>

const setDocumentClientSend = (service: DynamoDBService, sendMock: SendMock): void => {
    const internalService = service as unknown as {
        dynamodbDocumentClient: { send: SendMock }
    }

    internalService.dynamodbDocumentClient = {
        ...internalService.dynamodbDocumentClient,
        send: sendMock,
    }
}


describe('DynamoDBService', () => {
    beforeEach(() => {
        vi.mocked(debugWarn).mockReset()
        vi.mocked(debugError).mockReset()
        vi.mocked(debugInfo).mockReset()
    })

    afterEach(() => void vi.restoreAllMocks())

    it('throws when region is missing', () => void expect(() => new DynamoDBService({ region: '' })).toThrow('AWS region must be provided.'))

    // =============================================================================
    // prepareAttributes
    // =============================================================================

    describe('prepareAttributes', () => {
        it('uses the default delimiter when not provided', () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = service.prepareAttributes({
                userId: 'u1',
                runId: 'r1',
            })

            expect(result).toEqual({
                expression: '#userId = :userId, #runId = :runId',
                expressionAttributeValues: {
                    ':userId': 'u1',
                    ':runId': 'r1',
                },
                expressionAttributeNames: {
                    '#userId': 'userId',
                    '#runId': 'runId',
                },
            })
            expect(sendMock).not.toHaveBeenCalled()
        })

        it('builds expression strings and placeholder maps from attributes', () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = service.prepareAttributes(
                {
                    userId: 'u1',
                    runId: 'r1',
                    score: 42,
                },
                ' AND ',
            )

            expect(result).toEqual({
                expression: '#userId = :userId AND #runId = :runId AND #score = :score',
                expressionAttributeValues: {
                    ':userId': 'u1',
                    ':runId': 'r1',
                    ':score': 42,
                },
                expressionAttributeNames: {
                    '#userId': 'userId',
                    '#runId': 'runId',
                    '#score': 'score',
                },
            })
            expect(sendMock).not.toHaveBeenCalled()
        })
    })

    // =============================================================================
    // getItem
    // =============================================================================

    describe('getItem', () => {
        it('returns undefined and logs when required input is missing', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = await service.getItem({
                tableName: '',
                key: {},
                origin: 'getItem()',
            })

            expect(result).toBeUndefined()
            expect(sendMock).not.toHaveBeenCalled()
            expect(debugError).toHaveBeenCalledWith(
                expect.stringContaining('Error: Table name and key must be provided!, origin: getItem()'),
            )
        })

        it('returns item and logs consumed capacity on success', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                Item: {
                    userId: 'u1',
                    status: 'ready',
                },
                ConsumedCapacity: { CapacityUnits: 1 },
            })
            setDocumentClientSend(service, sendMock)

            const result = await service.getItem({
                tableName: 'users',
                key: { userId: 'u1' },
                origin: 'unit',
            })

            expect(result).toEqual({
                userId: 'u1',
                status: 'ready',
            })
            expect(sendMock).toHaveBeenCalledTimes(1)
            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toEqual({
                TableName: 'users',
                Key: { userId: 'u1' },
                ConsistentRead: false,
                ReturnConsumedCapacity: 'TOTAL',
            })
            expect(debugInfo).toHaveBeenCalledWith(
                expect.stringContaining('DynamoDB <- getItem users, capacityUnits: 1,'),
            )
        })

        it('logs and returns undefined when DynamoDB send rejects', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockRejectedValue(new Error('fail'))
            setDocumentClientSend(service, sendMock)

            const result = await service.getItem({
                tableName: 'users',
                key: { userId: 'u1' },
            })

            expect(result).toBeUndefined()
            expect(debugError).toHaveBeenCalledWith(
                `Error fetching record from DynamoDB users table:`,
                expect.any(Error),
            )
        })
    })

    // =============================================================================
    // queryItems
    // =============================================================================

    describe('queryItems', () => {
        it('returns undefined when key conditions are missing', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = await service.queryItems({
                tableName: 'users',
                keyConditions: {},
            })

            expect(result).toBeUndefined()
            expect(sendMock).not.toHaveBeenCalled()
            expect(debugError).toHaveBeenCalledWith('Key conditions must be provided.')
        })

        it('returns one page without pagination when fetchAllItems is false', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                Items: [{ id: 'u1' }, { id: 'u2' }],
                ConsumedCapacity: { CapacityUnits: 2 },
                LastEvaluatedKey: { pk: 'u2' },
            })
            setDocumentClientSend(service, sendMock)

            const result = await service.queryItems({
                tableName: 'users',
                keyConditions: { pk: 'u1' },
                origin: 'q1',
                fetchAllItems: false,
                limit: 2,
            })

            expect(result).toEqual({
                items: [{ id: 'u1' }, { id: 'u2' }],
                consumedCapacities: [{ CapacityUnits: 2 }],
                readIterations: 1,
                lastEvaluatedKey: { pk: 'u2' },
            })
            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toEqual({
                TableName: 'users',
                KeyConditionExpression: '#pk = :pk',
                ExpressionAttributeValues: { ':pk': 'u1' },
                ExpressionAttributeNames: { '#pk': 'pk' },
                Limit: 2,
                ScanIndexForward: true,
                ConsistentRead: false,
                ReturnConsumedCapacity: 'TOTAL',
            })
            expect(sendMock.mock.calls[0][0]).not.toHaveProperty('input.ExclusiveStartKey')
        })

        it('follows LastEvaluatedKey pagination when fetchAllItems is true', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
                .mockResolvedValueOnce({
                    Items: [{ id: 'p1' }],
                    ConsumedCapacity: { CapacityUnits: 2 },
                    LastEvaluatedKey: { pk: '2' },
                })
                .mockResolvedValueOnce({
                    Items: [{ id: 'p2' }],
                    ConsumedCapacity: { CapacityUnits: 4 },
                })
            setDocumentClientSend(service, sendMock)

            const result = await service.queryItems({
                tableName: 'users',
                keyConditions: { pk: 'u1' },
                origin: 'q2',
                fetchAllItems: true,
                limit: 1,
            })

            expect(result).toEqual({
                items: [{ id: 'p1' }, { id: 'p2' }],
                consumedCapacities: [{ CapacityUnits: 2 }, { CapacityUnits: 4 }],
                readIterations: 2,
            })
            expect((sendMock.mock.calls[1][0] as { input: Record<string, unknown> }).input.ExclusiveStartKey).toEqual({
                pk: '2',
            })
            expect(debugInfo).toHaveBeenCalledOnce()
        })

        it('builds a typed begins_with sort-key condition for prefix queries', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({ Items: [] })
            setDocumentClientSend(service, sendMock)

            await service.queryItems({
                tableName: 'capabilities-meta',
                keyConditions: { scopeAndOwner: 'global#system' },
                sortKeyCondition: {
                    key: 'searchKey',
                    operator: 'begins_with',
                    value: 'tool#character',
                },
                limit: 20,
            })

            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toEqual(expect.objectContaining({
                KeyConditionExpression: '#scopeAndOwner = :scopeAndOwner AND begins_with(#sortKey, :sortKeyValue)',
                ExpressionAttributeNames: {
                    '#scopeAndOwner': 'scopeAndOwner',
                    '#sortKey': 'searchKey',
                },
                ExpressionAttributeValues: {
                    ':scopeAndOwner': 'global#system',
                    ':sortKeyValue': 'tool#character',
                },
            }))
        })
    })

    // =============================================================================
    // scanItems
    // =============================================================================

    describe('scanItems', () => {
        it('returns undefined and logs when table name is missing', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = await service.scanItems({
                tableName: '',
                origin: 'scan1',
            })

            expect(result).toBeUndefined()
            expect(sendMock).not.toHaveBeenCalled()
            expect(debugError).toHaveBeenCalledWith('Error: Table name must be provided!, origin: scan1')
        })

        it('returns a single page by default', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                Items: [{ id: 'a' }, { id: 'b' }],
                ConsumedCapacity: { CapacityUnits: 1 },
                LastEvaluatedKey: { pk: 'a' },
            })
            setDocumentClientSend(service, sendMock)

            const result = await service.scanItems({
                tableName: 'users',
                origin: 'scan2',
                limit: 2,
            })

            expect(result).toEqual({
                items: [{ id: 'a' }, { id: 'b' }],
                consumedCapacities: [{ CapacityUnits: 1 }],
                scanIterations: 1,
                lastEvaluatedKey: { pk: 'a' },
            })
            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toEqual({
                TableName: 'users',
                Limit: 2,
                ConsistentRead: false,
                ReturnConsumedCapacity: 'TOTAL',
            })
            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).not.toHaveProperty('ExclusiveStartKey')
        })

        it('follows LastEvaluatedKey pagination when fetchAllItems is true', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
                .mockResolvedValueOnce({
                    Items: [{ id: 'page-1' }],
                    ConsumedCapacity: { CapacityUnits: 1 },
                    LastEvaluatedKey: { id: 'page-1' },
                })
                .mockResolvedValueOnce({
                    Items: [{ id: 'page-2' }],
                    ConsumedCapacity: { CapacityUnits: 3 },
                })
            setDocumentClientSend(service, sendMock)

            const result = await service.scanItems({
                tableName: 'users',
                origin: 'scan3',
                limit: 1,
                fetchAllItems: true,
            })

            expect(result).toEqual({
                items: [{ id: 'page-1' }, { id: 'page-2' }],
                consumedCapacities: [{ CapacityUnits: 1 }, { CapacityUnits: 3 }],
                scanIterations: 2,
            })
            expect((sendMock.mock.calls[1][0] as { input: Record<string, unknown> }).input.ExclusiveStartKey).toEqual({
                id: 'page-1',
            })
        })
    })

    // =============================================================================
    // batchReadItems
    // =============================================================================

    describe('batchReadItems', () => {
        it('logs and returns empty result when BatchGetCommand fails', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const error = new Error('read fail')
            const sendMock = vi.fn().mockRejectedValue(error)
            setDocumentClientSend(service, sendMock)

            const result = await service.batchReadItems({
                queries: [{
                    tableName: 'tableA',
                    keys: [{ id: '1' }],
                }],
                readBatchSize: 1,
                fetchAllItems: true,
            })

            expect(result).toEqual({
                items: {},
                consumedCapacities: [],
                readIterations: 0,
            })
            expect(debugError).toHaveBeenCalledWith('Error fetching records from DynamoDB:', error)
            expect(sendMock).toHaveBeenCalledTimes(1)
        })

        it('returns an Error object when queries are missing', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = await service.batchReadItems({ queries: [] })

            expect(result).toBeInstanceOf(Error)
            expect((result as Error).message).toBe('Queries array must be provided and not be empty.')
            expect(sendMock).not.toHaveBeenCalled()
        })

        it('returns batched reads and aggregated metadata', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                Responses: {
                    tableA: [{ id: 'a1' }],
                },
                ConsumedCapacity: [{ CapacityUnits: 2 }],
                UnprocessedKeys: null,
            })
            setDocumentClientSend(service, sendMock)

            const result = await service.batchReadItems({
                queries: [{
                    tableName: 'tableA',
                    keys: [{ id: '1' }, { id: '2' }],
                }],
                readBatchSize: 2,
                fetchAllItems: false,
            })

            expect(result).toEqual({
                items: {
                    tableA: [{ id: 'a1' }],
                },
                consumedCapacities: [{ CapacityUnits: 2 }],
                readIterations: 1,
            })
            expect(result.consumedCapacities).toEqual([{ CapacityUnits: 2 }])
            expect(sendMock).toHaveBeenCalledTimes(1)
        })

        it('continues across batches and reverses order when scanIndexForward is false', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
                .mockResolvedValueOnce({
                    Responses: {
                        tableB: [{ id: 'first-page' }],
                    },
                    ConsumedCapacity: [{ CapacityUnits: 3 }],
                    UnprocessedKeys: { tableB: { Keys: [{ id: 'resume' }] } },
                })
                .mockResolvedValueOnce({
                    Responses: {
                        tableB: [{ id: 'second-page' }],
                    },
                    ConsumedCapacity: [{ CapacityUnits: 7 }],
                    UnprocessedKeys: {},
                })
            setDocumentClientSend(service, sendMock)

            const keys = Array.from({ length: 120 }).map((_, index) => ({ id: `item-${index}` }))
            const result = await service.batchReadItems({
                queries: [{
                    tableName: 'tableB',
                    keys,
                }],
                readBatchSize: 100,
                fetchAllItems: true,
                scanIndexForward: false,
            })

            expect(result.readIterations).toBe(2)
            expect(result.items.tableB).toEqual([{ id: 'second-page' }, { id: 'first-page' }])
            expect(result.consumedCapacities).toEqual([{ CapacityUnits: 3 }, { CapacityUnits: 7 }])
            expect(sendMock).toHaveBeenCalledTimes(2)
            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input.RequestItems['tableB'].Keys.length).toBe(100)
            expect((sendMock.mock.calls[1][0] as { input: Record<string, unknown> }).input.RequestItems['tableB'].Keys.length).toBe(20)
        })
    })

    // =============================================================================
    // batchWriteItems
    // =============================================================================

    describe('batchWriteItems', () => {
        it('returns undefined when input is incomplete', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const missingItemsResult = await service.batchWriteItems({
                tableName: '',
                items: [],
            })
            const missingTableResult = await service.batchWriteItems({
                tableName: '',
                items: [{ id: 'x' }],
            })

            expect(missingItemsResult).toBeUndefined()
            expect(missingTableResult).toBeUndefined()
            expect(debugError).toHaveBeenCalledWith(
                'Error: Table name and at least one item must be provided!, origin: unknown',
            )
        })

        it('writes all provided items in chunks and aggregates capacities', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                ConsumedCapacity: [{ CapacityUnits: 2 }],
            })
            setDocumentClientSend(service, sendMock)

            const items = Array.from({ length: 27 }).map((_, index) => ({ id: `item-${index}` }))
            const result = await service.batchWriteItems({
                tableName: 'tableW',
                items,
                origin: 'write',
            })

            expect(result).toEqual({
                totalItemsWritten: 27,
                consumedCapacities: [{ CapacityUnits: 2 }, { CapacityUnits: 2 }],
            })
            expect(sendMock).toHaveBeenCalledTimes(2)
            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input.RequestItems.tableW.length).toBe(25)
        })

        it('retries unprocessed items and preserves current batch count behavior', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
                .mockResolvedValueOnce({
                    ConsumedCapacity: [{ CapacityUnits: 1 }],
                    UnprocessedItems: {
                        tableRetry: [
                            { PutRequest: { Item: { id: 'retry-a' } } },
                        ],
                    },
                })
                .mockResolvedValueOnce({
                    ConsumedCapacity: [{ CapacityUnits: 1 }],
                })
            setDocumentClientSend(service, sendMock)

            const result = await service.batchWriteItems({
                tableName: 'tableRetry',
                items: [{ id: 'a' }, { id: 'b' }],
            })

            expect(result.totalItemsWritten).toBe(2)
            expect(result.consumedCapacities).toEqual([{ CapacityUnits: 1 }])
            expect(sendMock).toHaveBeenCalledTimes(2)
        })

        it('rethrows and logs on BatchWriteCommand failure', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const error = new Error('boom')
            const sendMock = vi.fn().mockRejectedValue(error)
            setDocumentClientSend(service, sendMock)

            await expect(
                service.batchWriteItems({
                    tableName: 'tableW',
                    items: [{ id: 'a' }],
                }),
            ).rejects.toThrow('boom')

            expect(debugError).toHaveBeenCalledWith('Error in batch write operation:', error)
        })
    })

    // =============================================================================
    // putItem
    // =============================================================================

    describe('putItem', () => {
        it('returns write response and logs capacity', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                ConsumedCapacity: { CapacityUnits: 2 },
                Attributes: { id: 'u1' },
            })
            setDocumentClientSend(service, sendMock)

            const result = await service.putItem({
                tableName: 'users',
                item: { id: 'u1' },
                origin: 'put',
            })

            expect(result).toEqual({
                ConsumedCapacity: { CapacityUnits: 2 },
                Attributes: { id: 'u1' },
            })
            expect(debugInfo).toHaveBeenCalledWith(
                expect.stringContaining('DynamoDB -> putItem users, capacityUnits: 2'),
            )
        })

        it('logs and returns undefined when write fails', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const error = new Error('put fail')
            const sendMock = vi.fn().mockRejectedValue(error)
            setDocumentClientSend(service, sendMock)

            const result = await service.putItem({
                tableName: 'users',
                item: { id: 'u1' },
            })

            expect(result).toBeUndefined()
            expect(debugError).toHaveBeenCalledWith('Error inserting record to DynamoDB users table:', error)
        })
    })

    // =============================================================================
    // updateItem
    // =============================================================================

    describe('updateItem', () => {
        it('returns undefined when no update expression is provided', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = await service.updateItem({
                tableName: 'users',
                key: { id: 'u1' },
            })

            expect(result).toBeUndefined()
            expect(sendMock).not.toHaveBeenCalled()
            expect(debugError).toHaveBeenCalledWith(
                "Either 'updates' or 'updateExpression' must be provided.",
            )
        })

        it('returns undefined and logs when required keys are missing', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = await service.updateItem({
                tableName: '',
                key: {},
            })

            expect(result).toBeUndefined()
            expect(sendMock).not.toHaveBeenCalled()
            expect(debugError).toHaveBeenCalledWith(
                'Error: Table name and key must be provided!, origin: unknown',
            )
        })

        it('builds a simple update expression from updates object', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                Attributes: { updated: true },
                ConsumedCapacity: { CapacityUnits: 4 },
            })
            setDocumentClientSend(service, sendMock)

            const result = await service.updateItem({
                tableName: 'users',
                key: { id: 'u1' },
                updates: { status: 'archived' },
                origin: 'upd',
            })

            expect(result).toEqual({ updated: true })
            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toMatchObject({
                TableName: 'users',
                Key: { id: 'u1' },
                ReturnValues: 'UPDATED_NEW',
                ReturnConsumedCapacity: 'TOTAL',
                UpdateExpression: 'SET #status = :status',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':status': 'archived' },
            })
        })

        it('uses direct update expression when updates are absent', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                Attributes: { id: 'u1' },
                ConsumedCapacity: { CapacityUnits: 3 },
            })
            setDocumentClientSend(service, sendMock)

            const result = await service.updateItem({
                tableName: 'users',
                key: { id: 'u1' },
                updateExpression: 'SET #status = :status',
                expressionAttributeNames: { '#status': 'status' },
                expressionAttributeValues: { ':status': 'active' },
            })

            expect(result).toEqual({ id: 'u1' })
            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toMatchObject({
                UpdateExpression: 'SET #status = :status',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':status': 'active' },
            })
        })

        it('does not log ConditionalCheckFailedException when disabled', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const conditionalError = new Error('condition failed') as Error & { name: string }
            conditionalError.name = 'ConditionalCheckFailedException'
            const sendMock = vi.fn().mockRejectedValue(conditionalError)
            setDocumentClientSend(service, sendMock)

            await expect(
                service.updateItem({
                    tableName: 'users',
                    key: { id: 'u1' },
                    updates: { status: 'ready' },
                    logConditionalCheckFailures: false,
                    origin: 'cond',
                }),
            ).rejects.toThrow('condition failed')
            expect(debugError).not.toHaveBeenCalled()
        })

        it('still logs non-conditional failures even when conditional logging is disabled', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const failure = new Error('fail') as Error & { name: string }
            failure.name = 'OtherException'
            const sendMock = vi.fn().mockRejectedValue(failure)
            setDocumentClientSend(service, sendMock)

            await expect(
                service.updateItem({
                    tableName: 'users',
                    key: { id: 'u1' },
                    updates: { status: 'ready' },
                    logConditionalCheckFailures: false,
                    origin: 'cond2',
                }),
            ).rejects.toThrow('fail')
            expect(debugError).toHaveBeenCalledWith('Error updating item:', failure)
        })

        it('includes custom condition expression when provided', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                Attributes: { updated: true },
                ConsumedCapacity: { CapacityUnits: 6 },
            })
            setDocumentClientSend(service, sendMock)

            await service.updateItem({
                tableName: 'users',
                key: { id: 'u1' },
                updates: { status: 'ready' },
                conditionExpression: 'attribute_exists(id)',
            })

            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toMatchObject({
                ConditionExpression: 'attribute_exists(id)',
            })
        })

        it('preserves condition placeholders when updates build the update expression', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                Attributes: { updated: true },
                ConsumedCapacity: { CapacityUnits: 2 },
            })
            setDocumentClientSend(service, sendMock)

            await service.updateItem({
                tableName: 'capability-runs',
                key: {
                    runId: 'run-1',
                    workspaceId: 'workspace-1',
                },
                updates: {
                    status: 'running',
                    updatedAt: 2,
                },
                conditionExpression: '#status IN (:expectedStatus0)',
                expressionAttributeNames: { '#status': 'status' },
                expressionAttributeValues: { ':expectedStatus0': 'pending' },
            })

            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toMatchObject({
                UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
                ConditionExpression: '#status IN (:expectedStatus0)',
                ExpressionAttributeNames: {
                    '#status': 'status',
                    '#updatedAt': 'updatedAt',
                },
                ExpressionAttributeValues: {
                    ':status': 'running',
                    ':updatedAt': 2,
                    ':expectedStatus0': 'pending',
                },
            })
        })
    })

    // =============================================================================
    // transactWrite
    // =============================================================================

    describe('transactWrite', () => {
        it('throws when no operations are provided', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            await expect(
                service.transactWrite({
                    operations: [],
                    origin: 'trans',
                }),
            ).rejects.toThrow('at least one operation must be provided')
            expect(sendMock).not.toHaveBeenCalled()
        })

        it('builds Put, Update, and Delete transact items from typed operations', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                ResponseMetadata: {},
                ConsumedCapacity: [{ CapacityUnits: 6 }],
            })
            setDocumentClientSend(service, sendMock)

            await service.transactWrite({
                operations: [
                    {
                        type: 'put',
                        tableName: 'users',
                        item: { id: 'u1' },
                    },
                    {
                        type: 'update',
                        tableName: 'users-meta',
                        key: { id: 'u1' },
                        updates: { status: 'ready' },
                    },
                    {
                        type: 'delete',
                        tableName: 'users-access',
                        key: { id: 'u1' },
                    },
                ],
                origin: 'trans2',
            })

            const input = (sendMock.mock.calls[0][0] as { input: Record<string, any> }).input
            expect(input.TransactItems).toEqual([
                { Put: {
                    TableName: 'users',
                    Item: { id: 'u1' },
                } },
                {
                    Update: {
                        TableName: 'users-meta',
                        Key: { id: 'u1' },
                        UpdateExpression: 'SET #status = :status',
                        ExpressionAttributeNames: { '#status': 'status' },
                        ExpressionAttributeValues: { ':status': 'ready' },
                    },
                },
                { Delete: {
                    TableName: 'users-access',
                    Key: { id: 'u1' },
                } },
            ])
            expect(debugInfo).toHaveBeenCalledWith(
                expect.stringContaining('DynamoDB -> transactWrite users,users-meta,users-access, capacityUnits: 6,'),
            )
        })

        it('passes custom update expressions and conditions through', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                ResponseMetadata: {},
                ConsumedCapacity: [{ CapacityUnits: 2 }],
            })
            setDocumentClientSend(service, sendMock)

            await service.transactWrite({
                operations: [
                    {
                        type: 'update',
                        tableName: 'workspaces',
                        key: { workspaceId: 'ws-1' },
                        updateExpression: 'SET #updatedAt = :updatedAt',
                        conditionExpression: '#updatedAt = :expected',
                        expressionAttributeNames: { '#updatedAt': 'updatedAt' },
                        expressionAttributeValues: {
                            ':updatedAt': 2,
                            ':expected': 1,
                        },
                    },
                ],
                origin: 'trans3',
            })

            const input = (sendMock.mock.calls[0][0] as { input: Record<string, any> }).input
            expect(input.TransactItems[0].Update).toMatchObject({
                UpdateExpression: 'SET #updatedAt = :updatedAt',
                ConditionExpression: '#updatedAt = :expected',
            })
        })

        it('rethrows and logs when the transaction fails', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const error = new Error('transact fail')
            const sendMock = vi.fn().mockRejectedValue(error)
            setDocumentClientSend(service, sendMock)

            await expect(
                service.transactWrite({
                    operations: [{
                        type: 'put',
                        tableName: 'users',
                        item: { id: 'u1' },
                    }],
                }),
            ).rejects.toThrow('transact fail')
            expect(debugError).toHaveBeenCalledWith('Error completing DynamoDB transaction:', error)
        })

        it('suppresses logging for conditional-check cancellations when asked', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const error = new TransactionCanceledException({
                message: 'cancelled',
                $metadata: {},
                CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
            })
            const sendMock = vi.fn().mockRejectedValue(error)
            setDocumentClientSend(service, sendMock)

            await expect(
                service.transactWrite({
                    operations: [{
                        type: 'put',
                        tableName: 'users',
                        item: { id: 'u1' },
                    }],
                    logConditionalCheckFailures: false,
                }),
            ).rejects.toThrow('cancelled')
            expect(debugError).not.toHaveBeenCalledWith('Error completing DynamoDB transaction:', error)
            expect(isTransactionConditionalCheckFailure(error)).toBe(true)
            expect(isTransactionConditionalCheckFailure(new Error('other'))).toBe(false)
        })
    })

    // =============================================================================
    // deleteItems
    // =============================================================================

    describe('deleteItems', () => {
        it('returns undefined when key is missing', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = await service.deleteItems({
                tableName: 'users',
                key: {},
            })

            expect(result).toBeUndefined()
            expect(sendMock).not.toHaveBeenCalled()
            expect(debugError).toHaveBeenCalledWith('Key must be provided for delete operation')
        })

        it('deletes a single item when deleteRange is false', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn().mockResolvedValue({
                ConsumedCapacity: [{ CapacityUnits: 2 }],
            })
            setDocumentClientSend(service, sendMock)

            const result = await service.deleteItems({
                tableName: 'users',
                key: { id: 'u1' },
                deleteRange: false,
            })

            expect(result).toEqual([{ CapacityUnits: 2 }])
            expect(sendMock).toHaveBeenCalledTimes(1)
            expect((sendMock.mock.calls[0][0] as { input: Record<string, unknown> }).input).toEqual({
                RequestItems: {
                    users: [{ DeleteRequest: { Key: { id: 'u1' } } }],
                },
                ReturnConsumedCapacity: 'TOTAL',
            })
        })

        it('deletes all query results when deleteRange is true', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const querySpy = vi.spyOn(service, 'queryItems').mockResolvedValue({
                items: [{ id: 'a' }, { id: 'b' }],
                consumedCapacities: [],
                readIterations: 1,
            })
            const sendMock = vi.fn().mockResolvedValue({
                ConsumedCapacity: [{ CapacityUnits: 2 }],
            })
            setDocumentClientSend(service, sendMock)

            const result = await service.deleteItems({
                tableName: 'users',
                key: {
                    tenantId: 't1',
                    sortKey: 's1',
                },
                deleteRange: true,
            })

            expect(querySpy).toHaveBeenCalledWith({
                tableName: 'users',
                keyConditions: {
                    tenantId: 't1',
                    sortKey: 's1',
                },
                limit: 25,
                fetchAllItems: true,
                origin: 'deleteItems() :: deleteRange operation',
            })
            expect(result).toEqual([{ CapacityUnits: 2 }])
            expect(sendMock).toHaveBeenCalledTimes(1)
            querySpy.mockRestore()
        })

        it('falls back to direct key when deleteRange query returns no items', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            vi.spyOn(service, 'queryItems').mockResolvedValue({
                items: [],
                consumedCapacities: [],
                readIterations: 1,
            })
            const sendMock = vi.fn().mockResolvedValue({
                ConsumedCapacity: [{ CapacityUnits: 2 }],
            })
            setDocumentClientSend(service, sendMock)

            const result = await service.deleteItems({
                tableName: 'users',
                key: {
                    tenantId: 't1',
                    sortKey: 's1',
                },
                deleteRange: true,
            })

            expect(result).toEqual([])
            expect(sendMock).not.toHaveBeenCalled()
        })
    })

    // =============================================================================
    // softDeleteItem
    // =============================================================================

    describe('softDeleteItem', () => {
        it('returns undefined and logs when required args are missing', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = await service.softDeleteItem({
                tableName: 'users',
                key: {},
                timeToLiveAttributeName: '',
                timeToLiveAttributeValue: null,
            })

            expect(result).toBeUndefined()
            expect(sendMock).not.toHaveBeenCalled()
            expect(debugError).toHaveBeenCalledWith(
                'Key, time-to-live attribute name, and value must be provided.',
            )
        })

        it('forwards ttl update and prefixed origin into updateItem', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const updateItemSpy = vi.spyOn(service, 'updateItem').mockResolvedValue({ ok: true })
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            const result = await service.softDeleteItem({
                tableName: 'users',
                key: { id: 'u1' },
                timeToLiveAttributeName: 'ttl',
                timeToLiveAttributeValue: 1710000000,
                origin: 'soft',
            })

            expect(result).toEqual({ ok: true })
            expect(updateItemSpy).toHaveBeenCalledWith({
                tableName: 'users',
                key: { id: 'u1' },
                updates: {
                    ttl: 1710000000,
                },
                origin: 'softDeleteItem:soft',
            })
            expect(sendMock).not.toHaveBeenCalled()
            updateItemSpy.mockRestore()
        })

        it('rethrows and logs when update fails', async () => {
            const service = new DynamoDBService({ region: 'us-east-1' })
            const updateError = new Error('delete fail')
            vi.spyOn(service, 'updateItem').mockRejectedValue(updateError)
            const sendMock = vi.fn()
            setDocumentClientSend(service, sendMock)

            await expect(
                service.softDeleteItem({
                    tableName: 'users',
                    key: { id: 'u1' },
                    timeToLiveAttributeName: 'ttl',
                    timeToLiveAttributeValue: 1710000000,
                }),
            ).rejects.toThrow('delete fail')

            expect(debugError).toHaveBeenCalledWith('Error performing soft delete on DynamoDB users table:', updateError)
            expect(sendMock).not.toHaveBeenCalled()
        })
    })
})
