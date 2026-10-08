/** Credential references belong in configuration; secrets stay behind the resolver. */
/** `kingdom-signet` names the Signet a paired Kingdom granted, by the destination's origin plus the owner it was paired as. */
export type CredentialReference =
  | { type: 'managed'; id: string }
  | { type: 'kingdom-signet'; owner: string };

export interface CredentialScope {
  service: string;
  url: string;
  projectId: string;
}

export interface CredentialResolver {
  /** Resolve afresh for each request. Reject a reference outside its permitted scope. */
  resolve(reference: CredentialReference, scope: CredentialScope): Promise<string>;
}
