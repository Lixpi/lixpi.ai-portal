import {
    log as debugLog,
    err as debugError,
} from '@lixpi/debug-tools'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as prompts from '@clack/prompts'
import {
    createAccount,
    createCurve,
    createUser,
} from '@nats-io/nkeys'
import c from 'chalk'

const WORKSPACE_DIR = '/workspace'
const TEMPLATES_DIR = new URL('./templates', import.meta.url).pathname

// ============================================================================
// Types
// ============================================================================

type EnvironmentType = 'local' | 'dev' | 'production'

type EnvConfig = {
    // General
    developerName: string
    orgName: string
    environment: EnvironmentType
    domainName: string
    certificateEmail: string

    // Database
    useLocalDynamoDB: boolean
    dynamodbEndpoint: string

    // Authentication
    useLocalAuth0Mock: boolean
    auth0Domain: string
    auth0ClientId: string
    auth0Audience: string

    // NATS (auto-generated)
    natsAuthNkeySeed: string
    natsAuthNkeyPublic: string
    natsAuthXkeySeed: string
    natsAuthXkeyPublic: string
    natsLlmServiceNkeySeed: string
    natsLlmServiceNkeyPublic: string
    natsNexNodeNkeySeed: string
    natsNexNodeNkeyPublic: string
    natsSysUserPassword: string
    natsRegularUserPassword: string

    // AWS SSO (optional)
    configureAwsSso: boolean
    awsSsoSessionName: string
    awsSsoStartUrl: string
    awsRegion: string
    awsProfileName: string
    awsAccountId: string
    awsRoleName: string

    // AWS Deployment (optional)
    configureAwsDeployment: boolean
    hostedZoneDnsRoleArn: string
    hostedZoneName: string
    awsRoute53ParentHostedZoneId: string

    // CloudWatch Logging
    cloudwatchLogRetentionDays: number
    cloudwatchContainerInsightsEnabled: boolean

    // API Keys
    openaiApiKey: string
    anthropicApiKey: string
    // When true, anthropicApiKey is ignored and inference goes through AWS Bedrock.
    anthropicUseAwsBedrockInference: boolean
    googleApiKey: string
    // Veo person-generation policy profile for the deployment's region. `standard`
    // is the least restrictive profile Google accepts and is the default.
    googleVeoPersonGenerationProfile: 'standard' | 'restricted'
    stableDiffusionApiKey: string
    // When true, stableDiffusionApiKey is ignored and inference goes through AWS Bedrock.
    stabilityUseAwsBedrockInference: boolean
    arkApiKey: string
    stripePublicKey: string
}

