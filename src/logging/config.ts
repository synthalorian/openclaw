// Logging config helpers read and normalize logger configuration.
import fs from "node:fs";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { getCommandPathWithRootOptions } from "../cli/argv.js";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { resolveConfigIncludes, resolveConfigIncludesForTopLevelKey } from "../config/includes.js";
import { resolveConfigPath, resolveIncludeRoots } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

// Lightweight logging-config reader used before the full config runtime is safe to load.
type LoggingConfig = NonNullable<OpenClawConfig["logging"]>;

let cachedLoggingConfig:
  | {
      path: string;
      logging: LoggingConfig | undefined;
    }
  | undefined;

function resolveDirectConsoleStyle(logging: unknown): LoggingConfig | undefined {
  if (!isObjectRecord(logging) || typeof logging.consoleStyle !== "string") {
    return undefined;
  }
  const resolved = resolveConfigEnvVars({ consoleStyle: logging.consoleStyle });
  if (!isObjectRecord(resolved)) {
    return undefined;
  }
  const style = resolved.consoleStyle;
  if (style !== "pretty" && style !== "compact" && style !== "json") {
    return undefined;
  }
  // Runtime/docs support compact even though the generated authored-config type remains narrower.
  return { consoleStyle: style } as LoggingConfig;
}

/** Avoids config reads that can mutate or validate config while schema/config commands run. */
export function shouldSkipMutatingLoggingConfigRead(argv: string[] = process.argv): boolean {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  return primary === "config" && (secondary === "schema" || secondary === "validate");
}

/** Reads the logging block from config, caching by resolved config path. */
export function readLoggingConfig(): LoggingConfig | undefined {
  try {
    const configPath = resolveConfigPath();
    if (cachedLoggingConfig?.path === configPath) {
      return cachedLoggingConfig.logging;
    }
    if (!fs.existsSync(configPath)) {
      return undefined;
    }
    const parsed = parseJsonWithJson5Fallback(fs.readFileSync(configPath, "utf8"));
    const allowedRoots = resolveIncludeRoots();
    let includedConfig: unknown;
    try {
      includedConfig = resolveConfigIncludesForTopLevelKey(
        parsed,
        configPath,
        "logging",
        undefined,
        { allowedRoots },
      );
    } catch {
      // Validation commands still need a directly-authored logging style when an unrelated
      // root include is malformed. Resolve only that subtree through the same canonical rules.
      const directLogging = isObjectRecord(parsed) ? parsed.logging : undefined;
      if (directLogging === undefined) {
        return undefined;
      }
      try {
        includedConfig = resolveConfigIncludes({ logging: directLogging }, configPath, undefined, {
          allowedRoots,
        });
      } catch {
        const logging = resolveDirectConsoleStyle(directLogging);
        cachedLoggingConfig = { path: configPath, logging };
        return logging;
      }
    }
    let resolvedConfig: unknown;
    try {
      resolvedConfig = resolveConfigEnvVars(includedConfig);
    } catch {
      const includedLogging = isObjectRecord(includedConfig) ? includedConfig.logging : undefined;
      const logging = resolveDirectConsoleStyle(includedLogging);
      cachedLoggingConfig = { path: configPath, logging };
      return logging;
    }
    const logging = isObjectRecord(resolvedConfig) ? resolvedConfig.logging : undefined;
    const resolvedLogging = isObjectRecord(logging) ? (logging as LoggingConfig) : undefined;
    cachedLoggingConfig = {
      path: configPath,
      logging: resolvedLogging,
    };
    return resolvedLogging;
  } catch {
    return undefined;
  }
}
