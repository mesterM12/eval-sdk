# Local Sandbox For Login-Authenticated Agents

Some agent CLIs can authenticate through local login state rather than API keys, but copying that state into Docker is provider-specific and fragile. We support `sandbox.provider: local` by mapping Sandcastle execution to `noSandbox()` for both coding agents and evaluator agents, accepting weaker process isolation in exchange for using the host's locally authenticated Claude Code and OpenCode/OpenAI sessions.
