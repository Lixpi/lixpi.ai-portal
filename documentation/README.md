---
title: Lixpi Documentation
description: Map of the Lixpi documentation for the product, platform, canvas, AI chat, media generation, and Capability library.
---

# Lixpi Documentation

Lixpi is a visual, node-based AI workspace for image and video generation pipelines — **the spatial arrangement of nodes _is_ the workflow**. This is the documentation map. Start with the [Product Overview](PRODUCT-OVERVIEW.md), then dive into the domain you care about. The generated site sidebar provides the full current inventory; this page is only the human starting map.

{% callout type="note" %}
These docs are authored as Markdoc-friendly Markdown and render to a static HTML site via a standalone, single-dependency renderer in [`site/`](site/README.md). They also read fine as plain Markdown on GitHub.
{% /callout %}

## Start here

| Page | What it covers |
|------|----------------|
| [Product Overview](PRODUCT-OVERVIEW.md) | The product thesis: canvas primitives, artifact piping, character consistency, the image/video pipelines, multi-model support |
| [System Architecture](platform/SYSTEM-ARCHITECTURE.md) | Services, the NATS backbone, Capability ownership boundaries, subject naming, key design decisions, horizontal scaling |
| [Development](platform/DEVELOPMENT.md) | Local dev quick start: env wizard, infrastructure init, running services |
| [AI Model Registry](../services/ai-model-registry/documentation/AI-MODEL-REGISTRY.md) | Required synchronization between provider documentation, registry data, model sync, provider requests, configuration controls, tests, and developer docs |
| [Implementation Plans](development-workflow/research-and-development/WRITING-IMPLEMENTATION-PLANS.md) | How one file under `documentation/memory/` carries task decisions, implementation state, evidence, and the next action across sessions |
| [Spike Reports](development-workflow/research-and-development/SPIKE-REPORT-GUIDELINES.md) | How to investigate code and non-code questions, maintain an evidence-backed report, and continue the same file into implementation |
| [TypeScript Linting and Formatting](../services/typescript-quality-runner/documentation/TYPESCRIPT-QUALITY.md) | AST-based formatting and linting rules plus Docker-only per-service and per-package commands |
| [Nano Stores](platform/NANOSTORES.md) | Frontend store conventions for `nanostores` and `@nanostores/persistent` |
| [Maintaining Documentation](MAINTAINING-DOCUMENTATION.md) | How to discover, move, link, render, and verify docs as the architecture changes |

## Finding the Right Guide

Do not rely on tiny routing files or stale folder names. To find the right guidance:

1. Before writing or revising documentation, resolve and read `$talk-like-a-human` through the active harness's skill discovery. If it cannot be resolved or read, stop, report the failure, and wait for the user's instructions.
2. Use this index for the main product and platform entry points.
3. Use the generated docs-site sidebar for the complete current file list.
4. Search by the concept you are changing, then read nearby pages before editing.
5. For every implementation iteration, read [`Testing Guide Selection`](testing/USING-TESTING-GUIDES.md), then read the relevant coding and source README guidance that matches the files being touched. Tests must not be written or run unless the user explicitly asks for tests in the current thread.
6. For any code change, read [`Coding Style Guide Selection`](coding-style-guides/USING-CODING-STYLE-GUIDES.md). [`TypeScript Coding Style`](coding-style-guides/TYPESCRIPT.md) is mandatory for every TypeScript file in the repository; [`UI Components Coding Style`](coding-style-guides/UI-COMPONENTS.md) is additionally mandatory for `services/web-ui` UI work.

When the architecture changes, update this map and the affected domain pages together. Avoid creating new "using this folder" stubs; add useful guidance to a real page instead.

## Platform

The cross-cutting spine. Every feature references these instead of re-explaining them.

