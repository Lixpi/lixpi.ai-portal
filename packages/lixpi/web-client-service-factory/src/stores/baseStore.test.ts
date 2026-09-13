import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

import { createStore } from './baseStore.ts'

describe('store factory', () => {
    beforeEach(() => void localStorage.clear())

    it('supports synchronous reads, partial updates, subscriptions, and reset', () => {
        const store = createStore({
            initialState: {
                meta: {
                    loading: false,
                },
                data: {
                    count: 1,
                    labels: ['initial'],
                },
            },
        })
        const subscriber = vi.fn()
        const unsubscribe = store.subscribe(subscriber)

        expect(store.getData('count')).toBe(1)
        expect(store.getMeta('loading')).toBe(false)

        store.setMetaValues({ loading: true })
        store.setDataValues({ count: 2 })

        expect(store.getData()).toEqual({
            count: 2,
            labels: ['initial'],
        })
        expect(store.getMeta()).toEqual({ loading: true })
        expect(subscriber).toHaveBeenCalledTimes(3)

        store.resetStore()
        expect(store.getData()).toEqual({
            count: 1,
            labels: ['initial'],
        })
        unsubscribe()
    })

    it('adds store-specific methods without sharing mutable initial data', () => {
        const initial = {
            meta: {
                loading: false,
            },
            data: {
                labels: ['initial'],
            },
        }
        type Methods = {
            addLabel: (label: string) => void
            clearLabels: () => void
        }
        const firstStore = createStore({
            initialState: initial,
            createMethods: (store): Methods => ({
                addLabel: label => void store.update(
                    state => ({
                        ...state,
                        data: {
                            ...state.data,
                            labels: [
                                ...state.data.labels,
                                label,
                            ],
                        },
                    }),
                ),
                clearLabels: () => void store.setDataValues({ labels: [] }),
            }),
        })
        const secondStore = createStore({ initialState: initial })

        firstStore.addLabel('first')

        expect(firstStore.getData('labels')).toEqual([
            'initial',
            'first',
        ])
        expect(secondStore.getData('labels')).toEqual(['initial'])
        expect(initial.data.labels).toEqual(['initial'])

        firstStore.clearLabels()
        expect(firstStore.getData('labels')).toEqual([])
    })

    it('keeps the method factory base API intact when domain methods reuse its names', () => {
        const store = createStore({
            initialState: new Map([['first', 1]]),
            createMethods: baseStore => ({
                get: (key: string): number | undefined => baseStore.get().get(key),
                set: (key: string, value: number): void => void baseStore.update(state => {
                    const nextState = new Map(state)
                    nextState.set(key, value)

                    return nextState
                }),
            }),
        })

        expect(store.get('first')).toBe(1)

        store.set(
            'second',
            2,
        )

        expect(store.get('second')).toBe(2)
    })

    it('creates plain-state stores without changing their subscription payload', () => {
        const initial = {
            items: new Map([['first', 1]]),
        }
        const store = createStore({
            initialState: initial,
            createMethods: store => ({
                add: (key: string, value: number): void => void store.update(state => {
                    const items = new Map(state.items)
                    items.set(key, value)

                    return { items }
                }),
            }),
        })
        const subscriber = vi.fn()
        store.subscribe(subscriber)

        store.add('second', 2)

        expect(store.get().items).toEqual(new Map([
            ['first', 1],
            ['second', 2],
        ]))
        expect(subscriber).toHaveBeenLastCalledWith({
            items: new Map([
                ['first', 1],
                ['second', 2],
            ]),
        })
        expect(initial.items).toEqual(new Map([['first', 1]]))

        store.resetStore()
        expect(store.get()).toEqual(initial)
        expect(store.get()).not.toBe(initial)
    })

    it('persists plain-state stores through the same factory', () => {
        const persistence = {
            key: 'store-factory:test',
        }
        const firstStore = createStore({
            initialState: {
                isOpen: true,
                width: null as number | null,
            },
            persistence,
        })

        firstStore.set({
            isOpen: false,
            width: 320,
        })

        expect(JSON.parse(localStorage.getItem('store-factory:test') as string)).toEqual({
            isOpen: false,
            width: 320,
        })

        const rehydratedStore = createStore({
            initialState: {
                isOpen: true,
                width: null as number | null,
            },
            persistence,
        })
        expect(rehydratedStore.get()).toEqual({
            isOpen: false,
            width: 320,
        })

        rehydratedStore.resetStore()
        expect(rehydratedStore.get()).toEqual({
            isOpen: true,
            width: null,
        })
    })
})
