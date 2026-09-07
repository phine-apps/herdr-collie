# Publishing Guide

## Prerequisites

1. **VS Code Marketplace**:
- You need a Personal Access Token (PAT) from Azure DevOps.
- Login: `vsce login <publisher-name>`

## Commands

### Package

To create a `.vsix` file for testing or manual upload:

```bash
pnpm run package
```

Install the generated package locally from the Extensions view using **Install from VSIX...**, or with the CLI:

```bash
code --install-extension herdr-collie-<version>.vsix
```

### Publish to VS Code Marketplace

```bash
vsce publish
```

## Release Checklist

1. Run `pnpm run compile` and `pnpm run test:unit`.
2. Build a local package with `pnpm run package`.
3. Install the `.vsix` locally and smoke-test features.
4. Update `package.json` for the release version.
