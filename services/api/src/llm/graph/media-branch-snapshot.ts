import {
    type MediaBranchCandidateImage,
    type MediaBranchCandidateSnapshot,
} from '@lixpi/constants'

// Rebuild a snapshot's transcript from the current candidate list. Whenever the
// candidate set is narrowed, the textual labels must be rebuilt alongside it —
// stale nodeIds in the transcript make the VLM produce decisions for media it
// can no longer see. Mirrors the browser-side builder in
// services/web-ui/src/services/ai-image-branching.ts.
export const buildCandidateTranscriptContext = (
    candidates: MediaBranchCandidateImage[],
    promptText: string,
    activeTargetCandidateId: string | undefined,
): string => {
    const candidateLines = candidates.map(
        candidate =>
            [
                `candidateId=${candidate.candidateId}`,
                candidate.nodeId ? `nodeId=${candidate.nodeId}` : undefined,
                `assetId=${candidate.assetId}`,
                `kind=${candidate.mediaKind ?? 'image'}`,
                `roles=${candidate.roleHints.join(',')}`,
                candidate.branchId ? `branchId=${candidate.branchId}` : undefined,
                candidate.visualEntitySummary ? `visualEntity=${candidate.visualEntitySummary}` : undefined,
                candidate.visualStyleSummary ? `visualStyle=${candidate.visualStyleSummary}` : undefined,
                candidate.promptText ? `promptText=${candidate.promptText.slice(0, 800)}` : undefined,
            ].filter(Boolean).join(' | '),
    )

    return [
        `Current user prompt: ${promptText}`,
        activeTargetCandidateId ? `Active target candidateId: ${activeTargetCandidateId}` : undefined,
        'Candidate media labels:',
        ...candidateLines,
    ].filter((line): line is string => typeof line === 'string').join('\n')
}

const mergeCandidateGroup = (
    candidates: MediaBranchCandidateImage[],
    activeTargetCandidateId: string | undefined,
    resolvedTargetCandidateId: string | undefined,
): MediaBranchCandidateImage => {
    const canonical = candidates.find(candidate => candidate.candidateId === activeTargetCandidateId)
        ?? candidates.find(candidate => candidate.candidateId === resolvedTargetCandidateId)
        ?? candidates[0]!
    const fallback = candidates.reduce(
        (merged, source) => ({
            ...merged,
            ...source,
        }),
        {},
    ) as MediaBranchCandidateImage

    return {
        ...fallback,
        ...canonical,
        candidateId: canonical.candidateId,
        assetId: canonical.assetId,
        roleHints: [...new Set(
            candidates.flatMap(candidate => candidate.roleHints),
        )],
        ancestorNodeIds: [...new Set(
            candidates.flatMap(candidate => candidate.ancestorNodeIds),
        )],
        sourceContextNodeIds: [...new Set(
            candidates.flatMap(candidate => candidate.sourceContextNodeIds),
        )],
        entityTags: [...new Set(
            candidates.flatMap(candidate => candidate.entityTags ?? []),
        )],
        styleTags: [...new Set(
            candidates.flatMap(candidate => candidate.styleTags ?? []),
        )],
    }
}

