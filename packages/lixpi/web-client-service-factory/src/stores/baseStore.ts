import {
    writable,
    type Writable,
} from './writable.ts'

export type BaseStoreState<Meta, Data> = {
    data: Data
    meta: Meta
}

export type Store<State> = Writable<State> & {
    resetStore: () => void
}

export type BaseStore<
    Meta,
    Data,
    State extends BaseStoreState<Meta, Data> = BaseStoreState<Meta, Data>,
> = Store<State> & {
    getData: {
        (): Data
        <Key extends keyof Data>(key: Key): Data[Key]
    }
    getMeta: {
        (): Meta
        <Key extends keyof Meta>(key: Key): Meta[Key]
    }
    setDataValues: (values?: Partial<Data>) => void
    setMetaValues: (values?: Partial<Meta>) => void
}

export type StoreForState<State> = State extends BaseStoreState<infer Meta, infer Data>
    ? BaseStore<Meta, Data, State>
    : Store<State>

export type StoreWithMethods<State, Methods extends object> =
    Omit<StoreForState<State>, keyof Methods> & Methods

export type StoreMethodsFactory<State, Methods extends object> = (store: StoreForState<State>) => Methods

export type StoreOptions = {
    persistence?: {
        key: string
    }
}

export type CreateStoreConfig<
    State,
    Methods extends object = Record<never, never>,
> = StoreOptions & {
    initialState: State
    createMethods?: StoreMethodsFactory<State, Methods>
}

class StoreImplementation<State> implements Store<State> {
    readonly #initialState: State
    readonly #store: Writable<State>

    readonly get = (): State => this.#store.get()
    readonly listen: Store<State>['listen']
    readonly set = (value: State): void => void this.#store.set(value)
    readonly subscribe: Store<State>['subscribe']
    readonly update = (updater: (value: State) => State): void => void this.#store.update(updater)

    readonly resetStore = (): void => void this.#store.set(
        structuredClone(this.#initialState),
    )

    constructor(
        initial: State,
        options: StoreOptions,
    ) {
        this.#initialState = structuredClone(initial)
        this.#store = writable(
            structuredClone(this.#initialState),
            options,
        )
        this.listen = run => this.#store.listen(run)
        this.subscribe = run => this.#store.subscribe(run)
    }
}

class BaseStoreImplementation<
    Meta,
    Data,
    State extends BaseStoreState<Meta, Data>,
> extends StoreImplementation<State> implements BaseStore<Meta, Data, State> {
    readonly getData = ((key?: keyof Data): Data | Data[keyof Data] => {
        const data = this.get().data

        return key === undefined ? data : data[key]
    }) as BaseStore<Meta, Data, State>['getData']

    readonly getMeta = ((key?: keyof Meta): Meta | Meta[keyof Meta] => {
        const meta = this.get().meta

        return key === undefined ? meta : meta[key]
    }) as BaseStore<Meta, Data, State>['getMeta']

    readonly setDataValues = (values: Partial<Data> = {}): void =>
        void this.update(
            state => ({
                ...state,
                data: {
                    ...state.data,
                    ...values,
                },
            }),
        )

    readonly setMetaValues = (values: Partial<Meta> = {}): void =>
        void this.update(
            state => ({
                ...state,
                meta: {
                    ...state.meta,
                    ...values,
                },
            }),
        )
}

const isBaseStoreState = (state: unknown): state is BaseStoreState<unknown, unknown> => typeof state === 'object'
    && state !== null
    && Object.hasOwn(state, 'data')
    && Object.hasOwn(state, 'meta')

export const createStore = <
    State,
    Methods extends object = Record<never, never>,
>({
    initialState,
    createMethods,
    persistence,
}: CreateStoreConfig<State, Methods>): StoreWithMethods<State, Methods> => {
    const options: StoreOptions = persistence
        ? { persistence }
        : {}
    const baseStore = (
        isBaseStoreState(initialState)
            ? new BaseStoreImplementation(initialState, options)
            : new StoreImplementation(initialState, options)
    ) as StoreForState<State>

    if (!createMethods)
        return baseStore as StoreWithMethods<State, Methods>

    return {
        ...baseStore,
        ...createMethods(baseStore),
    } as StoreWithMethods<State, Methods>
}
