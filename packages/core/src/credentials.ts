/** Credential references belong in configuration; secrets stay behind the resolver. */
export type CredentialReference = { type: 'managed'; id: string } | { type: 'kingdom-runtime' };

export interface CredentialScope {
  service: string;
  url: string;
  projectId: string;
  kastleId?: string;
}

export interface CredentialResolver {
  /** Resolve afresh for each request. Reject a reference outside its permitted scope. */
  resolve(reference: CredentialReference, scope: CredentialScope): Promise<string>;
}
