import { createWebClientService } from '@lixpi/web-client-service-factory'

import {
    MODEL_PARAMETERS_ROUTE_PATH,
    routes,
} from '$src/routes.ts'
import { createLayout } from '$src/views/layouts/layout.ts'
import '@lixpi/web-client-service-factory/styles/foundation'
import '$src/sass/styles.scss'

const application = createWebClientService({
    createView: ({ router }) => createLayout({ router }),
    onError: error => console.error('Application failed to start', error),
    routing: {
        fallbackPath: MODEL_PARAMETERS_ROUTE_PATH,
        onRouteChange: currentRoute => {
            const route = routes.find(candidate => candidate.path === currentRoute.path)
            document.title = route
                ? `${route.title} · AI Model Registry`
                : 'AI Model Registry'
        },
        routes,
    },
})

void application.start()

export const shutdownApplication = (): Promise<void> => application.destroy()
