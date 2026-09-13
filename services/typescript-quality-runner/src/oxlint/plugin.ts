import { definePlugin } from '@oxlint/plugins'
import { noBlockComments } from './comments/no-block-comments.ts'
import { noNestedTernary } from './conditions/no-nested-ternary.ts'
import { preferCompactIf } from './conditions/prefer-compact-if.ts'
import { preferMultilineCondition } from './conditions/prefer-multiline-condition.ts'
import { preferMultilineAttrChain } from './d3/prefer-multiline-attr-chain.ts'
import { preferArrowFunctionDeclaration } from './functions/prefer-arrow-function-declaration.ts'
import { preferExpressionArrowBody } from './functions/prefer-expression-arrow-body.ts'
import { preferVoidArrowBody } from './functions/prefer-void-arrow-body.ts'
import { noUnusedImports } from './imports/no-unused-imports.ts'
import { noNativeConsoleLogging } from './logging/no-native-console-logging.ts'
import { noObjectAssign } from './objects/no-object-assign.ts'
import { preferAttachedTrailingComma } from './objects/prefer-attached-trailing-comma.ts'
import { preferMultilineCollection } from './objects/prefer-multiline-collection.ts'
import { preferMultilineObject } from './objects/prefer-multiline-object.ts'
import { preferMultilineObjectPattern } from './objects/prefer-multiline-object-pattern.ts'
import { preferMultilineTypeLiteral } from './objects/prefer-multiline-type-literal.ts'
import { noCommaSeparatedStatements } from './statements/no-comma-separated-statements.ts'
import { preferSeparatedStatements } from './statements/prefer-separated-statements.ts'
import { requireAstFormatterRules } from './tooling/require-ast-formatter-rules.ts'

// This plugin contains repository rules that need AST-aware fixes or cross-rule behavior
// beyond Oxlint's built-in rule set. Rules are registered under the names consumed by the
// repository's Oxlint configuration.
export default definePlugin({
    meta: {
        name: 'lixpi',
    },
    rules: {
        'no-block-comments': noBlockComments,
        'no-native-console-logging': noNativeConsoleLogging,
        'no-comma-separated-statements': noCommaSeparatedStatements,
        'no-unused-imports': noUnusedImports,
        'prefer-attached-trailing-comma': preferAttachedTrailingComma,
        'prefer-arrow-function-declaration': preferArrowFunctionDeclaration,
        'prefer-compact-if': preferCompactIf,
        'prefer-expression-arrow-body': preferExpressionArrowBody,
        'prefer-void-arrow-body': preferVoidArrowBody,
        'prefer-multiline-attr-chain': preferMultilineAttrChain,
        'prefer-multiline-collection': preferMultilineCollection,
        'prefer-multiline-object-pattern': preferMultilineObjectPattern,
        'prefer-multiline-object': preferMultilineObject,
        'prefer-separated-statements': preferSeparatedStatements,
        'prefer-multiline-type-literal': preferMultilineTypeLiteral,
        'prefer-multiline-condition': preferMultilineCondition,
        'no-nested-ternary': noNestedTernary,
        'no-object-assign': noObjectAssign,
        'require-ast-formatter-rules': requireAstFormatterRules,
    },
})
