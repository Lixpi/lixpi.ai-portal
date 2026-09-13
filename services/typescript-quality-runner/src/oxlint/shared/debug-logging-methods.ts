// Native console methods map to debug-tools exports and collision-safe local aliases.
export const debugLoggingMethods = new Map([
    ['error', {
        importedName: 'err',
        preferredLocalName: 'debugError',
    }],
    ['info', {
        importedName: 'info',
        preferredLocalName: 'debugInfo',
    }],
    ['log', {
        importedName: 'log',
        preferredLocalName: 'debugLog',
    }],
    ['warn', {
        importedName: 'warn',
        preferredLocalName: 'debugWarn',
    }],
])
