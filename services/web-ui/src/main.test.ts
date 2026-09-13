import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    describe,
    expect,
    it,
} from 'vitest'

const mainSource = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8')

const getImportPosition = (specifier: string): number => {
    const position = mainSource.indexOf(specifier)

    expect(position, `main.ts should import ${specifier}`).toBeGreaterThanOrEqual(0)

    return position
}

describe('web-ui stylesheet order', () => {
    it('loads shared side-panel styles before view-specific overrides', () => {
        const sharedStylePosition = getImportPosition('@lixpi/ui-kit/styles/side-panel')
        const routesPosition = getImportPosition('$src/routes.ts')
        const layoutPosition = getImportPosition('$src/views/layouts/layout.ts')

        expect(
            sharedStylePosition < routesPosition,
            'shared side-panel styles should load before route view styles',
        ).toBe(true)
        expect(
            sharedStylePosition < layoutPosition,
            'shared side-panel styles should load before layout styles',
        ).toBe(true)
    })
})
