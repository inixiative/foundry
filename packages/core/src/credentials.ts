/** Credential references belong in configuration; secrets stay behind the resolver. */
/** `kingdom-runtime` names the paired Kingdom by the destination's origin plus the owner it was paired as. */
export type CredentialReference =
  | { type: 'managed'; id: string }
  | { type: 'kingdom-runtime'; owner: string };

export interface CredentialScope {
  service: string;
  url: string;
  projectId: string;
}

export interface CredentialResolver {
  /** Resolve afresh for each request. Reject a reference outside its permitted scope. */
  resolve(reference: CredentialReference, scope: CredentialScope): Promise<string>;
}
