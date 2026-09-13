import {
    Plugin,
    PluginKey,
} from 'prosemirror-state'
import {
    type AuthTokenProvider,
} from '@lixpi/auth-client'

import { ImageNodeView } from '$src/components/proseMirror/plugins/imageSelectionPlugin/imageNodeView.ts'

export const imageSelectionPluginKey = new PluginKey('imageSelection')

export const imageSelectionPlugin = (auth?: AuthTokenProvider): Plugin => {
    return new Plugin({
        key: imageSelectionPluginKey,
        props: {
            nodeViews: {
                image(
                    node,
                    view,
                    getPos,
                ) {
                    return new ImageNodeView({
                        auth,
                        node,
                        view,
                        getPos: getPos as () => number | undefined,
                    })
                },
                aiGeneratedImage(
                    node,
                    view,
                    getPos,
                ) {
                    return new ImageNodeView({
                        auth,
                        node,
                        view,
                        getPos: getPos as () => number | undefined,
                    })
                },
            },
        },
    })
}
