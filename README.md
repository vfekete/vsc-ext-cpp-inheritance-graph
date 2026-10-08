# C++ Inheritance Graph for VS Code

Source code and issues: <https://github.com/vfekete/vsc-ext-cpp-inheritance-graph>

| Directory | Contents |
|---|---|
| [`extension/`](extension/) | The VS Code extension: sources, webview, unit tests, build and deploy scripts. See [extension/README.md](extension/README.md). |
| [`test/mock/`](test/mock/) | Mock C++17 project used by the tests and for trying the extension (`F5` opens it). |
| [`deployment/`](deployment/) | Standalone installer: `install.sh` plus the packaged `.vsix`. |
| [`scripts/`](scripts/) | `build.sh`: rebuilds the content of `deployment/`. |
| [`MARKETPLACE.md`](MARKETPLACE.md) | What is still needed to publish on the VS Code Marketplace. |

Quick start:

```bash
./scripts/build.sh                      # rebuild deployment/ (clean install, compile, test, package)
cd extension && npm ci && npm test      # build and test
extension/scripts/deploy.sh             # package and install into VS Code
deployment/install.sh                   # or install the prebuilt package
```

## License

Copyright (c) 2026 Vladimir Fekete. Released under the MIT License (see [LICENSE](LICENSE)).

Co-authored: Claude
