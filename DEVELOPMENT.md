# Development Guide - Herdr Collie

This document is for developers who want to contribute to the extension or understand its internals.

## Getting Started

1.  **Clone the repository.**
2.  **Install dependencies:**
    ```bash
    pnpm install
    ```
3.  **Compile the code:**
    ```bash
    pnpm run compile
    ```
    To watch for changes during development:
    ```bash
    pnpm run watch
    ```
4.  **Run/Debug:**
    - Open this project in VS Code.
    - Press `F5` to launch an "Extension Development Host" instance.

## Testing

- **Unit Tests**: `pnpm run test:unit`

## Local VSIX Smoke Test

1. Build a package with `pnpm run package`.
2. Install the generated `.vsix` into a normal VS Code window.
3. Validate that you can attach to workspaces, send contexts, and use the Herdr Collie sidebar view.

## Quality Control

- **Release baseline**: `pnpm run compile`, `pnpm run test:unit`, then `pnpm run package`.

## License

This project is licensed under the MIT License.