| Page | What it covers |
|------|----------------|
| [System Architecture](platform/SYSTEM-ARCHITECTURE.md) | Service responsibilities, NATS as the backbone, subject conventions, design decisions, scaling |
| [AI Generation Pipeline](platform/AI-GENERATION-PIPELINE.md) | Authoritative context, Capability preflight, selected reasoning/media axes, media strategies, lineage, settlement, cancellation, and cleanup |
| [Streaming & Events](platform/STREAMING-AND-EVENTS.md) | Live AI pipeline subjects, JetStream replay logs, ProseMirror step streams, and the stream-event catalog |
| [Data Storage](platform/DATA-STORAGE.md) | Asset/Blob tables, typed references, scope projections, organization Object Store layout, deletion/repair, and revision-2 portability |
| [Authentication](platform/AUTHENTICATION.md) | Dual auth model, NATS auth callout, `@lixpi/auth-service`, LocalAuth0 |
| [Usage Reporting](../packages/lixpi/usage-reporter/README.md) | `@lixpi/usage-reporter` — per-endpoint rates, the admission check, measured usage, the metering port, money settings |
| [Nano Stores](platform/NANOSTORES.md) | Browser-side store conventions for `nanostores`, persistent stores, and framework-agnostic TypeScript consumers |
| [Infrastructure Overview](platform/deployment/INFRASTRUCTURE-OVERVIEW.md) | Pulumi, AWS topology, network, ECS `api`, web-ui delivery, DynamoDB |
| [NATS Cluster](platform/deployment/NATS-CLUSTER.md) | Three-node ECS EC2 NATS cluster, EBS JetStream storage, discovery, TLS, authentication, backup, and restore |
| [NEX Execution Engine](platform/deployment/NEX-EXECUTION-ENGINE.md) | The background-workload node — AI-models sync, file conversion/frame extraction, the NEX account and credentials, local and AWS deployment |
| [Scaling & Operations](platform/deployment/SCALING-AND-OPERATIONS.md) | Scaling profile, capacity ceilings, failure modes, environments, observability |

## Canvas

Product behavior and persistence stay in the central workspace guides. Rendering, reusable components and Lixpi canvas composition are documented with their packages.

| Page | What it covers |
|------|----------------|
| [Workspace Model](canvas/WORKSPACE-MODEL.md) | Core concepts, the `CanvasState`/`CanvasNode`/`WorkspaceEdge` data model, stores, NATS subjects, HTTP endpoints, persistence, media lifecycle, storage durability, lazy loading |
| [User Flows](canvas/USER-FLOWS.md) | Opening a workspace, creating documents, uploading/converting/saving/deleting/moving/editing media |
| [Canvas Engine](../packages/lixpi/canvas-engine/README.md) | Rendering, scene contracts, node registration, input, connectors, collisions and resource ownership |
| [Canvas Components](../packages/lixpi/canvas-components/README.md) | Reusable media surfaces, glass, outlines, loading effects and examples |
| [Lixpi Canvas Components](../packages/lixpi/canvas-components-lixpi-specific/README.md) | Workspace composition, product nodes, media events, host ports and persistence |
| [UI Primitives](../packages/lixpi/ui-primitives/README.md) | Shared DOM templates, SVG utilities, colors, gradients and easing |
| [UI Kit](../packages/lixpi/ui-kit/README.md) | Panels, menus, tooltips, controls, previews and icon artwork |
| [Gentelella UI Kit](../packages/lixpi/ui-kit-gentelella/README.md) | Gentelella theme styles, typed runtime facades, class contracts and composable DOM components |
| [Auth Client](../packages/lixpi/auth-client/README.md) | Shared browser authentication, auth/user Nano Stores, and current-user loading |
| [Web Client Service Factory](../packages/lixpi/web-client-service-factory/README.md) | Dependency-neutral browser startup, routing, base Nano Stores, route views, Vite, and Sass setup |

## AI Chat & Context

| Page | What it covers |
|------|----------------|
| [Workspace Composer & Generated Output Details](ai-chat/CHAT-PANEL-AND-SESSIONS.md) | Conversation Assets, detached streaming authority, the canvas composer, and the persisted unified generated-output details panel |
| [Explicit Workspace Context](ai-chat/CONTEXT-RELEVANCE.md) | Prompt reference atoms, composer context chips, authorization, and explicit-only media candidate routing |
| [Media & Content Descriptors](ai-chat/MEDIA-DESCRIPTORS.md) | The `ContentDescriptor` shape, sourcing paths, self-heal, the canvas indicator |

## Media Generation

| Page | What it covers |
|------|----------------|
| [Image Generation](media-generation/IMAGE-GENERATION.md) | The `generate_image` tool, provider paths (Image API / Responses API / Gemini native), sizes, image events |
| [Video Generation](media-generation/VIDEO-GENERATION.md) | VEO submit/poll, the `generate_video` tool, the VEO provider, storage/durability, video events, the video node, model sync, usage, extension |
| [Branch Lineage & Provenance](media-generation/BRANCH-LINEAGE.md) | The structured VLM resolver, candidate snapshot, persisted metadata, placement rules, branch-root provenance, balanced branch-tree layout, references-vs-lineage |
| [Media Reference Identity and Provider Moderation](media-generation/MEDIA-REFERENCE-IDENTITY-AND-MODERATION.md) | Provider-safe aliases, local ambiguity resolution, durable requests, Asset identity attestations, native verification, provider policy profiles, and recoverable operation nodes |
| [Video Player Controls](../packages/lixpi/ui-kit/docs/VIDEO-PLAYER-CONTROLS.md) | The shared SVG control bar, two mount points, scrubbing, accessibility |

## Library

