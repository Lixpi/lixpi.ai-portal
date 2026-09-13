import {
    LoadingStatus,
    NATS_SUBJECTS,
} from '@lixpi/constants'

import { subscriptionStore } from '$src/stores/subscriptionStore.ts'

const { USER_SUBSCRIPTION_SUBJECTS } = NATS_SUBJECTS

class SubscriptionService {
    constructor() {
        // SocketService.on({ event: USER_SUBSCRIPTION_SUBJECTS.GET_PAYMENT_METHOD_SETUP_INTENT_RESPONSE, callback: (response: any) => this._getPaymentMethodSetupIntent(response) })
        // SocketService.on({ event: USER_SUBSCRIPTION_SUBJECTS.GET_USER_PAYMENT_METHODS_RESPONSE, callback: (response: any) => this._getCustomerPaymentMethods(response) })
        // SocketService.on({ event: USER_SUBSCRIPTION_SUBJECTS.DELETE_USER_PAYMENT_METHOD_RESPONSE, callback: (response: any) => this._deletePaymentMethod(response) })
        // SocketService.on({ event: USER_SUBSCRIPTION_SUBJECTS.TOP_UP_USER_BALANCE_RESPONSE, callback: (response: any) => this._topUpCustomerBalance(response) })
        // SocketService.on({ event: USER_SUBSCRIPTION_SUBJECTS.USE_CREDITS_RESPONSE, callback: (response: any) => this._useCredits(response) })
    }

    getPaymentMethodSetupIntent(): void {
        // Set loading state
        // subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.loading })
        // subscriptionStore.setDataValues({
        //     paymentMethodSetupIntentSecret: ''
        // })
        // SocketService.emit({
        //     event: USER_SUBSCRIPTION_SUBJECTS.GET_PAYMENT_METHOD_SETUP_INTENT,
        //     data: {}
        // })
    }
    _getPaymentMethodSetupIntent(response: any): void {
        // console.log('_getPaymentMethodSetupIntent', response)
        // if (response) {
        //     subscriptionStore.setDataValues(response)
        //     subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.success })
        // } else {
        //     subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.error })
        // }
    }

    getCustomerPaymentMethods() {
        // Set loading state
        // subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.loading })
        // SocketService.emit({
        //     event: USER_SUBSCRIPTION_SUBJECTS.GET_USER_PAYMENT_METHODS,
        //     data: {}
        // })
    }
    _getCustomerPaymentMethods(response: any): void {
        // console.log('_getCustomerPaymentMethods', response)
        // if (response) {
        //     subscriptionStore.setDataValues({ paymentMethods: response })
        //     subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.success })
        // } else {
        //     subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.error })
        // }
    }

    deletePaymentMethod({ paymentMethodId }: { paymentMethodId: string }): void {
        // // Set loading state
        // subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.loading })
        // console.log('deletePaymentMethod', paymentMethodId)
        // SocketService.emit({
        //     event: USER_SUBSCRIPTION_SUBJECTS.DELETE_USER_PAYMENT_METHOD,
        //     data: { paymentMethodId }
        // })
    }
    _deletePaymentMethod(response: any): void {
        // console.log('_deletePaymentMethod', response)
        // if (response) {
        //     // subscriptionStore.setDataValues({ paymentMethods: response })
        //     // subscriptionStore.setMetaValues({ isLoading: false, isLoaded: true, errorLoading: false })
        //     // Refresh the payment methods after deleting one
        //     this.getCustomerPaymentMethods()
        // } else {
        //     subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.error })
        // }
    }

    topUpCustomerBalance({ amount }: { amount: number }): void {
        // // Set loading state
        // subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.loading })
        // SocketService.emit({
        //     event: USER_SUBSCRIPTION_SUBJECTS.TOP_UP_USER_BALANCE,
        //     data: { amount }
        // })
    }
    _topUpCustomerBalance(response: any): void {
        // if (response.data) {
        //     userStore.setDataValues(response.data)    // Subscription update contains values that has to be updated in the user store
        //     subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.success, ...response.meta })
        //     subscriptionStore.setUiValues({
        //         hasError: false,
        //         dialogDescription: 'Here you can add credits to your account.'
        //     })
        // } else {
        //     subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.error, ...response.meta })
        //     subscriptionStore.setUiValues({
        //         hasError: true,
        //         dialogDescription: 'An error occurred while trying to top up your balance. Please try again later.'
        //     })
        // }
    }

    // useCredits({ amount }: { amount: number }): void {
    // }
    _useCredits(response: any): void {
        // console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
        // console.log('_useCredits', response.data)
        // if (response.data) {
        //     userStore.setDataValues(response.data)    // Subscription update contains values that has to be updated in the user store
        //     // subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.success, ...response.meta })
        // } else {
        //     // subscriptionStore.setMetaValues({ loadingStatus: LoadingStatus.error, ...response.meta })
        // }
    }
}

export default SubscriptionService
