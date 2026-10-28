/**
 * The presentation contract for models, shared by every surface that shows one:
 * the HTTP server, the terminal, the CLI and the session runtime.
 *
 * Dependency-free by design: the browser type-checks this module directly, so
 * it must never import settings, the catalog, or a Node builtin.
 */

/** One model as a UI shows it. Ids drive requests; names only label them. */
export interface ModelPresentation {
  providerId: string;
  modelId: string;
  /** Readable model name; never derived from the id, so a slash-bearing id stays intact. */
  name: string;
  /** Readable provider name; the provider id when nothing knows better. */
  providerName: string;
}

/**
 * A provider's models as the settings page sees them: catalog plus activation.
 * The catalog is the source, but a model the operator added by hand survives
 * even when the catalog does not know it: dropping it from the list would
 * silently disable a working configuration.
 */
export interface ModelCatalogRow {
  providerId: string;
  providerName: string;
  models: Array<{ modelId: string; name: string; active: boolean }>;
}
