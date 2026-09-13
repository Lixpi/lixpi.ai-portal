import * as process from 'process'
import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { createSsmParameters } from './resources/SSM-parameters.ts'
import { createDynamoDbTables } from './resources/db/DynamoDB-tables.ts'
import { createNetworkInfrastructure } from './resources/network.ts'
import { createEcsCluster } from './resources/ECS-cluster.ts'
import { createEcsEc2Cluster } from './resources/ECS-EC2-cluster.ts'
import { createNatsClusterService } from './resources/NATS-cluster/NATS-cluster.ts'
import { createMainApiService } from './resources/main-api-service.ts'
import { createNexNodeService } from './resources/nex-node/nex-node.ts'
import { createAiModelRegistryService } from './resources/ai-model-registry/ai-model-registry-service.ts'
import { createCertificate } from './resources//certificate.ts'
import {
    createDnsRecords,
    createDelegationRecord,
    getOrCreateHostedZone,
} from './resources/dns-records.ts'
import { createWebUI } from './resources/web-ui.ts'
import { createWebUIUserPortal } from './resources/web-ui-user-portal.ts'
import { formatStageResourceName } from '@lixpi/constants'
import {
    createLambdaCertificateManager,
    createLambdaCertificateHelper,
} from './resources/certificate-manager/index.ts'

const {
    DOMAIN_NAME,
    HOSTED_ZONE_NAME,
    AWS_ROUTE53_HOSTED_ZONE_ID, // Child or root hosted zone (if exists)
    AWS_ROUTE53_PARENT_HOSTED_ZONE_ID, // Optional parent zone for delegation
    OPENAI_API_KEY,
    ANTHROPIC_API_KEY,
    ANTHROPIC_USE_AWS_BEDROCK_INFERENCE,
    STAGE,
    ENVIRONMENT,
    NODE_OPTIONS,

    HOSTED_ZONE_DNS_ROLE_ARN,

    AWS_REGION,
    ORG_NAME,
    CERTIFICATE_VALIDATION_EMAIL,

    DYNAMODB_ENDPOINT,

    NATS_SERVERS,
    NATS_AUTH_ACCOUNT,
    NATS_SYS_USER_PASSWORD,
    NATS_REGULAR_USER_PASSWORD,
    NATS_NEX_NODE_NKEY_PUBLIC,
    NATS_NEX_NODE_NKEY_SEED,
    NATS_AI_MODEL_REGISTRY_NKEY_PUBLIC,
    NATS_AI_MODEL_REGISTRY_NKEY_SEED,
    NATS_AI_MODEL_REGISTRY_USER_ID,
    NATS_AUTH_NKEY_ISSUER_SEED,
    NATS_AUTH_NKEY_ISSUER_PUBLIC,
    NATS_AUTH_XKEY_ISSUER_SEED,
    NATS_AUTH_XKEY_ISSUER_PUBLIC,
    GOOGLE_API_KEY,
    GOOGLE_VEO_PERSON_GENERATION_PROFILE,
    STABLE_DIFFUSION_API_KEY,
    STABILITY_USE_AWS_BEDROCK_INFERENCE,
    ARK_API_KEY,
    BYTEPLUS_ARK_API_KEY,
    LLM_TIMEOUT_SECONDS,
    NATS_SAME_ORIGIN,
    NATS_ALLOWED_ORIGINS,
    NATS_DEBUG_MODE,
    NATS_TRACE_MODE,
    ORIGIN_HOST_URL,
    API_HOST_URL,
    AUTH0_DOMAIN,
    AUTH0_API_IDENTIFIER,
    SAVE_LLM_RESPONSES_TO_DEBUG_DIR,

    VITE_API_URL,
    VITE_AUTH0_LOGIN_URL,
    VITE_AUTH0_DOMAIN,
    VITE_AUTH0_CLIENT_ID,
    VITE_AUTH0_AUDIENCE,
    VITE_AUTH0_REDIRECT_URI,
    VITE_STRIPE_PUBLIC_KEY,
    VITE_NATS_SERVER,
} = process.env