| Page | What it covers |
|------|----------------|
| [Tools and Skills](library/TOOLS-AND-SKILLS.md) | Self-contained Capability modules, typed host ports, description sheets, standalone packages, sealed execution, scopes, and progress |
| [Capability Storage and Operations](library/CAPABILITY-STORAGE.md) | Catalog tables, Blob-backed packages, run logs, limits, backup, restore, repair, and garbage collection |
| [Character Creator](library/CHARACTER-CREATOR.md) | Panel graph, source evidence, provider capability adapters, fidelity assessment, deterministic composition, and normal Asset settlement |
| [Action Timeline](library/ACTION-TIMELINE.md) | Reusable timed prompt Artifacts, prompt-derived timing, editing, references, library behavior, and model admission |
| [Style Extraction Tool](library/STYLE-EXTRACTION-TOOL.md) | The built-in Capability module's Tool DAG, specialist actions, standalone visual-style output, and generic progress |
| [Style Extraction Pipeline](library/STYLE-EXTRACTION-PIPELINE.md) | Router, parallel axis specialists, crops, synthesis, samples, validation, and visual-style persistence |
| [Style Reference Isolation](library/ANTI-LEAKAGE.md) | Source evidence, neutral probes, provider-neutral references, traceability, and isolation limits |
| [Media Library](library/MEDIA-LIBRARY.md) | The saved-media panel, saved images/videos, scopes, ownership, URL import, data model, service surface |
| [Workspace Export & Import](library/WORKSPACE-EXPORT-IMPORT.md) | ZIP export and the validate-wipe-replace import |

## Conventions & deep dives

Shared browser building blocks are documented in [UI Primitives](../packages/lixpi/ui-primitives/README.md): DOM templates, SVG utilities, gradients, animation timing and transition helpers. The [UI Kit](../packages/lixpi/ui-kit/README.md) owns shared controls and icon artwork.

| Page | What it covers |
|------|----------------|
| [Maintaining Documentation](MAINTAINING-DOCUMENTATION.md) | Documentation discovery, page moves, Markdoc compatibility, link hygiene, and verification |
| [AI Model Registry](../services/ai-model-registry/documentation/AI-MODEL-REGISTRY.md) | Container-only registry maintenance and the required code/data synchronization contract |
| [TypeScript Linting and Formatting](../services/typescript-quality-runner/documentation/TYPESCRIPT-QUALITY.md) | AST-based Oxfmt, Oxc, parse5, dprint, Oxlint, and Stylelint rules, checks, fixes, cache behavior, and import formatting |
| [Documentation Style Guide Selection](documentation-style-guides/USING-DOCUMENTATION-STYLE-GUIDES.md) | Which documentation style sources apply to a given docs change |
| [Coding Style Guide Selection](coding-style-guides/USING-CODING-STYLE-GUIDES.md) | Which coding style guides apply to the files being changed — TypeScript rules bind repo-wide |
| [TypeScript Coding Style](coding-style-guides/TYPESCRIPT.md) | TypeScript imports, type definitions, class-first ownership, DOM templating, and modern JavaScript rules — mandatory for all TypeScript in the repo |
| [UI Components Coding Style](coding-style-guides/UI-COMPONENTS.md) | TypeScript DOM, D3/SVG, canvas chrome, component ownership, layout, and event rules |
| [Markdown Rendering](conventions/MARKDOWN-RENDERING.md) | The one-parser rule and the two renderers |
| [API-Owned Media Lineage Planning](knowledge/API-OWNED-MEDIA-LINEAGE-PLANNING.md) | API/browser ownership boundary for media branch topology, lineage plans, marker provenance, and canvas application |
| [Rendering Architecture for a Media-Heavy Canvas](knowledge/RENDERING-ARCHITECTURE-FOR-MEDIA-HEAVY-CANVAS.md) | Why the DOM/PIXI split; what the leading canvases use |
| [Why Model Combinations Produce Different Styles](knowledge/WHY-DIFFERENT-MODEL-COMBINATIONS-PRODUCE-DIFFERENT-STYLES.md) | Model chaining and visual signatures |
| [Internal Service NATS Auth Pattern](knowledge/INTERNAL-SERVICE-NATS-AUTH-PATTERN.md) | NKey-signed service auth recipe |
| [NATS NEX Execution Engine — How It Works](knowledge/NATS-NEX-EXECUTION-ENGINE-EXPLAINED.md) | Nodes/nexlets/workloads, the Nexfile, every way to run NEX, and the real container/Docker story |

## Manual Docs Rendering

The docs can render to HTML with the zero-framework Markdoc renderer when a human explicitly wants the static site:

```bash
pnpm docs:build
```

This is not an agent verification step. See [`site/README.md`](site/README.md) for the renderer details.
