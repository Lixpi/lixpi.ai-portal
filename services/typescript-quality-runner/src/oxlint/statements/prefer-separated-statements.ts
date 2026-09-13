import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'

// Block and control-flow statements that must be separated from their neighbors by a blank line.
const separatedBlockStatementTypes = new Set([
    'BlockStatement',
    'DoWhileStatement',
    'ForInStatement',
    'ForOfStatement',
    'ForStatement',
    'IfStatement',
    'SwitchStatement',
    'TryStatement',
    'WhileStatement',
    'WithStatement',
])
const separatedControlFlowStatementTypes = new Set([
    'BreakStatement',
    'ContinueStatement',
    'ReturnStatement',
    'ThrowStatement',
])
const isSeparatedStatementType = (type: string): boolean => separatedBlockStatementTypes.has(type)
    || separatedControlFlowStatementTypes.has(type)

// Normalize every AST container that owns an ordered statement list. Switch cases store
// theirs under `consequent`; block-like containers store theirs under `body`.
const getStatementList = node => {
    if (
        node.type !== 'BlockStatement'
        && node.type !== 'Program'
        && node.type !== 'StaticBlock'
        && node.type !== 'TSModuleBlock'
    )
        return node.type === 'SwitchCase' ? node.consequent : null

    return node.body
}

// Find the whitespace range a spacing fix may replace without consuming comments or other
// syntax. A leading comment stays attached to the following statement.
const getStatementGap = (
    sourceCode,
    previousEnd: number,
    nextStart: number,
): [number, number] | null => {
    let gapStart = previousEnd
    const commentsInGap = sourceCode.getAllComments().filter(
        comment =>
            comment.range[0] >= previousEnd
            && comment.range[1] <= nextStart,
    )

    for (const comment of commentsInGap) {
        const precedingGap = sourceCode.text.slice(gapStart, comment.range[0])

        if (!precedingGap.includes('\n')) {
            gapStart = comment.range[1]

            continue
        }

        if (precedingGap.trim().length > 0)
            return null

        return [gapStart, comment.range[0]]
    }

    if (sourceCode.text.slice(gapStart, nextStart).trim().length > 0)
        return null

    return [gapStart, nextStart]
}

// Keep a blank line around block and terminating control-flow statements, while keeping
// adjacent switch labels together. Gap detection prevents comments from being displaced.
export const preferSeparatedStatements = defineRule({
    meta: {
        type: 'layout',
        fixable: 'whitespace',
        messages: {
            joinCases: 'Keep adjacent switch cases together without a blank line.',
            separateStatements: 'Separate grouped statements from adjacent siblings with one blank line.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context
        const reportSiblingGap = (
            previous,
            current,
            blankLine: boolean,
            messageId: string,
        ): void => {
            const gap = getStatementGap(
                sourceCode,
                previous.range[1],
                current.range[0],
            )

            if (!gap)
                return

            let replacementRange = gap
            let lineBreaks = blankLine ? '\n\n' : '\n'

            if (
                blankLine
                && sourceCode.text[gap[0]] === '\n'
            ) {
                replacementRange = [gap[0] + 1, gap[1]]
                lineBreaks = '\n'
            } else if (
                blankLine
                && sourceCode.text[gap[0]] === '\r'
                && sourceCode.text[gap[0] + 1] === '\n'
            ) {
                replacementRange = [gap[0] + 2, gap[1]]
                lineBreaks = '\r\n'
            }

            const replacement = `${lineBreaks}${getLineIndentation(sourceCode.text, gap[1])}`

            if (sourceCode.text.slice(replacementRange[0], replacementRange[1]) === replacement)
                return

            context.report({
                node: current,
                messageId,
                fix: fixer => fixer.replaceTextRange(replacementRange, replacement),
            })
        }
        const checkStatementList = (node): void => {
            const statements = getStatementList(node)

            if (!statements)
                return

            for (let index = 1; index < statements.length; index++) {
                const previous = statements[index - 1]
                const current = statements[index]

                if (
                    !isSeparatedStatementType(previous.type)
                    && !isSeparatedStatementType(current.type)
                )
                    continue

                reportSiblingGap(
                    previous,
                    current,
                    true,
                    'separateStatements',
                )
            }
        }
        const checkSwitchCases = (node): void => {
            for (let index = 1; index < node.cases.length; index++)
                reportSiblingGap(
                    node.cases[index - 1],
                    node.cases[index],
                    false,
                    'joinCases',
                )
        }

        return {
            BlockStatement: checkStatementList,
            Program: checkStatementList,
            StaticBlock: checkStatementList,
            SwitchCase: checkStatementList,
            SwitchStatement: checkSwitchCases,
            TSModuleBlock: checkStatementList,
        }
    },
})