type CliArgs = {
    nonInteractive: boolean
    name?: string
    env?: EnvironmentType
    help: boolean
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const parseCliArgs = (): CliArgs => {
    const args = process.argv.slice(2)
    const result: CliArgs = {
        nonInteractive: false,
        help: false,
    }

    for (const arg of args) {
        if (
            arg === '--help'
            || arg === '-h'
        )
            result.help = true
        else if (arg === '--non-interactive')
            result.nonInteractive = true
        else if (arg.startsWith('--name='))
            result.name = arg.split('=')[1]
        else if (arg.startsWith('--env=')) {
            const env = arg.split('=')[1]

            if (
                env === 'local'
                || env === 'dev'
                || env === 'production'
            )
                result.env = env
        }
    }

    return result
}

const printHelp = (): void => {
    debugLog(
        `
            ${c.bold(
                c.cyan('Lixpi Environment Setup'),
            )}

            ${c.bold('Usage:')}
            ${c.dim('# Interactive mode')}
            docker run -it --rm -v "$(pwd):/workspace" lixpi/setup

            ${c.dim('# Non-interactive mode (CI/automation)')}
            docker run --rm -v "$(pwd):/workspace" lixpi/setup --non-interactive --name=<name> --env=<env>

            ${c.bold('Options:')}
            -h, --help              Show this help message
            --non-interactive       Run without prompts (requires --name and --env)
            --name=<name>           Developer name (e.g., "kitty")
            --env=<environment>     Environment type: local, dev, production

            ${c.bold('Examples:')}
            docker run -it --rm -v "$(pwd):/workspace" lixpi/setup
            docker run --rm -v "$(pwd):/workspace" lixpi/setup --non-interactive --name=kitty --env=local

            ${c.bold('Windows CMD:')}
            docker run -it --rm -v "%cd%:/workspace" lixpi/setup

            ${c.bold('Windows PowerShell:')}
            docker run -it --rm -v "\${PWD}:/workspace" lixpi/setup

            ${c.bold('Output:')}
            Creates .env.<name>-<env> file in the project root
            Optionally creates .aws/config file
            `,
    )
}

// ============================================================================
// Key Generation
// ============================================================================

const generateNatsKeys = (): {
    authNkey: {
        seed: string
        public: string
    }
    authXkey: {
        seed: string
        public: string
    }
    llmServiceNkey: {
        seed: string
        public: string
    }
    nexNodeNkey: {
        seed: string
        public: string
    }
} => {
    // createAccount() for NATS_AUTH_NKEY_* (seeds start with SA)
    const accountKey = createAccount()
    const authNkey = {
        seed: new TextDecoder().decode(
            accountKey.getSeed(),
        ),
        public: accountKey.getPublicKey(),
    }
    accountKey.clear()

    // createCurve() for NATS_AUTH_XKEY_* (seeds start with SX)
    const curveKey = createCurve()
    const authXkey = {
        seed: new TextDecoder().decode(
            curveKey.getSeed(),
        ),
        public: curveKey.getPublicKey(),
    }
    curveKey.clear()

    // createUser() for NATS_LLM_SERVICE_NKEY_* (seeds start with SU)
    const userKey = createUser()
    const llmServiceNkey = {
        seed: new TextDecoder().decode(
            userKey.getSeed(),
        ),
        public: userKey.getPublicKey(),
    }
    userKey.clear()

    // createUser() for NATS_NEX_NODE_NKEY_* (seeds start with SU) — the NEX
    // execution-engine node connects to the NEX account with this user nkey.
    const nexNodeKey = createUser()
    const nexNodeNkey = {
        seed: new TextDecoder().decode(
            nexNodeKey.getSeed(),
        ),
        public: nexNodeKey.getPublicKey(),
    }
    nexNodeKey.clear()

    return {
        authNkey,
        authXkey,
        llmServiceNkey,
        nexNodeNkey,
    }
}

const generateSecurePassword = (length: number = 32): string => {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const bytes = crypto.randomBytes(length)
    let password = ''

    for (let i = 0; i < length; i++) {
        password += charset[bytes[i] % charset.length]
    }

    return password
}

// ============================================================================
// Prompts
// ============================================================================

const runInteractivePrompts = async (): Promise<EnvConfig | null> => {
    prompts.intro(
        c.bgCyan(
            c.black(' Lixpi Environment Setup '),
        ),
    )

    // -------------------------------------------------------------------------
    // General Section
    // -------------------------------------------------------------------------
    prompts.log.step(
        c.bold(
            c.blue('General Configuration'),
        ),
    )

    const developerName = await prompts.text({
        message: 'Developer name (used in stage name, e.g., "kitty")',
        placeholder: 'kitty',
        validate: value => {
            if (!value)
                return 'Developer name is required'

            if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(value))
                return 'Name must start with a letter and contain only letters, numbers, and hyphens'
        },
    })

    if (prompts.isCancel(developerName)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    const orgName = await prompts.text({
        message: 'Organization name (used for Pulumi)',
        placeholder: 'Lixpi',
        defaultValue: 'Lixpi',
    })

    if (prompts.isCancel(orgName)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    const environment = await prompts.select({
        message: 'Environment type',
        options: [
            {
                value: 'local',
                label: 'Local',
                hint: 'Local development with Docker',
            },
            {
                value: 'dev',
                label: 'Dev',
                hint: 'Development AWS deployment',
            },
            {
                value: 'production',
                label: 'Production',
                hint: 'Production AWS deployment',
            },
        ],
    })

    if (prompts.isCancel(environment)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    const isLocal = environment === 'local'
    const stageName = `${developerName}-${environment}`

    prompts.log.info(`Stage: ${c.cyan(stageName)}`)

    let domainName = ''
    let certificateEmail = ''

    if (!isLocal) {
        const domain = await prompts.text({
            message: 'Domain name',
            placeholder: 'example.com',
        })

        if (prompts.isCancel(domain)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        domainName = domain as string

        prompts.log.info(`Domain: ${c.cyan(domainName)}`)

        const email = await prompts.text({
            message: 'Email for SSL certificate validation',
            placeholder: `${developerName}@mail.com`,
            defaultValue: `${developerName}@mail.com`,
        })

        if (prompts.isCancel(email)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        certificateEmail = email as string
    }

    // -------------------------------------------------------------------------
    // Database Section
    // -------------------------------------------------------------------------
    prompts.log.step(
        c.bold(
            c.blue('Database Configuration'),
        ),
    )

    const useLocalDynamoDB = await prompts.confirm({
        message: 'Use local DynamoDB (Docker)?',
        initialValue: environment === 'local',
    })

    if (prompts.isCancel(useLocalDynamoDB)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    let dynamodbEndpoint = 'http://lixpi-dynamodb:8000'

    if (!useLocalDynamoDB) {
        const endpoint = await prompts.text({
            message: 'DynamoDB endpoint URL',
            placeholder: 'https://dynamodb.us-east-1.amazonaws.com',
        })

        if (prompts.isCancel(endpoint)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        dynamodbEndpoint = endpoint as string
    }

    // -------------------------------------------------------------------------
    // Authentication Section
    // -------------------------------------------------------------------------
    prompts.log.step(
        c.bold(
            c.blue('Authentication Configuration'),
        ),
    )

    const useLocalAuth0Mock = await prompts.confirm({
        message: 'Use LocalAuth0 mock (for local development)?',
        initialValue: environment === 'local',
    })

    if (prompts.isCancel(useLocalAuth0Mock)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    let auth0Domain = ''
    let auth0ClientId = ''
    let auth0Audience = 'http://localhost:3005'

    if (!useLocalAuth0Mock) {
        const domain = await prompts.text({
            message: 'Auth0 domain (e.g., https://your-tenant.us.auth0.com)',
            placeholder: 'https://your-tenant.us.auth0.com',
        })

        if (prompts.isCancel(domain)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        auth0Domain = domain as string

        const clientId = await prompts.text({
            message: 'Auth0 Client ID',
            placeholder: 'your-client-id',
        })

        if (prompts.isCancel(clientId)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        auth0ClientId = clientId as string

        const audience = await prompts.text({
            message: 'Auth0 API Identifier (audience)',
            placeholder: 'https://api.your-domain.com',
        })

        if (prompts.isCancel(audience)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        auth0Audience = audience as string
    }

    // -------------------------------------------------------------------------
    // NATS Section (Auto-generated)
    // -------------------------------------------------------------------------
    prompts.log.step(
        c.bold(
            c.blue('NATS Configuration'),
        ),
    )

    const spinner = prompts.spinner()
    spinner.start('Generating NATS keys and passwords...')

    const natsKeys = generateNatsKeys()
    const natsSysUserPassword = generateSecurePassword(28)
    const natsRegularUserPassword = generateSecurePassword(28)

    spinner.stop('NATS keys and passwords generated')

    prompts.log.success(`Auth NKey public: ${c.dim(natsKeys.authNkey.public)}`)
    prompts.log.success(`Auth XKey public: ${c.dim(natsKeys.authXkey.public)}`)
    prompts.log.success(`LLM Service NKey public: ${c.dim(natsKeys.llmServiceNkey.public)}`)
    prompts.log.success(`NEX Node NKey public: ${c.dim(natsKeys.nexNodeNkey.public)}`)

    // -------------------------------------------------------------------------
    // AWS SSO Section
    // -------------------------------------------------------------------------
    prompts.log.step(
        c.bold(
            c.blue('AWS SSO Configuration'),
        ),
    )

    const configureAwsSso = await prompts.confirm({
        message: 'Configure AWS SSO profile?',
        initialValue: false,
    })

    if (prompts.isCancel(configureAwsSso)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    let awsSsoSessionName = ''
    let awsSsoStartUrl = ''
    let awsRegion = 'us-east-1'
    let awsProfileName = ''
    let awsAccountId = ''
    let awsRoleName = 'AdministratorAccess'

    if (configureAwsSso) {
        const ssoSessionName = await prompts.text({
            message: 'AWS SSO session name',
            placeholder: 'my-sso',
        })

        if (prompts.isCancel(ssoSessionName)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        awsSsoSessionName = ssoSessionName as string

        const ssoStartUrl = await prompts.text({
            message: 'AWS SSO start URL',
            placeholder: 'https://my-org.awsapps.com/start',
        })

        if (prompts.isCancel(ssoStartUrl)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        awsSsoStartUrl = ssoStartUrl as string

        const region = await prompts.text({
            message: 'AWS region',
            placeholder: 'us-east-1',
            defaultValue: 'us-east-1',
        })

        if (prompts.isCancel(region)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        awsRegion = region as string

        const profileName = await prompts.text({
            message: 'AWS profile name',
            placeholder: `${developerName}-dev`,
        })

        if (prompts.isCancel(profileName)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        awsProfileName = profileName as string

        const accountId = await prompts.text({
            message: 'AWS Account ID',
            placeholder: '',
            validate: value => {
                if (!value)
                    return 'Account ID is required'

                if (!/^\d{12}$/.test(value))
                    return 'Account ID must be 12 digits'
            },
        })

        if (prompts.isCancel(accountId)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        awsAccountId = accountId as string

        const roleName = await prompts.text({
            message: 'AWS IAM Role name',
            placeholder: 'AdministratorAccess',
            defaultValue: 'AdministratorAccess',
        })

        if (prompts.isCancel(roleName)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        awsRoleName = roleName as string
    }

    // -------------------------------------------------------------------------
    // AWS Deployment Section
    // -------------------------------------------------------------------------
    prompts.log.step(
        c.bold(
            c.blue('AWS Deployment Configuration'),
        ),
    )

    const configureAwsDeployment = await prompts.confirm({
        message: 'Configure AWS deployment settings?',
        initialValue: false,
    })

    if (prompts.isCancel(configureAwsDeployment)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    let hostedZoneDnsRoleArn = ''
    let hostedZoneName = ''
    let awsRoute53ParentHostedZoneId = ''
    let cloudwatchLogRetentionDays = 7
    let cloudwatchContainerInsightsEnabled = false

    if (configureAwsDeployment) {
        const hostedZoneDns = await prompts.text({
            message: 'Hosted Zone DNS Role ARN (optional)',
            placeholder: 'arn:aws:iam::<account-id>:role/<role-name>',
        })

        if (prompts.isCancel(hostedZoneDns)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        hostedZoneDnsRoleArn = (hostedZoneDns as string) || ''

        const hostedZone = await prompts.text({
            message: 'Hosted Zone name (optional)',
            placeholder: 'example.com',
        })

        if (prompts.isCancel(hostedZone)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        hostedZoneName = (hostedZone as string) || ''

        const useParentHostedZone = await prompts.confirm({
            message: 'Use parent hosted zone for DNS delegation?',
            initialValue: false,
        })

        if (prompts.isCancel(useParentHostedZone)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        if (useParentHostedZone) {
            const parentHostedZone = await prompts.text({
                message: 'Parent Hosted Zone ID',
                placeholder: '',
                validate: value => {
                    if (!value)
                        return 'Parent Hosted Zone ID is required'
                },
            })

            if (prompts.isCancel(parentHostedZone)) {
                prompts.cancel('Setup cancelled')

                return null
            }

            awsRoute53ParentHostedZoneId = parentHostedZone as string
        }

        const logRetentionDays = await prompts.select({
            message: 'CloudWatch log retention period',
            options: [
                {
                    value: 1,
                    label: '1 day',
                },
                {
                    value: 3,
                    label: '3 days',
                },
                {
                    value: 5,
                    label: '5 days',
                },
                {
                    value: 7,
                    label: '7 days',
                    hint: 'Recommended for development',
                },
                {
                    value: 14,
                    label: '14 days',
                },
                {
                    value: 30,
                    label: '30 days',
                    hint: 'Recommended for staging',
                },
                {
                    value: 60,
                    label: '60 days',
                },
                {
                    value: 90,
                    label: '90 days',
                    hint: 'Recommended for production',
                },
                {
                    value: 120,
                    label: '120 days',
                },
                {
                    value: 150,
                    label: '150 days',
                },
                {
                    value: 180,
                    label: '180 days (6 months)',
                },
                {
                    value: 365,
                    label: '365 days (1 year)',
                },
                {
                    value: 400,
                    label: '400 days',
                },
                {
                    value: 545,
                    label: '545 days (18 months)',
                },
                {
                    value: 731,
                    label: '731 days (2 years)',
                },
                {
                    value: 1096,
                    label: '1096 days (3 years)',
                },
                {
                    value: 1827,
                    label: '1827 days (5 years)',
                },
                {
                    value: 2192,
                    label: '2192 days (6 years)',
                },
                {
                    value: 2557,
                    label: '2557 days (7 years)',
                },
                {
                    value: 2922,
                    label: '2922 days (8 years)',
                },
                {
                    value: 3288,
                    label: '3288 days (9 years)',
                },
                {
                    value: 3653,
                    label: '3653 days (10 years)',
                },
            ],
            initialValue: isLocal ? 7 : 30,
        })

        if (prompts.isCancel(logRetentionDays)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        cloudwatchLogRetentionDays = logRetentionDays as number

        const containerInsightsEnabled = await prompts.confirm({
            message: 'Enable ECS Container Insights?',
            initialValue: false,
        })

        if (prompts.isCancel(containerInsightsEnabled)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        cloudwatchContainerInsightsEnabled = containerInsightsEnabled as boolean
    }

    // -------------------------------------------------------------------------
    // API Keys Section
    // -------------------------------------------------------------------------
    prompts.log.step(
        c.bold(
            c.blue('API Keys'),
        ),
    )

    prompts.log.info(
        c.dim('Leave empty to configure later'),
    )

    const openaiApiKey = await prompts.text({
        message: 'OpenAI API Key',
        placeholder: 'sk-...',
    })

    if (prompts.isCancel(openaiApiKey)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    const anthropicUseAwsBedrockInference = await prompts.confirm({
        message: 'Run Anthropic inference through AWS Bedrock (uses your AWS SSO profile instead of an API key)?',
        initialValue: false,
    })

    if (prompts.isCancel(anthropicUseAwsBedrockInference)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    let anthropicApiKey: string | symbol = ''

    if (!anthropicUseAwsBedrockInference) {
        anthropicApiKey = await prompts.text({
            message: 'Anthropic API Key',
            placeholder: 'sk-ant-...',
        })

        if (prompts.isCancel(anthropicApiKey)) {
            prompts.cancel('Setup cancelled')

            return null
        }
    }

    const googleApiKey = await prompts.text({
        message: 'Google API Key',
        placeholder: 'AIza...',
    })

    if (prompts.isCancel(googleApiKey)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    const googleVeoPersonGenerationProfile = await prompts.select({
        message: 'Veo person-generation profile for your Google region',
        options: [
            {
                value: 'standard',
                label: 'Standard',
                hint: 'Least restrictive Google allows: allow_all for text and extension, allow_adult for frame-conditioned',
            },
            {
                value: 'restricted',
                label: 'Restricted',
                hint: 'For regions where Google only permits allow_adult',
            },
        ],
        initialValue: 'standard',
    })

    if (prompts.isCancel(googleVeoPersonGenerationProfile)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    const stabilityUseAwsBedrockInference = await prompts.confirm({
        message: 'Run Stability image generation through AWS Bedrock (uses your AWS SSO profile instead of an API key)?',
        initialValue: false,
    })

    if (prompts.isCancel(stabilityUseAwsBedrockInference)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    let stableDiffusionApiKey: string | symbol = ''

    if (!stabilityUseAwsBedrockInference) {
        stableDiffusionApiKey = await prompts.text({
            message: 'Stable Diffusion API Key',
            placeholder: 'sk-...',
        })

        if (prompts.isCancel(stableDiffusionApiKey)) {
            prompts.cancel('Setup cancelled')

            return null
        }
    }

    const arkApiKey = await prompts.text({
        message: 'BytePlus ModelArk API Key (ARK_API_KEY — for Seedance video; leave blank to skip)',
        placeholder: '...',
    })

    if (prompts.isCancel(arkApiKey)) {
        prompts.cancel('Setup cancelled')

        return null
    }

    // Only ask for Stripe key if not using LocalAuth0 mock (real Auth0 = real payments)
    let stripePublicKey = ''

    if (!useLocalAuth0Mock) {
        const stripeKey = await prompts.text({
            message: 'Stripe Public Key',
            placeholder: 'pk_test_...',
        })

        if (prompts.isCancel(stripeKey)) {
            prompts.cancel('Setup cancelled')

            return null
        }

        stripePublicKey = stripeKey as string
    }

    return {
        developerName: developerName as string,
        orgName: orgName as string,
        environment: environment as EnvironmentType,
        domainName,
        certificateEmail: certificateEmail as string,
        useLocalDynamoDB: useLocalDynamoDB as boolean,
        dynamodbEndpoint,
        useLocalAuth0Mock: useLocalAuth0Mock as boolean,
        auth0Domain,
        auth0ClientId,
        auth0Audience,
        natsAuthNkeySeed: natsKeys.authNkey.seed,
        natsAuthNkeyPublic: natsKeys.authNkey.public,
        natsAuthXkeySeed: natsKeys.authXkey.seed,
        natsAuthXkeyPublic: natsKeys.authXkey.public,
        natsLlmServiceNkeySeed: natsKeys.llmServiceNkey.seed,
        natsLlmServiceNkeyPublic: natsKeys.llmServiceNkey.public,
        natsNexNodeNkeySeed: natsKeys.nexNodeNkey.seed,
        natsNexNodeNkeyPublic: natsKeys.nexNodeNkey.public,
        natsSysUserPassword,
        natsRegularUserPassword,
        configureAwsSso: configureAwsSso as boolean,
        awsSsoSessionName,
        awsSsoStartUrl,
        awsRegion,
        awsProfileName,
        awsAccountId,
        awsRoleName,
        configureAwsDeployment: configureAwsDeployment as boolean,
        hostedZoneDnsRoleArn,
        hostedZoneName,
        awsRoute53ParentHostedZoneId,
        cloudwatchLogRetentionDays,
        cloudwatchContainerInsightsEnabled,
        openaiApiKey: (openaiApiKey as string) || '',
        anthropicApiKey: (anthropicApiKey as string) || '',
        anthropicUseAwsBedrockInference: anthropicUseAwsBedrockInference as boolean,
        googleApiKey: (googleApiKey as string) || '',
        googleVeoPersonGenerationProfile: googleVeoPersonGenerationProfile as 'standard' | 'restricted',
        stableDiffusionApiKey: (stableDiffusionApiKey as string) || '',
        stabilityUseAwsBedrockInference: stabilityUseAwsBedrockInference as boolean,
        arkApiKey: (arkApiKey as string) || '',
        stripePublicKey: (stripePublicKey as string) || '',
    }
}

// ============================================================================
// File Generation
// ============================================================================

const generateEnvFileContent = (config: EnvConfig): string => {
    const stageName = `${config.developerName}-${config.environment}`
    const isLocal = config.environment === 'local'

    const template = fs.readFileSync(
        path.join(TEMPLATES_DIR, 'env.template'),
        'utf-8',
    )

    const replacements: Record<string, string> = {
        '{{DOMAIN_NAME}}': config.domainName,
        '{{CERTIFICATE_EMAIL}}': config.certificateEmail,
        '{{STAGE}}': stageName.charAt(0).toUpperCase() + stageName.slice(1),
        '{{ORG_NAME}}': config.orgName,
        '{{ENVIRONMENT}}': config.environment,
        '{{STATE_STORAGE_URL}}': isLocal ? 'file:///var/opt/lixpi/.pulumi-local-state' : `s3://${config.developerName}-pulumi-${stageName}`,
        '{{AWS_PROFILE}}': isLocal ? '' : (config.awsProfileName || `${config.developerName}-dev`),
        '{{DYNAMODB_ENDPOINT}}': config.dynamodbEndpoint,
        '{{HOSTED_ZONE_DNS_ROLE_ARN}}': config.hostedZoneDnsRoleArn,
        '{{HOSTED_ZONE_NAME}}': config.hostedZoneName,
        '{{AWS_ROUTE53_PARENT_HOSTED_ZONE_ID}}': config.awsRoute53ParentHostedZoneId,
        '{{NATS_DEBUG_MODE}}': isLocal ? 'true' : 'false',
        '{{NATS_SYS_USER_PASSWORD}}': config.natsSysUserPassword,
        '{{NATS_REGULAR_USER_PASSWORD}}': config.natsRegularUserPassword,
        '{{NATS_AUTH_NKEY_SEED}}': config.natsAuthNkeySeed,
        '{{NATS_AUTH_NKEY_PUBLIC}}': config.natsAuthNkeyPublic,
        '{{NATS_AUTH_XKEY_SEED}}': config.natsAuthXkeySeed,
        '{{NATS_AUTH_XKEY_PUBLIC}}': config.natsAuthXkeyPublic,
        '{{NATS_LLM_SERVICE_NKEY_SEED}}': config.natsLlmServiceNkeySeed,
        '{{NATS_LLM_SERVICE_NKEY_PUBLIC}}': config.natsLlmServiceNkeyPublic,
        '{{NATS_NEX_NODE_NKEY_SEED}}': config.natsNexNodeNkeySeed,
        '{{NATS_NEX_NODE_NKEY_PUBLIC}}': config.natsNexNodeNkeyPublic,
        '{{NATS_CORS_COMMENT}}': isLocal ? ' (local development - allow all origins)' : '',
        '{{NATS_ALLOWED_ORIGINS}}': isLocal
            ? '[]'
            : `["https://${config.domainName}","https://user-portal.${config.domainName}"]`,
        '{{ORIGIN_HOST_URL}}': isLocal ? 'http://localhost:3001' : `https://${config.domainName}`,
        '{{API_HOST_URL}}': isLocal ? 'http://localhost:3005' : `https://api.${config.domainName}`,
        '{{AUTH0_DOMAIN}}': config.auth0Domain,
        '{{AUTH0_AUDIENCE}}': config.auth0Audience,
        '{{MOCK_AUTH0}}': String(config.useLocalAuth0Mock),
        '{{MOCK_AUTH0_DOMAIN}}': config.useLocalAuth0Mock ? 'localhost:3000' : '',
        '{{MOCK_AUTH0_JWKS_URI}}': config.useLocalAuth0Mock ? 'http://lixpi-localauth0:3000/.well-known/jwks.json' : '',
        '{{SAVE_LLM_RESPONSES_TO_DEBUG_DIR}}': String(isLocal),
        '{{METRICS_ENABLED}}': 'false',
        '{{OPENAI_API_KEY}}': config.openaiApiKey,
        '{{ANTHROPIC_API_KEY}}': config.anthropicApiKey,
        '{{ANTHROPIC_USE_AWS_BEDROCK_INFERENCE}}': String(config.anthropicUseAwsBedrockInference),
        '{{GOOGLE_API_KEY}}': config.googleApiKey,
        '{{GOOGLE_VEO_PERSON_GENERATION_PROFILE}}': config.googleVeoPersonGenerationProfile,
        '{{STABLE_DIFFUSION_API_KEY}}': config.stableDiffusionApiKey,
        '{{STABILITY_USE_AWS_BEDROCK_INFERENCE}}': String(config.stabilityUseAwsBedrockInference),
        '{{ARK_API_KEY}}': config.arkApiKey,
        '{{VITE_MOCK_AUTH}}': String(config.useLocalAuth0Mock),
        '{{VITE_MOCK_AUTH0_DOMAIN}}': config.useLocalAuth0Mock ? 'localhost:3000' : '',
        '{{VITE_API_URL}}': isLocal ? 'http://localhost:3005' : `https://api.${config.domainName}`,
        '{{VITE_AUTH0_LOGIN_URL}}': isLocal ? 'http://localhost:3001/login' : `https://${config.domainName}/login`,
        '{{VITE_AUTH0_DOMAIN}}': config.auth0Domain.replace('https://', ''),
        '{{VITE_AUTH0_CLIENT_ID}}': config.auth0ClientId,
        '{{VITE_AUTH0_AUDIENCE}}': config.auth0Audience,
        '{{VITE_AUTH0_REDIRECT_URI}}': isLocal ? 'http://localhost:3001' : `https://${config.domainName}`,
        '{{VITE_USER_PORTAL_URL}}': isLocal ? 'http://localhost:3002' : `https://user-portal.${config.domainName}`,
        '{{VITE_STRIPE_PUBLIC_KEY}}': config.stripePublicKey,
        '{{VITE_NATS_SERVER}}': isLocal ? 'wss://localhost:9222' : `wss://nats.${config.domainName}`,
        '{{CLOUDWATCH_LOG_RETENTION_DAYS}}': String(config.cloudwatchLogRetentionDays),
        '{{CLOUDWATCH_CONTAINER_INSIGHTS_ENABLED}}': String(config.cloudwatchContainerInsightsEnabled),
    }

    let result = template

    for (const [placeholder, value] of Object.entries(replacements)) {
        result = result.replaceAll(placeholder, value)
    }

    return result
}

const generateAwsConfigContent = (config: EnvConfig): string => {
    const template = fs.readFileSync(
        path.join(TEMPLATES_DIR, 'aws-config.template'),
        'utf-8',
    )

    const replacements: Record<string, string> = {
        '{{SSO_SESSION_NAME}}': config.awsSsoSessionName,
        '{{SSO_START_URL}}': config.awsSsoStartUrl,
        '{{AWS_REGION}}': config.awsRegion,
        '{{AWS_PROFILE_NAME}}': config.awsProfileName,
        '{{AWS_ACCOUNT_ID}}': config.awsAccountId,
        '{{AWS_ROLE_NAME}}': config.awsRoleName,
    }

    let result = template

    for (const [placeholder, value] of Object.entries(replacements)) {
        result = result.replaceAll(placeholder, value)
    }

    return result
}

// ============================================================================
// File Writing
// ============================================================================

const writeFiles = async (config: EnvConfig): Promise<void> => {
    const stageName = `${config.developerName}-${config.environment}`
    const envFilePath = path.join(WORKSPACE_DIR, `.env.${stageName}`)
    const awsConfigPath = path.join(
        WORKSPACE_DIR,
        '.aws',
        'config',
    )

    // Check if .env file exists
    if (fs.existsSync(envFilePath)) {
        const overwrite = await prompts.confirm({
            message: `File ${c.yellow(`.env.${stageName}`)} already exists. Overwrite?`,
            initialValue: false,
        })

        if (
            prompts.isCancel(overwrite)
            || !overwrite
        )
            prompts.log.warn('Skipping .env file generation')
        else {
            fs.writeFileSync(
                envFilePath,
                generateEnvFileContent(config),
            )
            prompts.log.success(`Created ${c.green(`.env.${stageName}`)}`)
        }
    } else {
        fs.writeFileSync(
            envFilePath,
            generateEnvFileContent(config),
        )
        prompts.log.success(`Created ${c.green(`.env.${stageName}`)}`)
    }

    // Write AWS config if configured
    if (config.configureAwsSso) {
        const awsDir = path.dirname(awsConfigPath)

        if (!fs.existsSync(awsDir))
            fs.mkdirSync(awsDir, { recursive: true })

        if (fs.existsSync(awsConfigPath)) {
            const overwrite = await prompts.confirm({
                message: `File ${c.yellow('.aws/config')} already exists. Overwrite?`,
                initialValue: false,
            })

            if (
                prompts.isCancel(overwrite)
                || !overwrite
            )
                prompts.log.warn('Skipping .aws/config file generation')
            else {
                fs.writeFileSync(
                    awsConfigPath,
                    generateAwsConfigContent(config),
                )
                prompts.log.success(`Created ${c.green('.aws/config')}`)
            }
        } else {
            fs.writeFileSync(
                awsConfigPath,
                generateAwsConfigContent(config),
            )
            prompts.log.success(`Created ${c.green('.aws/config')}`)
        }
    }
}

// ============================================================================
// Main
// ============================================================================

const main = async (): Promise<void> => {
    const args = parseCliArgs()

    if (args.help) {
        printHelp()
        process.exit(0)
    }

    if (args.nonInteractive) {
        // Non-interactive mode
        if (
            !args.name
            || !args.env
        ) {
            debugError(
                c.red('Error: --name and --env are required in non-interactive mode'),
            )
            debugError('Run with --help for usage information')
            process.exit(1)
        }

        const natsKeys = generateNatsKeys()

        const isLocalEnv = args.env === 'local'

        const config: EnvConfig = {
            developerName: args.name,
            orgName: 'Lixpi',
            environment: args.env,
            domainName: '',
            certificateEmail: isLocalEnv ? '' : `${args.name}@mail.com`,
            useLocalDynamoDB: args.env === 'local',
            dynamodbEndpoint: args.env === 'local' ? 'http://lixpi-dynamodb:8000' : '',
            useLocalAuth0Mock: args.env === 'local',
            auth0Domain: '',
            auth0ClientId: '',
            auth0Audience: 'http://localhost:3005',
            natsAuthNkeySeed: natsKeys.authNkey.seed,
            natsAuthNkeyPublic: natsKeys.authNkey.public,
            natsAuthXkeySeed: natsKeys.authXkey.seed,
            natsAuthXkeyPublic: natsKeys.authXkey.public,
            natsLlmServiceNkeySeed: natsKeys.llmServiceNkey.seed,
            natsLlmServiceNkeyPublic: natsKeys.llmServiceNkey.public,
            natsNexNodeNkeySeed: natsKeys.nexNodeNkey.seed,
            natsNexNodeNkeyPublic: natsKeys.nexNodeNkey.public,
            natsSysUserPassword: generateSecurePassword(28),
            natsRegularUserPassword: generateSecurePassword(28),
            configureAwsSso: false,
            awsSsoSessionName: '',
            awsSsoStartUrl: '',
            awsRegion: 'us-east-1',
            awsProfileName: '',
            awsAccountId: '',
            awsRoleName: '',
            configureAwsDeployment: false,
            hostedZoneDnsRoleArn: '',
            hostedZoneName: '',
            awsRoute53ParentHostedZoneId: '',
            cloudwatchLogRetentionDays: 7,
            cloudwatchContainerInsightsEnabled: false,
            openaiApiKey: '',
            anthropicApiKey: '',
            googleApiKey: '',
            googleVeoPersonGenerationProfile: 'standard',
            stableDiffusionApiKey: '',
            arkApiKey: '',
            stripePublicKey: '',
        }

        const stageName = `${config.developerName}-${config.environment}`
        const envFilePath = path.join(WORKSPACE_DIR, `.env.${stageName}`)

        fs.writeFileSync(
            envFilePath,
            generateEnvFileContent(config),
        )
        debugLog(
            c.green(`✓ Created .env.${stageName}`),
        )
        process.exit(0)
    }

    // Interactive mode
    const config = await runInteractivePrompts()

    if (!config)
        process.exit(1)

    // Summary
    prompts.log.step(
        c.bold(
            c.blue('Summary'),
        ),
    )

    const stageName = `${config.developerName}-${config.environment}`
    const isLocal = config.environment === 'local'
    debugLog()
    debugLog(`  ${c.dim('Stage:')}          ${c.cyan(stageName)}`)

    if (!isLocal)
        debugLog(`  ${c.dim('Domain:')}         ${c.cyan(config.domainName)}`)

    debugLog(`  ${c.dim('Environment:')}    ${c.cyan(config.environment)}`)
    debugLog(`  ${c.dim('Local DynamoDB:')} ${config.useLocalDynamoDB ? c.green('Yes') : c.yellow('No')}`)
    debugLog(`  ${c.dim('LocalAuth0:')}     ${config.useLocalAuth0Mock ? c.green('Yes') : c.yellow('No')}`)
    debugLog(`  ${c.dim('AWS SSO:')}        ${config.configureAwsSso ? c.green('Yes') : c.yellow('No')}`)
    debugLog(`  ${c.dim('AWS Deployment:')} ${config.configureAwsDeployment ? c.green('Yes') : c.yellow('No')}`)
    debugLog(`  ${c.dim('Log Retention:')} ${c.cyan(`${config.cloudwatchLogRetentionDays} days`)}`)
    debugLog(`  ${c.dim('Container Insights:')} ${config.cloudwatchContainerInsightsEnabled ? c.yellow('Enabled') : c.green('Disabled')}`)
    debugLog()

    const confirmed = await prompts.confirm({
        message: 'Create configuration files?',
        initialValue: true,
    })

    if (
        prompts.isCancel(confirmed)
        || !confirmed
    ) {
        prompts.cancel('Setup cancelled')
        process.exit(1)
    }

    await writeFiles(config)

    prompts.outro(
        c.green('Setup complete! 🎉'),
    )

    debugLog()
    debugLog(
        c.bold('Next steps:'),
    )
    debugLog(`  1. Run ${c.cyan(`docker compose --env-file .env.${stageName} up`)}`)

    if (config.configureAwsSso)
        debugLog(`  2. Run ${c.cyan('pnpm run aws-login')} to authenticate with AWS`)

    debugLog()
}

try {
    await main()
} catch (error) {
    debugError(
        c.red('Error:'),
        error.message,
    )
    process.exit(1)
}
