# Publishing to the VS Code Marketplace: checklist

The extension packages cleanly: no `vsce` warnings, and the licence, changelog and repository link are present. These steps are still open before it can be published.

## Required

- [ ] **Create a publisher.** Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account, create a publisher, and replace `"publisher": "local"` in `extension/package.json` with its ID.
  - The extension ID becomes `<publisher>.cpp-inheritance-graph`. Uninstall the locally installed `local.cpp-inheritance-graph` first, otherwise both are installed side by side.
- [ ] **Personal access token.** In Azure DevOps (<https://dev.azure.com>), create a token with organisation *All accessible organizations* and scope *Marketplace → Manage*.
- [ ] **Publish** from `extension/`:
  ```bash
  npx vsce login <publisher>      # paste the token
  npx vsce publish                # or: npx vsce publish minor / patch to bump the version
  ```

## Strongly recommended

- [ ] **Icon:** a 128×128 PNG, because SVG is not allowed. Add it as `extension/media/icon.png` and set `"icon": "media/icon.png"` in `package.json`.
- [ ] **User-facing README:** `extension/README.md` becomes the Marketplace page. Move the developer material into a separate file in the repository root: build/deploy scripts, the CLI, the test workspace, and paths such as `../test/mock` and `scripts/deploy.sh`. Keep features, settings, requirements and limitations in the extension README.
- [ ] **Screenshots / GIF in the README:** referenced by absolute `https` URLs, for example images committed to the GitHub repository. These only work once the repository is public.
- [ ] **Make the GitHub repository public.** Until then, the *Repository*, *Homepage* and *Issues* links in the listing return 404.

## Optional

- [ ] Check that the display name "C++ Inheritance Graph" is not already taken on the Marketplace. Publishing is refused for duplicate names.
- [ ] Add `"preview": true` to `package.json` while the version is 0.x.
- [ ] Publish to **Open VSX** (<https://open-vsx.org>) for VSCodium, Cursor and other VS Code-based editors. This needs an Eclipse account and token, then `npx ovsx publish`.
- [ ] Verify the publisher (blue check mark). This requires a domain you own and a DNS TXT record.
