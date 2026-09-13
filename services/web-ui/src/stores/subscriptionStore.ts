import {
    LoadingStatus,
    PaymentProcessingStatus,
} from '@lixpi/constants'
import { createStore } from '@lixpi/web-client-service-factory'

type Meta = {
    loadingStatus: LoadingStatus
    paymentProcessingStatus: PaymentProcessingStatus
    isPaymentDialogOpen: boolean
}

type Subscription = {
    paymentMethodSetupIntentSecret: string
    paymentMethods: any[]
}

type PaymentDialogUi = {
    dialogTitle: string
    dialogDescription: string
    hasError: boolean
}

type SubscriptionStoreState = {
    meta: Meta
    data: Subscription
    ui: PaymentDialogUi
}

const initialState: SubscriptionStoreState = {
    meta: {
        loadingStatus: LoadingStatus.idle,
        paymentProcessingStatus: PaymentProcessingStatus.idle,
        isPaymentDialogOpen: false,
    },
    data: {
        paymentMethodSetupIntentSecret: '',
        paymentMethods: [],
    },
    ui: {
        dialogTitle: '',
        dialogDescription: '',
        hasError: false,
    },
}

export const subscriptionStore = createStore({
    initialState,
    createMethods: store => ({
        setUiValues: (values: Partial<PaymentDialogUi> = {}): void =>
            void store.update(
                state => ({
                    ...state,
                    ui: {
                        ...state.ui,
                        ...structuredClone(values),
                    },
                }),
            ),
        resetUiValues: (): void =>
            void store.update(
                state => ({
                    ...state,
                    ui: structuredClone(initialState.ui),
                }),
            ),
    }),
})
