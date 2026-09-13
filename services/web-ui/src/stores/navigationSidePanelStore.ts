import { createStore } from '@lixpi/web-client-service-factory'

export type NavigationSidePanelState = {
    isOpen: boolean
    width: number | null
}

type NavigationSidePanelStoreMethods = {
    getData: {
        (): NavigationSidePanelState
        <Key extends keyof NavigationSidePanelState>(key: Key): NavigationSidePanelState[Key]
    }
    setValues: (values?: Partial<NavigationSidePanelState>) => void
}

const STORAGE_KEY = 'navigationSidePanel:state'

const defaultState: NavigationSidePanelState = {
    isOpen: true,
    width: null,
}

export const userInfoPanelStore = createStore({ initialState: false })

export const navigationSidePanelStore = createStore({
    initialState: defaultState,
    createMethods: store => ({
        getData: ((key?: keyof NavigationSidePanelState) => {
            const state = store.get()

            return key === undefined ? state : state[key]
        }) as NavigationSidePanelStoreMethods['getData'],
        setValues: (values: Partial<NavigationSidePanelState> = {}): void =>
            void store.update(
                state => ({
                    ...state,
                    ...(typeof values.isOpen === 'boolean' ? { isOpen: values.isOpen } : {}),
                    ...(Object.hasOwn(values, 'width') ? { width: values.width ?? null } : {}),
                }),
            ),
    }),
    persistence: {
        key: STORAGE_KEY,
    },
})
