import { persistentJSON } from '@nanostores/persistent'
import { atom } from 'nanostores'

import {
    type StoreOptions,
} from './baseStore.ts'

export type Subscriber<Value> = (value: Value) => void
export type Updater<Value> = (value: Value) => Value
export type Unsubscriber = () => void

export type Writable<Value> = {
    get: () => Value
    listen: (run: Subscriber<Value>) => Unsubscriber
    set: (value: Value) => void
    subscribe: (run: Subscriber<Value>) => Unsubscriber
    update: (updater: Updater<Value>) => void
}

export const writable = <Value>(
    initial: Value,
    options: StoreOptions = {},
): Writable<Value> => {
    const store = options.persistence
        ? persistentJSON<Value>(options.persistence.key, initial)
        : atom<Value>(initial)

    return {
        get: () => store.get(),
        listen: run => store.listen(value => run(value)),
        set: value => store.set(value),
        subscribe: run => store.subscribe(value => run(value)),
        update: updater => store.set(
            updater(
                store.get(),
            ),
        ),
    }
}
