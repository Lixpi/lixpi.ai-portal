import {
    LoadingStatus,
    type User,
} from '@lixpi/constants'
import { createGentelellaCard } from '@lixpi/ui-kit-gentelella/components/card'
import { createGentelellaPage } from '@lixpi/ui-kit-gentelella/components/page'
import { createGentelellaPageHeader } from '@lixpi/ui-kit-gentelella/components/page-header'
import { createGentelellaSpinner } from '@lixpi/ui-kit-gentelella/components/spinner'
import { createGentelellaStatus } from '@lixpi/ui-kit-gentelella/components/status'
import { createDocumentHtml } from '@lixpi/ui-primitives/dom'
import {
    type UserStateStore,
} from '@lixpi/auth-client'

export type UserInfoPageConfig = {
    document?: Document
    store: UserStateStore
}

export type UserInfoPageInstance = {
    readonly el: HTMLDivElement
    destroy: () => void
}

const formatTimestamp = (timestamp: number): string => {
    if (!timestamp)
        return 'Not available'

    return new Intl.DateTimeFormat(
        undefined,
        {
            dateStyle: 'medium',
            timeStyle: 'short',
        },
    ).format(
        new Date(timestamp),
    )
}

class UserInfoPage implements UserInfoPageInstance {
    readonly el: HTMLDivElement

    private readonly contentEl: HTMLDivElement
    private readonly document: Document
    private readonly store: UserStateStore
    private readonly unsubscribe: () => void

    constructor(config: UserInfoPageConfig) {
        this.document = config.document ?? globalThis.document
        this.store = config.store
        const html = createDocumentHtml(this.document)
        const header = createGentelellaPageHeader({
            document: this.document,
            pretitle: 'Account',
            title: 'User information',
        })
        this.contentEl = html`<div className="user-portal-user-content"></div>` as HTMLDivElement
        const page = createGentelellaPage({
            document: this.document,
            content: [
                header.el,
                this.contentEl,
            ],
        })
        this.el = page.el
        this.unsubscribe = this.store.subscribe(state => this.render(state.meta.loadingStatus, state.data))
    }

    private render(
        loadingStatus: LoadingStatus,
        user: User,
    ): void {
        this.contentEl.replaceChildren()

        if (
            loadingStatus === LoadingStatus.idle
            || loadingStatus === LoadingStatus.loading
        ) {
            this.renderLoading()

            return
        }

        if (loadingStatus === LoadingStatus.error) {
            this.renderError()

            return
        }

        this.renderUser(user)
    }

    private renderLoading(): void {
        const html = createDocumentHtml(this.document)
        const spinner = createGentelellaSpinner({
            document: this.document,
            label: 'Loading user information',
        })
        const card = createGentelellaCard({
            document: this.document,
            content: html`
                <div className="user-portal-state">
                    ${spinner.el}
                    <span>Loading user information…</span>
                </div>
            `,
        })
        this.contentEl.append(card.el)
    }

    private renderError(): void {
        const html = createDocumentHtml(this.document)
        const status = createGentelellaStatus({
            document: this.document,
            label: 'Unable to load',
            tone: 'red',
        })
        const card = createGentelellaCard({
            document: this.document,
            title: 'Profile',
            content: html`
                <div className="user-portal-state">
                    ${status.el}
                    <span>User information could not be loaded.</span>
                </div>
            `,
        })
        this.contentEl.append(card.el)
    }

    private renderUser(user: User): void {
        const html = createDocumentHtml(this.document)
        const subscriptionStatus = createGentelellaStatus({
            document: this.document,
            label: user.hasActiveSubscription ? 'Active' : 'Inactive',
            tone: user.hasActiveSubscription ? 'green' : 'gray',
        })
        const organizations = user.organizations.length > 0
            ? user.organizations.join(', ')
            : 'None'
        const card = createGentelellaCard({
            document: this.document,
            title: 'Profile',
            subtitle: 'Information returned by the existing authenticated user endpoint.',
            content: html`
                <dl className="user-portal-user-grid">
                    <div className="user-portal-user-field">
                        <dt className="user-portal-user-term">Name</dt>
                        <dd className="user-portal-user-value">${user.name || 'Not available'}</dd>
                    </div>
                    <div className="user-portal-user-field">
                        <dt className="user-portal-user-term">Email</dt>
                        <dd className="user-portal-user-value">${user.email || 'Not available'}</dd>
                    </div>
                    <div className="user-portal-user-field">
                        <dt className="user-portal-user-term">User ID</dt>
                        <dd className="user-portal-user-value user-portal-user-code-value">${user.userId || 'Not available'}</dd>
                    </div>
                    <div className="user-portal-user-field">
                        <dt className="user-portal-user-term">Given name</dt>
                        <dd className="user-portal-user-value">${user.givenName || 'Not available'}</dd>
                    </div>
                    <div className="user-portal-user-field">
                        <dt className="user-portal-user-term">Family name</dt>
                        <dd className="user-portal-user-value">${user.familyName || 'Not available'}</dd>
                    </div>
                    <div className="user-portal-user-field">
                        <dt className="user-portal-user-term">Subscription</dt>
                        <dd className="user-portal-user-value">${subscriptionStatus.el}</dd>
                    </div>
                    <div className="user-portal-user-field user-portal-wide-user-field">
                        <dt className="user-portal-user-term">Organizations</dt>
                        <dd className="user-portal-user-value">${organizations}</dd>
                    </div>
                    <div className="user-portal-user-field user-portal-wide-user-field">
                        <dt className="user-portal-user-term">Created</dt>
                        <dd className="user-portal-user-value">${formatTimestamp(user.createdAt)}</dd>
                    </div>
                </dl>
            `,
        })
        this.contentEl.append(card.el)
    }

    destroy(): void {
        this.unsubscribe()
        this.el.remove()
    }
}

export const createUserInfoPage = (config: UserInfoPageConfig): UserInfoPageInstance => new UserInfoPage(config)
