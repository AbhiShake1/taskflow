import { ZodError } from 'zod';

export class RegistryFetchError extends Error {
  override name = 'RegistryFetchError';
  readonly url: string;
  readonly status?: number;
  readonly details?: string;
  constructor(url: string, status?: number, details?: string) {
    const parts = [`Failed to fetch registry item from ${url}`];
    if (typeof status === 'number') parts.push(`(HTTP ${status})`);
    if (details) parts.push(`- ${details}`);
    parts.push('Check the URL, network connectivity, and any required auth headers.');
    super(parts.join(' '));
    this.url = url;
    this.status = status;
    this.details = details;
  }
}

export class RegistryNotFoundError extends Error {
  override name = 'RegistryNotFoundError';
  readonly url: string;
  constructor(url: string) {
    super(
      `Registry item at ${url} not found. Check the URL or set TASKFLOW_REGISTRY_URL.`,
    );
    this.url = url;
  }
}

export class RegistryUnauthorizedError extends Error {
  override name = 'RegistryUnauthorizedError';
  readonly url: string;
  constructor(url: string) {
    super(
      `Registry request to ${url} returned 401. Set the auth env var referenced in your taskflow.json registry entry.`,
    );
    this.url = url;
  }
}

export class RegistryForbiddenError extends Error {
  override name = 'RegistryForbiddenError';
  readonly url: string;
  constructor(url: string) {
    super(
      `Registry request to ${url} returned 403. Verify that your token has access to this registry and namespace.`,
    );
    this.url = url;
  }
}

export class RegistryGoneError extends Error {
  override name = 'RegistryGoneError';
  readonly url: string;
  constructor(url: string) {
    super(
      `Registry item at ${url} is gone (HTTP 410). Update your source reference to a current item or pin a previous version via the lockfile.`,
    );
    this.url = url;
  }
}

export class RegistryParseError extends Error {
  override name = 'RegistryParseError';
  readonly source: string;
  readonly cause: unknown;
  constructor(source: string, cause: unknown) {
    let detail: string;
    if (cause instanceof ZodError) {
      const issues = cause.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      detail = `schema validation failed: ${issues}`;
    } else if (cause instanceof Error) {
      detail = cause.message;
    } else {
      detail = String(cause);
    }
    super(
      `Failed to parse registry payload from ${source}: ${detail}. Fix the registry item so it matches the registry-item.json schema.`,
    );
    this.source = source;
    this.cause = cause;
  }
}

export class RegistryLocalFileError extends Error {
  override name = 'RegistryLocalFileError';
  readonly path: string;
  readonly cause: unknown;
  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Failed to read local registry file at ${path}: ${detail}. Check the path exists and is readable.`,
    );
    this.path = path;
    this.cause = cause;
  }
}

export class RegistryNotConfiguredError extends Error {
  override name = 'RegistryNotConfiguredError';
  readonly namespace: string;
  constructor(namespace: string) {
    super(
      `Registry namespace "${namespace}" is not configured. Add an entry to taskflow.json: ` +
        `{ "registries": { "${namespace}": "https://your-host.example/r/{name}.json" } }. ` +
        `The URL MUST contain the {name} placeholder.`,
    );
    this.namespace = namespace;
  }
}

export class RegistryMissingEnvironmentVariablesError extends Error {
  override name = 'RegistryMissingEnvironmentVariablesError';
  readonly varNames: string[];
  constructor(varNames: string[]) {
    super(
      `Missing required environment variables for registry: ${varNames.join(', ')}. ` +
        `Export them in your shell or add them to a .env / .env.local file at the project root.`,
    );
    this.varNames = varNames;
  }
}
