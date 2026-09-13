import {
    createStaticWebClient,
    type StaticWebClientArgs,
} from './web-ui.ts'

export type WebUIUserPortalArgs = Omit<
    StaticWebClientArgs,
    'aliases' | 'buildDirectory' | 'builderContainerName' | 'bucketNameSegment' | 'serviceName'
>

export const createWebUIUserPortal = async (args: WebUIUserPortalArgs) =>
    await createStaticWebClient({
        ...args,
        serviceName: 'web-ui-user-portal',
        aliases: [args.domainName],
        buildDirectory: './dist/web-ui-user-portal',
        builderContainerName: 'web-ui-user-portal-builder',
        bucketNameSegment: 'user-portal',
    })
