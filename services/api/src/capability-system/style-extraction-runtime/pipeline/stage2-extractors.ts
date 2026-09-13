import * as process from 'process'

import { warn } from '@lixpi/debug-tools'
import {
    type AxisExtraction,
    type StyleExtractionDependencies,
    type StyleExtractionState,
    type StyleExtractor,
    type StageLogger,
} from './types.ts'

import { getExtractors } from './extractors/registry.ts'

// Loading this stage must also populate the registry. The deleted fixed
// orchestrator used to own these side-effect imports, so keep registration
// beside the generic selector that depends on it.
import './extractors/palette-extractor.ts'
import './extractors/medium-signature-extractor.ts'
import './extractors/character-design-extractor.ts'
import './extractors/lighting-extractor.ts'
import './extractors/composition-extractor.ts'
import './extractors/mood-extractor.ts'
import './extractors/background-treatment-extractor.ts'
import './extractors/edge-treatment-extractor.ts'
import './extractors/line-quality-extractor.ts'
import './extractors/surface-texture-extractor.ts'

const DEFAULT_DOMINANCE_FLOOR = 0.3

// Cap on simultaneous extractor VLM calls. Firing all ~10 axes at once opened too many
// concurrent streaming connections to the provider and several were dropped mid-stream
// ("Connection error."). Batching keeps the connection count sane; tune via env.
const EXTRACTOR_CONCURRENCY = Math.max(1, Number(process.env.STYLE_EXTRACTOR_CONCURRENCY) || 4)

export const selectApplicableExtractors = (
    state: StyleExtractionState,
    extractors: StyleExtractor[] = getExtractors(),
): StyleExtractor[] => {
    const scene = state.sceneAssessment

    if (!scene)
        return []

    const intent = state.input.intent

    return extractors.filter(extractor => {
        const dominance = scene.axisDominance[extractor.axis] ?? 0

        if (dominance < (extractor.minDominance ?? DEFAULT_DOMINANCE_FLOOR))
            return false

        return extractor.applicableTo(scene, intent)
    })
}

export const runExtractorAxis = async (
    state: StyleExtractionState,
    axis: string,
    logger: StageLogger,
    deps: StyleExtractionDependencies,
    extractors: StyleExtractor[] = getExtractors(),
): Promise<Pick<StyleExtractionState, 'axisExtractions' | 'failedAxes'>> => {
    const scene = state.sceneAssessment
    const extractor = selectApplicableExtractors(state, extractors).find(candidate => candidate.axis === axis)

    if (
        !scene
        || !extractor
    )
        return {
            axisExtractions: {},
            failedAxes: [],
        }

    try {
        const extraction = await logger.span(
            `extractor:${extractor.axis}`,
            state.input.analysisModel.modelVersion,
            () => extractor.extract({
                scene,
                state,
                logger,
                deps,
            }),
            {
                inputSummary: `axis=${extractor.axis} dominance=${scene.axisDominance[extractor.axis] ?? 0}`,
                outputSummarizer: (result: AxisExtraction) =>
                    `axis=${result.axis} fieldKeys=[${Object.keys(result.fields ?? {}).slice(0, 6).join(',')}]`,
            },
        )

        return {
            axisExtractions: { [extractor.axis]: extraction },
            failedAxes: [],
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        warn(`Extractor "${extractor.axis}" failed: ${message}`)

        return {
            axisExtractions: {},
            failedAxes: [{
                axis: extractor.axis,
                error: message,
            }],
        }
    }
}

// Runs `worker` over `items` with at most `limit` in flight, preserving input order and
// isolating failures (same result shape as Promise.allSettled).
const runWithConcurrency = async <T, R>(
    items: T[],
    limit: number,
    worker: (
        item: T,
        index: number,
    ) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> => {
    const results: PromiseSettledResult<R>[] = new Array(items.length)
    let cursor = 0
    const runner = async (): Promise<void> => {
        for (let index = cursor++; index < items.length; index = cursor++) {
            try {
                results[index] = {
                    status: 'fulfilled',
                    value: await worker(items[index]!, index),
                }
            } catch (reason) {
                results[index] = {
                    status: 'rejected',
                    reason,
                }
            }
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, runner),
    )

    return results
}

// Stage 2 — Parallel modular extractors.
// Selects every registered extractor whose dominance score from the router
// passes the floor AND that declares itself applicable to the scene, then
// fans them out via Promise.allSettled so failures are isolated per axis.
export const runExtractors = async (
    state: StyleExtractionState,
    logger: StageLogger,
    deps: StyleExtractionDependencies,
): Promise<Partial<StyleExtractionState>> => {
    return await logger.span(
        'extractors',
        undefined,
        async () => {
            const scene = state.sceneAssessment

            if (!scene)
                return {
                    axisExtractions: {},
                    failedAxes: [],
                }

            const selected = selectApplicableExtractors(state)

            if (selected.length === 0)
                return {
                    axisExtractions: {},
                    failedAxes: [],
                }

            const results = await runWithConcurrency(
                selected,
                EXTRACTOR_CONCURRENCY,
                extractor => runExtractorAxis(
                    state,
                    extractor.axis,
                    logger,
                    deps,
                ),
            )
    
            let axisExtractions: Record<string, AxisExtraction> = {}
            const failedAxes: Array<{
                axis: string
                error: string
            }> = []
            results.forEach((result, index) => {
                const extractor = selected[index]!

                if (result.status === 'fulfilled') {
                    axisExtractions = {
                        ...axisExtractions,
                        ...result.value.axisExtractions,
                    }
                    failedAxes.push(...result.value.failedAxes)
                } else {
                    const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
                    warn(`Extractor "${extractor.axis}" failed outside its isolation boundary: ${message}`)
                    failedAxes.push({
                        axis: extractor.axis,
                        error: message,
                    })
                }
            })

            return {
                axisExtractions,
                failedAxes,
            }
        },
        {
            inputSummary: `dominanceKeys=${Object.keys(state.sceneAssessment?.axisDominance ?? {}).length}`,
            outputSummarizer: result => `extracted=${Object.keys(result.axisExtractions ?? {}).length} failed=${(result.failedAxes ?? []).length}`,
        },
    )
}
