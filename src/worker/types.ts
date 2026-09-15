export interface Env {
  LINKS: DurableObjectNamespace;
}

// A type alias (not an interface) so it satisfies sql.exec<T>'s
// Record<string, SqlStorageValue> constraint via implicit index signature.
export type Link = {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  /** JSON-encoded string[] as stored in SQLite. */
  tags: string;
  created_at: string;
  updated_at: string;
};
