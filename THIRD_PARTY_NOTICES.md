# Third-party notices

## Bundled assets and dependencies

The web interface bundles [Geist Sans](https://github.com/vercel/geist-font)
under the SIL Open Font License 1.1 and [Phosphor icons](https://github.com/phosphor-icons/core)
under the MIT license. Their complete license texts are included in
`web/fonts/LICENSE.txt` and `web/icons/LICENSE`; see `web/ASSET_LICENSES.md`.

The Node.js runtime uses Express, dotenv, got, Playwright Core, HTTP/HTTPS/SOCKS
proxy agents and yazl. Package versions are recorded in `package-lock.json`;
installed package license files are retained in `node_modules/`. The Docker
runtime installs Chromium, system fonts, gosu and tini as Debian packages.
Their license notices are retained in the image under `/usr/share/doc/`.
