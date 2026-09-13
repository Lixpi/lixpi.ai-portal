import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'

// Split a multi-declarator statement while keeping comments attached to the declaration
// they precede or trail. Export and ambient prefixes are repeated for each new statement.
const getSeparatedVariableDeclarationText = (
    node,
    sourceCode,
): string => {
    const indentation = getLineIndentation(sourceCode.text, node.range[0])
    const comments = sourceCode.getCommentsInside(node)
    const declarationLines: string[] = []
    const exportPrefix = node.parent?.type === 'ExportNamedDeclaration' ? 'export ' : ''
    const declarePrefix = node.declare ? 'declare ' : ''

    for (let index = 0; index < node.declarations.length; index++) {
        const declaration = node.declarations[index]
        const previousDeclaration = node.declarations[index - 1]
        const nextDeclaration = node.declarations[index + 1]
        const leadingBoundary = previousDeclaration?.range[1]
            ?? node.range[0]
        const trailingBoundary = nextDeclaration?.range[0]
            ?? node.range[1]
        const leadingComments = comments.filter(
            comment =>
                comment.range[0] >= leadingBoundary
                && comment.range[1] <= declaration.range[0]
                && comment.loc.start.line !== previousDeclaration?.loc.end.line,
        )
        const trailingComments = comments.filter(
            comment =>
                comment.range[0] >= declaration.range[1]
                && comment.range[1] <= trailingBoundary
                && comment.loc.start.line === declaration.loc.end.line,
        )

        for (const comment of leadingComments)
            declarationLines.push(
                sourceCode.getText(comment),
            )

        const trailingText = trailingComments.length > 0
            ? ` ${trailingComments.map(comment => sourceCode.getText(comment)).join(' ')}`
            : ''
        declarationLines.push(`${exportPrefix}${declarePrefix}${node.kind} ${sourceCode.getText(declaration)}${trailingText}`)
    }

    return declarationLines.join(`\n${indentation}`)
}

// Require one declaration or side-effect expression per statement. Sequence expressions
// are fixed only when they are standalone, where splitting cannot change expression value.
export const noCommaSeparatedStatements = defineRule({
    meta: {
        type: 'suggestion',
        fixable: 'code',
        messages: {
            separateDeclarations: 'Declare each variable in a separate statement.',
            separateExpressions: 'Write each comma-separated expression as a separate statement.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        return {
            VariableDeclaration(node) {
                if (node.declarations.length <= 1)
                    return

                const parentType = node.parent?.type
                const canFix = (
                    parentType === 'BlockStatement'
                    || parentType === 'ExportNamedDeclaration'
                    || parentType === 'Program'
                    || parentType === 'StaticBlock'
                    || parentType === 'SwitchCase'
                )
                const replacementNode = parentType === 'ExportNamedDeclaration' ? node.parent : node

                context.report({
                    node,
                    messageId: 'separateDeclarations',
                    fix: canFix
                        ? fixer => fixer.replaceText(
                            replacementNode,
                            getSeparatedVariableDeclarationText(node, sourceCode),
                        )
                        : undefined,
                })
            },
            SequenceExpression(node) {
                if (node.parent?.type === 'SequenceExpression')
                    return

                const parent = node.parent
                const canFix = (
                    parent?.type === 'ExpressionStatement'
                    && sourceCode.getCommentsInside(node).length === 0
                )
                const indentation = canFix ? getLineIndentation(sourceCode.text, parent.range[0]) : ''

                context.report({
                    node,
                    messageId: 'separateExpressions',
                    fix: canFix
                        ? fixer =>
                            fixer.replaceText(
                                parent,
                                node.expressions.map(expression => sourceCode.getText(expression)).join(`\n${indentation}`),
                            )
                        : undefined,
                })
            },
        }
    },
})
