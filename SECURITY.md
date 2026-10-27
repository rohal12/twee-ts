# Security policy

## Supported versions

Security fixes go into the latest release of [`@rohal12/twee-ts`](https://www.npmjs.com/package/@rohal12/twee-ts).
Older major versions do not get fixes; update to the latest release.

## Reporting a vulnerability

Report a vulnerability privately through GitHub's private vulnerability reporting: on the repository's **Security**
tab choose **Report a vulnerability**, or open
[a new draft advisory](https://github.com/rohal12/twee-ts/security/advisories/new). Please do not open a public issue
or pull request for it.

Include what you can of:

- the affected version, and how twee-ts was used (CLI, API, Vite or Rollup plugin)
- the input that triggers it (a Twee or HTML source, a story format, a config file, a format URL or index), as small
  as you can make it
- what happens, and what an attacker gains

The report stays private between you and the maintainers until a fix is released; the advisory then credits you
unless you ask otherwise.

## Scope

twee-ts compiles story sources into HTML and reads story formats from local folders, format URLs and format indices.
Reports about these are in scope, for example output that runs script the source did not contain, a story format or
index that makes twee-ts read or write outside the paths it was given, or input that makes a build take unbounded
time or memory.