const includeWebClientOrigins = (
    configuredOrigins: string | undefined,
    domainName: string,
): string => {
    const parsedOrigins = JSON.parse(configuredOrigins || '[]') as unknown

    if (
        !Array.isArray(parsedOrigins)
        || parsedOrigins.some(origin => typeof origin !== 'string')
    )
        throw new Error('NATS_ALLOWED_ORIGINS must be a JSON array of origin strings')

    return JSON.stringify([
        ...new Set([
            ...parsedOrigins,
            `https://${domainName}`,
            `https://user-portal.${domainName}`,
        ]),
    ])
}

export const createInfrastructure = async () => {
    // Decide whether to deploy full AWS infra or use local-only resources
    const DEPLOY_TO_AWS = process.env.ENVIRONMENT !== 'local'
    const USE_LOCAL_DYNAMODB = !DEPLOY_TO_AWS

    const dynamoDBtables = await createDynamoDbTables({
        ...(USE_LOCAL_DYNAMODB && {
            provider: new aws.Provider(
                'local-dynamodb',
                {
                    region: 'us-east-1' as aws.Region,
                    accessKey: 'test',
                    secretKey: 'test',
                    skipCredentialsValidation: true,
                    skipRequestingAccountId: true,
                    endpoints: [{ dynamodb: DYNAMODB_ENDPOINT! }],
                },
            ),
        }),
    })

    // Local mode: only create DynamoDB tables (in DynamoDB Local) and exit early
    if (!DEPLOY_TO_AWS)
        return { dynamoDBtables }

    // Everything below is for real AWS deployments only
    const ssmParameters = createSsmParameters()

    // Create network infrastructure including VPC, subnets, and security groups
    const networkInfrastructure = await createNetworkInfrastructure()

    // Configure provider to assume the role with Route53 permissions
    const dnsProvider = new aws.Provider(
        'dns-provider',
        {
            ...(HOSTED_ZONE_DNS_ROLE_ARN && {
                assumeRole: {
                    roleArn: HOSTED_ZONE_DNS_ROLE_ARN,
                    sessionName: 'PulumiDeployment',
                },
            }),
        },
    )

    // Hosted zone resolution strategy (idempotent & reuse-only):
    // 1. If explicit AWS_ROUTE53_HOSTED_ZONE_ID provided -> trust & reuse it (validate exists)
    // 2. Else try to find existing zone by name -> reuse
    // 3. Else create new one (and only then optionally delegate from parent)
    let hostedZoneId: pulumi.Output<string>
    let createdHostedZone: aws.route53.Zone | undefined
    let delegationRecord: aws.route53.Record | undefined

    if (AWS_ROUTE53_HOSTED_ZONE_ID) {
        const existing = await aws.route53.getZone({ name: DOMAIN_NAME! }).catch(e => {
            throw new Error(`Explicit AWS_ROUTE53_HOSTED_ZONE_ID provided but lookup by name failed for ${DOMAIN_NAME}: ${e}`)
        })
        hostedZoneId = pulumi.output(existing.zoneId)
    } else {
        const zoneResult = await getOrCreateHostedZone({
            orgName: ORG_NAME!,
            stage: STAGE!,
            domainName: DOMAIN_NAME!,
            serviceName: 'domain',
        })
        hostedZoneId = zoneResult.outputs.hostedZoneId

        if (!zoneResult.reused) {
            createdHostedZone = zoneResult.hostedZone

            if (AWS_ROUTE53_PARENT_HOSTED_ZONE_ID) {
                delegationRecord = createDelegationRecord({
                    parentHostedZoneId: AWS_ROUTE53_PARENT_HOSTED_ZONE_ID,
                    subdomainName: DOMAIN_NAME!,
                    nameServers: zoneResult.outputs.nameServers,
                    serviceName: 'domain',
                    dnsProvider,
                })
            }
        }
    }

    // Create certificate using the appropriate hosted zone ID
    const certificateResources = await createCertificate({
        domainName: DOMAIN_NAME!,
        hostedZoneId: hostedZoneId,
        orgName: ORG_NAME!,
        stage: STAGE!,
        serviceName: 'shared-certificate',
        dnsProvider,
    })

    // Create CloudMap service discovery namespace (for DNS-based service discovery)
    const cloudMapNamespaceName = `cloudmap.${DOMAIN_NAME}.internal` // cloudmap.shelby-dev.lixpi.dev.internal
    const cloudMapNamespace = new aws.servicediscovery.PrivateDnsNamespace(
        `${DOMAIN_NAME}-namespace`,
        {
            name: cloudMapNamespaceName,
            vpc: networkInfrastructure.vpc.id,
            description: `Private service discovery namespace for ${cloudMapNamespaceName}`,
        },
    )

    // Create ECS Cluster for Fargate tasks
    const ecsCluster = await createEcsCluster({
        vpc: networkInfrastructure.vpc,
        publicSubnets: networkInfrastructure.publicSubnets,
        privateSubnets: networkInfrastructure.privateSubnets,
        clusterName: 'Shared-ECS-Cluster',
        tags: {
            Environment: ENVIRONMENT!,
            Project: 'Lixpi AI',
        },
    })

    const natsEcsCluster = await createEcsEc2Cluster({
        vpc: networkInfrastructure.vpc,
        publicSubnets: networkInfrastructure.publicSubnets,
        privateSubnets: networkInfrastructure.privateSubnets,
        clusterName: 'NATS-ECS-Cluster',
        instanceType: process.env.NATS_EC2_INSTANCE_TYPE ?? 'm6i.large',
        minCapacity: 3,
        maxCapacity: 3,
        desiredCapacity: 3,
        dataVolumeSizeGiB: Number(process.env.NATS_EBS_VOLUME_SIZE_GIB ?? 150),
        tags: {
            Environment: ENVIRONMENT!,
            Project: 'Lixpi AI',
            Workload: 'NATS',
        },
    })

    // Create NATS domain for certificate management - USE MANAGEABLE DOMAIN
    // The client connects to nats.cloudmap.shelby-dev.lixpi.dev, but we generate cert for controllable domain
    const natsDomain = `nats.${DOMAIN_NAME}` // nats.shelby-dev.lixpi.dev (manageable via Route53)

    // Create placeholder DNS record for NATS domain BEFORE certificate generation
    // This allows DNS-01 challenge to succeed since the domain will exist in DNS
    // Note: Using a valid public IP (8.8.8.8) as placeholder instead of localhost
    // Idempotent placeholder record (safe overwrite if already present)
    const natsPlaceholderRecord = new aws.route53.Record(
        `nats-placeholder-record`,
        {
            name: natsDomain,
            zoneId: hostedZoneId,
            type: 'A',
            allowOverwrite: true,
            records: ['8.8.8.8'],
            ttl: 60,
        },
    )

    // Create Lambda-based Caddy certificate manager for NATS TLS certificates
    // Note: DNS record created above ensures domain exists for certificate validation
    const caddyCertManager = await createLambdaCertificateManager({
        domains: [natsDomain],
        email: CERTIFICATE_VALIDATION_EMAIL || `admin@${DOMAIN_NAME}`,
        // Explicitly pass hosted zone ID (removes auto-detect round trip & ambiguity)
        hostedZoneId: hostedZoneId,
        storageType: 'secrets-manager',
        storageConfig: {
            secretsManagerPrefix: formatStageResourceName(
                'nats-certs',
                ORG_NAME!,
                STAGE!,
            ),
        },
        functionName: 'nats-cert-manager',
        timeout: 900, // 15 minutes for certificate generation
        memorySize: 1024,
        dockerBuildContext: '/usr/src/service/infrastructure/pulumi/src/resources/certificate-manager',
        dockerfilePath: '/usr/src/service/infrastructure/pulumi/src/resources/certificate-manager/Dockerfile',
        environment: {
            // Any additional environment variables for Lambda
        },
    })

    // Create certificate helper for NATS to access certificates
    const natsCertHelper = createLambdaCertificateHelper(
        natsDomain,
        'secrets-manager',
        {
            secretsManagerPrefix: formatStageResourceName(
                'nats-certs',
                ORG_NAME!,
                STAGE!,
            ),
        },
    )

    // Create NATS cluster service - CRITICAL: Must wait for certificates to be generated first
    const natsClusterService = await createNatsClusterService({
        cloudMapNamespace,
        cloudMapNamespaceName,
        parentHostedZoneId: hostedZoneId, // Hosted zone we manage / created or existing
        natsRecordName: natsDomain, // e.g., "nats.shelby-dev.lixpi.dev"
        ecsCluster: {
            id: natsEcsCluster.outputs.clusterId,
            arn: natsEcsCluster.outputs.clusterArn,
            name: natsEcsCluster.outputs.clusterName,
        },
        capacityProviderName: natsEcsCluster.outputs.capacityProviderName,
        ec2SecurityGroup: natsEcsCluster.ecsSecurityGroup,
        vpc: networkInfrastructure.vpc,
        publicSubnets: networkInfrastructure.publicSubnets,
        privateSubnets: networkInfrastructure.privateSubnets,
        serviceName: formatStageResourceName(
            'nats-cluster',
            ORG_NAME!,
            STAGE!,
        ).toLowerCase(),
        clientPort: 4222, // 4222: client connections
        httpManagementPort: 8222, // 8222: HTTP management/info
        clusterRoutingPort: 6222, // 6222: cluster routing
        cpu: 256,
        memory: 512, // Changed from 256 to 512 - valid Fargate combination
        minCount: 3,
        maxCount: 3,
        desiredCount: 3,
        environment: {
            NATS_CLUSTER_NAME: 'Lixpi-NATS',
            NATS_SERVER_NAME_BASE: 'Lixpi-NATS',
            NATS_SYS_USER_PASSWORD: NATS_SYS_USER_PASSWORD!,
            NATS_REGULAR_USER_PASSWORD: NATS_REGULAR_USER_PASSWORD!,
            NATS_AUTH_NKEY_ISSUER_PUBLIC: NATS_AUTH_NKEY_ISSUER_PUBLIC!,
            NATS_AUTH_XKEY_ISSUER_PUBLIC: NATS_AUTH_XKEY_ISSUER_PUBLIC!,
            NATS_NEX_NODE_NKEY_PUBLIC: NATS_NEX_NODE_NKEY_PUBLIC!,
            NATS_SAME_ORIGIN: NATS_SAME_ORIGIN!,
            NATS_ALLOWED_ORIGINS: DEPLOY_TO_AWS
                ? includeWebClientOrigins(NATS_ALLOWED_ORIGINS, DOMAIN_NAME!)
                : NATS_ALLOWED_ORIGINS || '[]',
            NATS_DEBUG_MODE: NATS_DEBUG_MODE!,
            NATS_TRACE_MODE: NATS_TRACE_MODE!,
        },
        // Add certificate configuration
        certificateHelper: natsCertHelper,
        dockerBuildContext: '/usr/src/service/services/nats',
        dockerfilePath: '/usr/src/service/services/nats/Dockerfile',
        // CRITICAL: NATS cluster CANNOT start until certificates are generated
        dependencies: [caddyCertManager.initialCertificateGeneration],
    })

    // Deploy main API service on ECS infrastructure
    const mainApiService = await createMainApiService({
        ecsCluster: {
            id: ecsCluster.outputs.clusterId,
            arn: ecsCluster.outputs.clusterArn,
            name: ecsCluster.outputs.clusterName,
        },
        vpc: networkInfrastructure.vpc,
        publicSubnets: networkInfrastructure.publicSubnets,
        privateSubnets: networkInfrastructure.privateSubnets,
        serviceName: 'api',
        containerPort: 3000,
        // Bumped from 256/512 since the API now hosts the LangGraph LLM
        // workflow in-process (previously a separate llm-api Fargate task).
        cpu: 512,
        memory: 1024,
        desiredCount: 1,
        resourceBindings: {
            tables: {
                usersTable: dynamoDBtables.usersTable,
                organizationsTable: dynamoDBtables.organizationsTable,
                organizationsAccessListTable: dynamoDBtables.organizationsAccessListTable,
                workspacesTable: dynamoDBtables.workspacesTable,
                workspacesMetaTable: dynamoDBtables.workspacesMetaTable,
                workspacesAccessListTable: dynamoDBtables.workspacesAccessListTable,
                assetsTable: dynamoDBtables.assetsTable,
                assetsMetaTable: dynamoDBtables.assetsMetaTable,
                assetsSearchTable: dynamoDBtables.assetsSearchTable,
                assetsAccessListTable: dynamoDBtables.assetsAccessListTable,
                assetReferencesTable: dynamoDBtables.assetReferencesTable,
                promptReferenceRecentsTable: dynamoDBtables.promptReferenceRecentsTable,
                blobsTable: dynamoDBtables.blobsTable,
                blobReferencesTable: dynamoDBtables.blobReferencesTable,
                capabilitiesTable: dynamoDBtables.capabilitiesTable,
                capabilitiesMetaTable: dynamoDBtables.capabilitiesMetaTable,
                capabilitiesAccessListTable: dynamoDBtables.capabilitiesAccessListTable,
                capabilityRunsTable: dynamoDBtables.capabilityRunsTable,
                mediaGenerationRequestsTable: dynamoDBtables.mediaGenerationRequestsTable,
                mediaGenerationRequestsMetaTable: dynamoDBtables.mediaGenerationRequestsMetaTable,
                mediaGenerationRequestsAccessListTable: dynamoDBtables.mediaGenerationRequestsAccessListTable,
                assetSubjectIdentityAttestationsTable: dynamoDBtables.assetSubjectIdentityAttestationsTable,
                aiModelsListTable: dynamoDBtables.aiModelsListTable,
            },
        },
        environment: {
            NODE_OPTIONS: NODE_OPTIONS!,
            AWS_REGION: AWS_REGION!,
            STAGE: STAGE!,
            ORG_NAME: ORG_NAME!,
            ENVIRONMENT: ENVIRONMENT!,

            NATS_SERVERS: NATS_SERVERS!,
            NATS_AUTH_ACCOUNT: NATS_AUTH_ACCOUNT!,
            NATS_AUTH_NKEY_ISSUER_SEED: NATS_AUTH_NKEY_ISSUER_SEED!,
            NATS_AUTH_NKEY_ISSUER_PUBLIC: NATS_AUTH_NKEY_ISSUER_PUBLIC!,
            NATS_AUTH_XKEY_ISSUER_SEED: NATS_AUTH_XKEY_ISSUER_SEED!,
            NATS_AUTH_XKEY_ISSUER_PUBLIC: NATS_AUTH_XKEY_ISSUER_PUBLIC!,
            NATS_NEX_NODE_NKEY_PUBLIC: NATS_NEX_NODE_NKEY_PUBLIC!,
            NATS_AI_MODEL_REGISTRY_NKEY_PUBLIC: NATS_AI_MODEL_REGISTRY_NKEY_PUBLIC ?? '',
            NATS_SYS_USER_PASSWORD: NATS_SYS_USER_PASSWORD!,
            NATS_REGULAR_USER_PASSWORD: NATS_REGULAR_USER_PASSWORD!,
            ORIGIN_HOST_URL: ORIGIN_HOST_URL!,
            API_HOST_URL: API_HOST_URL!,
            AUTH0_DOMAIN: AUTH0_DOMAIN!,
            AUTH0_API_IDENTIFIER: AUTH0_API_IDENTIFIER!,
            SAVE_LLM_RESPONSES_TO_DEBUG_DIR: SAVE_LLM_RESPONSES_TO_DEBUG_DIR!,
            OPENAI_API_KEY: OPENAI_API_KEY!,
            // An api key may be empty when its provider runs through Bedrock and signs with the task role.
            ANTHROPIC_API_KEY: ANTHROPIC_API_KEY ?? '',
            ANTHROPIC_USE_AWS_BEDROCK_INFERENCE: ANTHROPIC_USE_AWS_BEDROCK_INFERENCE ?? 'false',
            GOOGLE_API_KEY: GOOGLE_API_KEY ?? '',
            // Veo person-generation policy profile for the deployment region. The Google
            // media profile fails every Veo run when it is unset, so it is not defaulted.
            GOOGLE_VEO_PERSON_GENERATION_PROFILE: GOOGLE_VEO_PERSON_GENERATION_PROFILE ?? '',
            STABLE_DIFFUSION_API_KEY: STABLE_DIFFUSION_API_KEY ?? '',
            STABILITY_USE_AWS_BEDROCK_INFERENCE: STABILITY_USE_AWS_BEDROCK_INFERENCE ?? 'false',
            // BytePlus ModelArk (Seedance video). Accept either env name and emit the
            // canonical ARK_API_KEY on the task def; || (not ??) so an empty string from
            // one name falls through to the other. The provider reads ARK_API_KEY as a fallback.
            ARK_API_KEY: ARK_API_KEY || BYTEPLUS_ARK_API_KEY || '',
            LLM_TIMEOUT_SECONDS: LLM_TIMEOUT_SECONDS ?? '1200',
        },
        dockerBuildContext: '/usr/src/service',
        dockerfilePath: '/usr/src/service/services/api/Dockerfile',
    })

    // Deploy the NATS NEX execution-engine node (internal, single instance).
    // Connects to the cluster over the internal CloudMap URL — the Go nex client
    // needs a plain nats:// endpoint
    // (the :4222 client port is not TLS), so we pass natsUrl, NOT the tls://
    // NATS_SERVERS env the JS API client tolerates.
    const nexNodeService = await createNexNodeService({
        ecsCluster: {
            id: ecsCluster.outputs.clusterId,
            arn: ecsCluster.outputs.clusterArn,
            name: ecsCluster.outputs.clusterName,
        },
        vpc: networkInfrastructure.vpc,
        privateSubnets: networkInfrastructure.privateSubnets,
        serviceName: formatStageResourceName(
            'nex',
            ORG_NAME!,
            STAGE!,
        ).toLowerCase(),
        cpu: 512,
        memory: 1024,
        desiredCount: 1,
        tables: {},
        environment: {
            NATS_SERVERS: natsClusterService.outputs.natsUrl, // internal plain nats:// CloudMap URL
            NATS_NEX_NODE_NKEY_PUBLIC: NATS_NEX_NODE_NKEY_PUBLIC!,
            NATS_NEX_NODE_NKEY_SEED: NATS_NEX_NODE_NKEY_SEED!,
            NATS_JS_DOMAIN: 'lixpi',
            NEX_NAMESPACE: 'system',
            NEX_NODE_NAME: 'lixpi-nex',
            ORG_NAME: ORG_NAME!,
            STAGE: STAGE!,
            ENVIRONMENT: ENVIRONMENT!,
            AWS_REGION: AWS_REGION!,
            // No DYNAMODB_ENDPOINT / AWS_PROFILE on AWS: the remaining workloads reach
            // AWS through the task role (creds arrive on the ECS metadata endpoint and
            // the entrypoint forwards AWS_CONTAINER_CREDENTIALS_RELATIVE_URI).
        },
        dockerBuildContext: '/usr/src/service',
        dockerfilePath: '/usr/src/service/services/nex/Dockerfile',
        dependencies: [natsClusterService.ecsService],
    })

    // Deploy the AI Model Registry (internal, single instance). It owns the model
    // catalog and writes AI_MODELS_LIST on an hourly loop, which is the job the
    // ai-models-synchronization NEX workload used to do.
    const aiModelRegistryService = await createAiModelRegistryService({
        ecsCluster: {
            id: ecsCluster.outputs.clusterId,
            arn: ecsCluster.outputs.clusterArn,
            name: ecsCluster.outputs.clusterName,
        },
        vpc: networkInfrastructure.vpc,
        privateSubnets: networkInfrastructure.privateSubnets,
        serviceName: formatStageResourceName(
            'ai-model-registry',
            ORG_NAME!,
            STAGE!,
        ).toLowerCase(),
        cpu: 256,
        memory: 512,
        desiredCount: 1,
        tables: {
            aiModelsListTable: dynamoDBtables.aiModelsListTable,
        },
        environment: {
            NATS_SERVERS: natsClusterService.outputs.natsUrl,
            NATS_AI_MODEL_REGISTRY_NKEY_SEED: NATS_AI_MODEL_REGISTRY_NKEY_SEED ?? '',
            NATS_AI_MODEL_REGISTRY_USER_ID: NATS_AI_MODEL_REGISTRY_USER_ID ?? 'svc:ai-model-registry',
            ORG_NAME: ORG_NAME!,
            STAGE: STAGE!,
            ENVIRONMENT: ENVIRONMENT!,
            AWS_REGION: AWS_REGION!,
            MODEL_CATALOG_SYNC_ENABLED: 'true',
            // The deployed catalog tree ships in the image and is read-only, so a
            // production run merges in memory and writes only DynamoDB.
            MODEL_CATALOG_WRITE_FILES: 'false',
            MODEL_CATALOG_WRITE_DYNAMODB: 'true',
            OPENAI_API_KEY: OPENAI_API_KEY!,
            ANTHROPIC_API_KEY: ANTHROPIC_API_KEY ?? '',
            // With Bedrock inference on there may be no Anthropic key at all, so the
            // registry lists Anthropic models from the Bedrock catalog instead.
            ANTHROPIC_USE_AWS_BEDROCK_INFERENCE: ANTHROPIC_USE_AWS_BEDROCK_INFERENCE ?? 'false',
            GOOGLE_API_KEY: GOOGLE_API_KEY ?? '',
            STABLE_DIFFUSION_API_KEY: STABLE_DIFFUSION_API_KEY ?? '',
            ARK_API_KEY: ARK_API_KEY || BYTEPLUS_ARK_API_KEY || '',
        },
        dockerBuildContext: '/usr/src/service',
        dockerfilePath: '/usr/src/service/services/ai-model-registry/Dockerfile',
        dependencies: [natsClusterService.ecsService],
    })

    // Deploy the web UI with CloudFront distribution
    const webUI = await createWebUI({
        orgName: ORG_NAME!,
        stage: STAGE!,
        domainName: DOMAIN_NAME!,
        hostedZoneId: hostedZoneId as unknown as string, // createWebUI currently expects string; cast Output
        hostedZoneName: HOSTED_ZONE_NAME || DOMAIN_NAME!,
        certificateArn: certificateResources.outputs.validatedCertificateArn,
        environment: {
            VITE_API_URL: VITE_API_URL!,
            VITE_AUTH0_LOGIN_URL: VITE_AUTH0_LOGIN_URL!,
            VITE_AUTH0_DOMAIN: VITE_AUTH0_DOMAIN!,
            VITE_AUTH0_CLIENT_ID: VITE_AUTH0_CLIENT_ID!,
            VITE_AUTH0_AUDIENCE: VITE_AUTH0_AUDIENCE!,
            VITE_AUTH0_REDIRECT_URI: VITE_AUTH0_REDIRECT_URI!,
            VITE_NATS_SERVER: VITE_NATS_SERVER!,
        },
        dockerBuildContext: '/usr/src/service',
        dockerfilePath: '/usr/src/service/services/web-ui/Dockerfile',
    })

    const userPortalDomainName = `user-portal.${DOMAIN_NAME!}`
    const webUIUserPortal = await createWebUIUserPortal({
        orgName: ORG_NAME!,
        stage: STAGE!,
        domainName: userPortalDomainName,
        hostedZoneId: hostedZoneId as unknown as string,
        hostedZoneName: HOSTED_ZONE_NAME || DOMAIN_NAME!,
        certificateArn: certificateResources.outputs.validatedCertificateArn,
        environment: {
            VITE_API_URL: VITE_API_URL!,
            VITE_AUTH0_LOGIN_URL: `https://${userPortalDomainName}`,
            VITE_AUTH0_DOMAIN: VITE_AUTH0_DOMAIN!,
            VITE_AUTH0_CLIENT_ID: VITE_AUTH0_CLIENT_ID!,
            VITE_AUTH0_AUDIENCE: VITE_AUTH0_AUDIENCE!,
            VITE_AUTH0_REDIRECT_URI: `https://${userPortalDomainName}`,
            VITE_NATS_SERVER: VITE_NATS_SERVER!,
        },
        dockerBuildContext: '/usr/src/service',
        dockerfilePath: '/usr/src/service/services/web-ui-user-portal/Dockerfile',
    })

    // Create DNS records after the services are created
    const dnsRecords = pulumi.all([
        hostedZoneId,
        webUI.outputs.domainName,
        webUI.outputs.distributionDomainName,
        webUI.outputs.distributionHostedZoneId,
        webUI.outputs.wwwDomainName,
        webUIUserPortal.outputs.domainName,
        webUIUserPortal.outputs.distributionDomainName,
        webUIUserPortal.outputs.distributionHostedZoneId,
    ]).apply(async ([
        currentHostedZoneId,
        webDomainName,
        webDistDns,
        webDistZoneId,
        webWwwDomainName,
        portalDomainName,
        portalDistDns,
        portalDistZoneId,
    ]) => {
        return await createDnsRecords({
            orgName: ORG_NAME!,
            stage: STAGE!,
            hostedZoneId: currentHostedZoneId, // Use the appropriate hosted zone
            records: [
                // Note: NATS DNS is now handled automatically by CloudMap public namespace
                // No manual DNS records needed for NATS - CloudMap manages nats.shelby-dev.lixpi.dev

                // Add the record for the apex domain
                {
                    name: webDomainName,
                    type: 'A',
                    alias: {
                        name: webDistDns,
                        zoneId: webDistZoneId,
                        evaluateTargetHealth: false,
                    },
                },
                // Add the record for www subdomain
                {
                    name: webWwwDomainName,
                    type: 'A',
                    alias: {
                        name: webDistDns,
                        zoneId: webDistZoneId,
                        evaluateTargetHealth: false,
                    },
                },
                {
                    name: portalDomainName,
                    type: 'A',
                    alias: {
                        name: portalDistDns,
                        zoneId: portalDistZoneId,
                        evaluateTargetHealth: false,
                    },
                },
            ],
            serviceName: 'Lixpi-AI',
        })
    })

    return {
        ssmParameters,
        dynamoDBtables,
        networkInfrastructure,
        ecsCluster,
        caddyCertManager,
        natsClusterService,
        mainApiService,
        nexNodeService,
        aiModelRegistryService,
        webUI,
        webUIUserPortal,
        certificateResources,
        dnsRecords,
        cloudMapNamespace,
        ...(createdHostedZone && { createdHostedZone }),
        ...(delegationRecord && { delegationRecord }),
    }
}
