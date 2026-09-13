# LoreScribe
AI-assisted novel writing for any genre. Structured lore, world, and character resources linked to the scenes that use them, with chapter/scene and story-arc planning, and user-defined "laws" the AI must follow. Multi-provider — OpenRouter first, local models next. Web app and Android.

## Planning

Design docs live in [`docs/`](docs/) — start with the
[index](docs/README.md), or go straight to the
[vision & diagnosis](docs/00-vision-and-diagnosis.md) and the
[story graph / scene brief compiler](docs/03-story-graph-and-context.md),
which is the core of the system. The draft database schema is
[`db/schema.sql`](db/schema.sql).

**Shape of the thing:** React + TypeScript + Capacitor (one codebase → PWA and
Android APK), local-first SQLite, the writer's own API key called directly
(OpenRouter first, OpenAI-compatible local endpoints next). Status: planning.
