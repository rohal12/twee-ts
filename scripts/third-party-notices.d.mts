/** A package found in the bundle: its name and the folder its package.json lives in. */
export interface BundledPackage {
  readonly name: string;
  readonly root: string;
}

/** What THIRD_PARTY_NOTICES records about one package. */
export interface PackageLicence {
  readonly name: string;
  readonly url: string | undefined;
  readonly license: string;
  readonly text: string;
}

export declare const NOTICES_FILE: string;
export declare function packageOfModuleId(moduleId: string): BundledPackage | undefined;
export declare function bundledPackages(moduleIds: Iterable<string>): BundledPackage[];
export declare function compareWithAllowList(
  bundled: readonly BundledPackage[],
  allowed: readonly string[],
): { unlisted: string[]; unused: string[] };
export declare function readPackageLicence(pkg: BundledPackage): PackageLicence;
export declare function renderThirdPartyNotices(licences: readonly PackageLicence[]): string;
export declare function updateThirdPartyNotices(options: {
  readonly moduleIds: Iterable<string>;
  readonly allowed: readonly string[];
  readonly file: string;
}): boolean;
