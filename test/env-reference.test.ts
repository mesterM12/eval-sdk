import { describe, expect, it } from "vitest";
import { collectEnvSecretValues, describeEnvForPublicOutput, envReferenceValidationError, redactText, resolveEnv } from "../src/env-reference.js";

describe("Env reference module", () => {
  it("validates env refs with one shared syntax rule", () => {
    expect(envReferenceValidationError("env:API_KEY", "agent claude", "API_KEY")).toBeUndefined();
    expect(envReferenceValidationError("env:_TOKEN_1", "agent claude", "TOKEN")).toBeUndefined();

    expect(envReferenceValidationError("literal", "agent claude", "API_KEY")).toBe("agent claude env API_KEY must be an env var reference like env:API_KEY");
    expect(envReferenceValidationError("env:1BAD", "agent claude", "API_KEY")).toBe("agent claude env API_KEY must be an env var reference like env:API_KEY");
    expect(envReferenceValidationError(42, "agent claude", "API_KEY")).toBe("agent claude env API_KEY must be an env var reference like env:API_KEY");
  });

  it("resolves env refs while preserving current missing-value behavior", () => {
    process.env.EVAL_REF_SECRET = "resolved-secret";
    delete process.env.EVAL_REF_MISSING;

    expect(resolveEnv({ API_KEY: "env:EVAL_REF_SECRET", MISSING: "env:EVAL_REF_MISSING", LITERAL: "literal" })).toEqual({
      API_KEY: "resolved-secret",
      MISSING: "",
      LITERAL: "literal",
    });
  });

  it("collects secrets and public env display values through the same env-reference rules", () => {
    process.env.EVAL_REF_SECRET = "resolved-secret";
    process.env.EVAL_REF_EMPTY = "";

    expect(collectEnvSecretValues([{ API_KEY: "env:EVAL_REF_SECRET" }, { DUPLICATE: "env:EVAL_REF_SECRET" }, { EMPTY: "env:EVAL_REF_EMPTY" }])).toEqual(["resolved-secret"]);
    expect(describeEnvForPublicOutput({ API_KEY: "env:EVAL_REF_SECRET", LITERAL: "literal" })).toEqual({ API_KEY: "[env]", LITERAL: "[env]" });
    expect(redactText("resolved-secret literal resolved-secret", ["resolved-secret"])).toBe("[REDACTED] literal [REDACTED]");
  });
});
