/** A `no-restricted-syntax` entry: an AST selector and the message for code it matches. */
export interface SyntaxRestriction {
  readonly selector: string;
  readonly message: string;
}

/** The `no-restricted-syntax` entries that keep markup matching out of src (see eslint.config.js). */
export declare const HTML_STRUCTURE_RESTRICTIONS: readonly SyntaxRestriction[];
