import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'
import {
    compactIfStatementTypes,
    countLogicalEvaluations,
    getFormattedConditionText,
    unwrapParenthesizedExpression,
} from './condition-text.ts'

// Walks outward from a conditional branch to its own `?` or `:` punctuator. The
// branch node's range excludes any grouping parentheses, so the punctuator is the
// only boundary a rewrite can use without deleting one half of a parenthesis pair.
const getBranchPunctuator = (
    sourceCode,
    node,
    value: string,
    forward: boolean,
) => {
    let token = forward ? sourceCode.getTokenAfter(node) : sourceCode.getTokenBefore(node)

    while (
        token
        && token.value !== value
    ) {
        if (token.value !== (forward ? ')' : '('))
            return null

        token = forward ? sourceCode.getTokenAfter(token) : sourceCode.getTokenBefore(token)
    }

    return token
}

// Lay out compound conditions with one logical operand per line across control-flow tests,
// `for` clauses, and conditional expressions. Commented conditions are not auto-fixed.
export const preferMultilineCondition = defineRule({
    meta: {
        type: 'layout',
        fixable: 'code',
        messages: {
            preferMultilineCondition: 'Split every multi-item condition and its parenthesized subgroups across lines.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context
        const checkParenthesizedCondition = (node): void => {
            const logicalTest = unwrapParenthesizedExpression(node.test)

            if (
                logicalTest.type !== 'LogicalExpression'
                || countLogicalEvaluations(node.test) <= 1
            )
                return

            if (sourceCode.getCommentsInside(node.test).length > 0)
                return

            const openParenthesis = sourceCode.getTokenBefore(node.test)
            const closeParenthesis = sourceCode.getTokenAfter(node.test)

            if (
                openParenthesis?.value !== '('
                || closeParenthesis?.value !== ')'
            )
                return

            const indentation = getLineIndentation(sourceCode.text, node.range[0])
            const operandIndentation = `${indentation}    `
            let directBody = null

            if (node.type === 'IfStatement')
                directBody = node.consequent
            else if (node.type === 'WhileStatement')
                directBody = node.body

            const ownsCompactBodyBoundary = Boolean(
                directBody
                && directBody.type !== 'BlockStatement'
                && compactIfStatementTypes.has(directBody.type)
                && !sourceCode.getAllComments().some(
                    comment =>
                        comment.range[0] >= closeParenthesis.range[1]
                        && comment.range[1] <= directBody.range[0],
                ),
            )
            const replacementRange = [
                openParenthesis.range[0],
                ownsCompactBodyBoundary ? directBody.range[0] : closeParenthesis.range[1],
            ]
            const condition = getFormattedConditionText(
                node.test,
                sourceCode,
                operandIndentation,
                false,
            )

            if (!condition)
                return

            const bodyBoundary = ownsCompactBodyBoundary ? `\n${operandIndentation}` : ''
            const replacement = `(\n${condition}\n${indentation})${bodyBoundary}`

            if (sourceCode.text.slice(replacementRange[0], replacementRange[1]) === replacement)
                return

            context.report({
                node: node.test,
                messageId: 'preferMultilineCondition',
                fix: fixer => fixer.replaceTextRange(replacementRange, replacement),
            })
        }

        return {
            ConditionalExpression(node) {
                const logicalTest = unwrapParenthesizedExpression(node.test)

                if (
                    logicalTest.type !== 'LogicalExpression'
                    || countLogicalEvaluations(node.test) <= 1
                )
                    return

                if (sourceCode.getAllComments().some(
                    comment =>
                        comment.range[0] >= node.test.range[0]
                        && comment.range[1] <= node.alternate.range[0],
                ))
                    return

                const indentation = getLineIndentation(sourceCode.text, node.range[0])
                const openParenthesis = sourceCode.getTokenBefore(node.test)
                const ownsOpenParenthesis = Boolean(
                    openParenthesis
                    && openParenthesis.value === '('
                    && openParenthesis.range[0] >= node.range[0],
                )
                // Only a test the source parenthesized keeps a bracket. Every other test
                // leaves its first operand on the line it already sits on.
                const condition = ownsOpenParenthesis
                    ? getFormattedConditionText(
                        node.test,
                        sourceCode,
                        indentation,
                        true,
                    )
                    : getFormattedConditionText(
                        node.test,
                        sourceCode,
                        `${indentation}    `,
                        false,
                    )?.trimStart()

                if (!condition)
                    return

                const conditionStart = ownsOpenParenthesis ? openParenthesis.range[0] : node.test.range[0]
                const questionToken = getBranchPunctuator(
                    sourceCode,
                    node.test,
                    '?',
                    true,
                )
                const colonToken = getBranchPunctuator(
                    sourceCode,
                    node.alternate,
                    ':',
                    false,
                )

                if (
                    !questionToken
                    || !colonToken
                )
                    return

                const branchIndentation = `${indentation}    `
                const conditionRange = [conditionStart, sourceCode.getTokenAfter(questionToken).range[0]]
                const conditionReplacement = `${condition}\n${branchIndentation}? `
                const alternateRange = [
                    sourceCode.getTokenBefore(colonToken).range[1],
                    sourceCode.getTokenAfter(colonToken).range[0],
                ]
                const alternateReplacement = `\n${branchIndentation}: `

                if (
                    sourceCode.text.slice(conditionRange[0], conditionRange[1]) === conditionReplacement
                    && sourceCode.text.slice(alternateRange[0], alternateRange[1]) === alternateReplacement
                )
                    return

                context.report({
                    node: node.test,
                    messageId: 'preferMultilineCondition',
                    fix: fixer => [
                        fixer.replaceTextRange(conditionRange, conditionReplacement),
                        fixer.replaceTextRange(alternateRange, alternateReplacement),
                    ],
                })
            },
            DoWhileStatement: checkParenthesizedCondition,
            ForStatement(node) {
                if (
                    !node.test
                    || countLogicalEvaluations(node.test) <= 1
                )
                    return

                if (sourceCode.getCommentsInside(node).length > 0)
                    return

                const indentation = getLineIndentation(sourceCode.text, node.range[0])
                const clauseIndentation = `${indentation}    `
                const condition = getFormattedConditionText(
                    node.test,
                    sourceCode,
                    clauseIndentation,
                    false,
                )

                if (!condition)
                    return

                const initializer = node.init ? sourceCode.getText(node.init).trim() : ''
                const update = node.update ? sourceCode.getText(node.update).trim() : ''
                const clauses = [
                    'for (',
                    `${clauseIndentation}${initializer};`,
                    `${condition};`,
                ]

                if (update)
                    clauses.push(`${clauseIndentation}${update}`)

                clauses.push(`${indentation})${node.body.type === 'BlockStatement' ? ' ' : `\n${clauseIndentation}`}`)
                const replacement = clauses.join('\n')
                const replacementRange = [node.range[0], node.body.range[0]]

                if (sourceCode.text.slice(replacementRange[0], replacementRange[1]) === replacement)
                    return

                context.report({
                    node: node.test,
                    messageId: 'preferMultilineCondition',
                    fix: fixer => fixer.replaceTextRange(replacementRange, replacement),
                })
            },
            IfStatement: checkParenthesizedCondition,
            WhileStatement: checkParenthesizedCondition,
        }
    },
})