// One underlying Asset is one resolver/provider reference even when the same
// canvas media entered through two snapshots with different candidate IDs
// (`node:<nodeId>` from the browser and `<nodeId>` from workspace context).
// Preserve the active-target identity, merge its contextual roles, and remap
// every snapshot pointer to that canonical candidate.
export const deduplicateMediaBranchSnapshotCandidatesByAsset = (snapshot: MediaBranchCandidateSnapshot): MediaBranchCandidateSnapshot => {
    const candidatesByAssetId = new Map<string, MediaBranchCandidateImage[]>()

    for (const candidate of snapshot.candidates) {
        const candidates = candidatesByAssetId.get(candidate.assetId) ?? []
        candidates.push(candidate)
        candidatesByAssetId.set(candidate.assetId, candidates)
    }

    const candidateIdAliases = new Map<string, string>()
    const candidates = [...candidatesByAssetId.values()].map(candidateGroup => {
        const canonical = mergeCandidateGroup(
            candidateGroup,
            snapshot.activeTargetCandidateId,
            snapshot.resolvedTargetCandidateId,
        )

        for (const candidate of candidateGroup)
            candidateIdAliases.set(candidate.candidateId, canonical.candidateId)

        return canonical
    })
    const candidateIds = new Set(
        candidates.map(candidate => candidate.candidateId),
    )
    const remapCandidateId = (candidateId: string | undefined): string | undefined => {
        if (!candidateId)
            return undefined

        const remappedCandidateId = candidateIdAliases.get(candidateId) ?? candidateId

        return candidateIds.has(remappedCandidateId) ? remappedCandidateId : undefined
    }
    const activeTargetCandidateId = remapCandidateId(snapshot.activeTargetCandidateId)
    const resolvedTargetCandidateId = remapCandidateId(snapshot.resolvedTargetCandidateId)
    const explicitReferenceCandidateIds = [
        ...new Set(
            (snapshot.explicitReferenceCandidateIds ?? []).map(candidateId => remapCandidateId(candidateId)).filter(
                (candidateId): candidateId is string => Boolean(candidateId),
            ),
        ),
    ]
    const normalized: MediaBranchCandidateSnapshot = {
        ...snapshot,
        candidates,
        transcriptContext: buildCandidateTranscriptContext(
            candidates,
            snapshot.promptText,
            activeTargetCandidateId,
        ),
    }

    if (activeTargetCandidateId)
        normalized.activeTargetCandidateId = activeTargetCandidateId
    else
        delete normalized.activeTargetCandidateId

    if (resolvedTargetCandidateId)
        normalized.resolvedTargetCandidateId = resolvedTargetCandidateId
    else
        delete normalized.resolvedTargetCandidateId

    if (explicitReferenceCandidateIds.length > 0)
        normalized.explicitReferenceCandidateIds = explicitReferenceCandidateIds
    else
        delete normalized.explicitReferenceCandidateIds

    return normalized
}

// Only explicitly attached references may reach branch resolution. Rebuild the
// transcript from that allowlist even when the browser submits extra candidates
// or omits the allowlist entirely.
export const restrictSnapshotToExplicitRefs = (snapshot: MediaBranchCandidateSnapshot | undefined): MediaBranchCandidateSnapshot | undefined => {
    if (!snapshot)
        return undefined

    const explicitCandidateIds = new Set(snapshot.explicitReferenceCandidateIds ?? [])
    const candidates = snapshot.candidates.filter(candidate => explicitCandidateIds.has(candidate.candidateId))
    const activeTargetCandidateId = snapshot.activeTargetCandidateId
        && explicitCandidateIds.has(snapshot.activeTargetCandidateId)
        ? snapshot.activeTargetCandidateId
        : undefined
    const resolvedTargetCandidateId = snapshot.resolvedTargetCandidateId
        && explicitCandidateIds.has(snapshot.resolvedTargetCandidateId)
        ? snapshot.resolvedTargetCandidateId
        : undefined

    const restricted: MediaBranchCandidateSnapshot = {
        ...snapshot,
        candidates,
        explicitReferenceCandidateIds: candidates.map(candidate => candidate.candidateId),
        transcriptContext: buildCandidateTranscriptContext(
            candidates,
            snapshot.promptText,
            activeTargetCandidateId,
        ),
    }

    if (activeTargetCandidateId)
        restricted.activeTargetCandidateId = activeTargetCandidateId
    else
        delete restricted.activeTargetCandidateId

    if (resolvedTargetCandidateId)
        restricted.resolvedTargetCandidateId = resolvedTargetCandidateId
    else
        delete restricted.resolvedTargetCandidateId

    return deduplicateMediaBranchSnapshotCandidatesByAsset(restricted)
}
