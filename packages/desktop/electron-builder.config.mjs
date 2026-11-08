// electron-builder configuration of Appling Desktop. It packs `app/`, which `scripts/bundle.mjs` writes.
// Builds are unsigned unless the signing secrets are set (see .github/workflows/desktop-release.yml):
//   macOS: CSC_LINK + CSC_KEY_PASSWORD (Developer ID certificate), notarized with APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD
//          + APPLE_TEAM_ID (or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER).
//   Windows: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (a certificate), or Azure Trusted Signing with AZURE_TENANT_ID,
//          AZURE_CLIENT_ID, AZURE_CLIENT_SECRET plus AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT,
//          AZURE_SIGNING_PROFILE and AZURE_PUBLISHER_NAME (the certificate's subject CN).
import { readFileSync } from 'node:fs';

const desktop = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const env = process.env;
const macSigned = Boolean(env.CSC_LINK || env.CSC_NAME);
const notarize = Boolean(env.APPLE_ID || env.APPLE_API_KEY);
const azure = Boolean(env.AZURE_SIGNING_ENDPOINT && env.AZURE_SIGNING_ACCOUNT && env.AZURE_SIGNING_PROFILE);
const winSigned = Boolean(env.WIN_CSC_LINK || env.CSC_LINK || azure);

/** @type {import('electron-builder').Configuration} */
export default {
    appId: 'tools.appling.desktop',
    productName: 'Appling',
    executableName: 'appling',
    copyright: 'Copyright © Alexandros Fotiadis',
    electronVersion: desktop.dependencies.electron,
    directories: { app: 'app', output: 'release', buildResources: 'build' },
    // `app/` is complete: its single native module lies in `native/` (N-API, so no rebuild for Electron). Returning
    // false tells electron-builder that node_modules are handled here, so it neither installs nor collects any (it
    // would otherwise fall back to this package's own pnpm dependencies).
    beforeBuild: async () => false,
    icon: '../landing/public/icon-512.png',
    asar: true,
    // outside the archive: node-pty's native files and its macOS spawn helper, and the vsix that openvscode-server
    // (not Electron, so it cannot read the asar) installs (UNPACKED in src/resources.ts)
    asarUnpack: ['native/**', 'vscode/**'],
    // signed: read by src/updater.ts, an unsigned macOS build can only point to the release page.
    // desktopName: the window's WM_CLASS, so desktops link the running window to the launcher entry
    extraMetadata: { desktopName: 'appling.desktop', signed: process.platform === 'darwin' ? macSigned : process.platform === 'win32' && winSigned },
    artifactName: 'Appling-${version}-${os}-${arch}.${ext}',
    publish: [{ provider: 'github', owner: 'alex20465', repo: 'appling', releaseType: 'release' }],
    linux: {
        target: [{ target: 'AppImage', arch: ['x64'] }],
        category: 'Development',
        syncDesktopName: true,
        synopsis: 'Model your application, then generate the code'
    },
    win: {
        target: [{ target: 'nsis', arch: ['x64'] }],
        ...(azure ? {
            azureSignOptions: {
                publisherName: env.AZURE_PUBLISHER_NAME,
                endpoint: env.AZURE_SIGNING_ENDPOINT,
                codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
                certificateProfileName: env.AZURE_SIGNING_PROFILE
            }
        } : {})
    },
    nsis: { oneClick: true, perMachine: false, artifactName: 'Appling-Setup-${version}-${arch}.${ext}' },
    mac: {
        // zip next to the dmg: electron-updater installs macOS updates from the zip
        target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
        category: 'public.app-category.developer-tools',
        hardenedRuntime: macSigned,
        // without a certificate, skip signing entirely (no ad hoc identity lookup)
        identity: macSigned ? undefined : null,
        notarize: macSigned && notarize
    }
};
