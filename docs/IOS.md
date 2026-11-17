# souldew for iOS (experimental – nothing here has been run on a device yet)

The iOS app is the same idea as the [Android app](ANDROID.md): the souldew server runs inside the app (nodejs-mobile, Node 18)
and a full-screen `WKWebView` shows its page on `http://127.0.0.1:7373`. The project is in `ios/`; it was written without a
Mac at hand, so the first run of `.github/workflows/ios.yml` is also its first compile.

## What it can and can't do

| | iOS |
|---|---|
| SoulLink, Nuzlocke, board, sync, Discord | yes (the server and the web app are unchanged) |
| Game Boy, Game Boy Color, Game Boy Advance, DS | yes, in the browser emulator (WebAssembly in WebKit, with the on-screen pad) |
| Randomizer | **no** – it is Java, and iOS has no JVM and no way to run one. Runs use the game as it is |
| Nintendo 3DS | **no** – the 3DS emulator needs a JIT, which iOS doesn't give apps |
| Search my device | **no** – hidden; the app sees only its own folder |
| OBS / Stream, external emulators | hidden on touch screens, as on Android |

Adding games: **Add files** opens the system file picker, or in the Files app open *On My iPhone › souldew* – the app's
`Documents/souldew/Library` folder takes game files directly (`UIFileSharingEnabled`).

## Building

Needs a Mac with Xcode 15+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`):

```
# nodejs-mobile for iOS, SHA-256 8c5ca3a0d1e38de7f182a5642593e82593b820efd375a14b3ecafc4bcfee620e (51 MB)
mkdir -p ios/Frameworks
curl -fLO https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-ios.zip
unzip -q nodejs-mobile-v18.20.4-ios.zip 'NodeMobile.xcframework/*' -d ios/Frameworks
node scripts/ios-assets.mjs                       # server, web app, production node_modules → ios/souldew-app
cd ios
SOULDEW_VERSION=2.7.4 SOULDEW_BUILD=1 xcodegen generate
open souldew.xcodeproj                            # run on a device or simulator from Xcode (set a team under Signing)
```

## GitHub Actions

`.github/workflows/ios.yml` builds an **unsigned** `souldew-<version>-ios-unsigned.ipa` on a macOS runner and uploads it as an
artifact. GitHub's macOS runners never started for this repository (jobs were cancelled in the queue, see `ci.yml`), so the
workflow does not run by itself:

- by hand: **Actions › iOS app › Run workflow** (the workflow file must be on the default branch for that button);
- on pushes that touch the app: set the repository **variable** `IOS_CI` to `true`;
- with a release: set the variable `IOS_RELEASE` to `true`; `release.yml` then builds the IPA for a `v*` tag and attaches it.

An unsigned IPA doesn't install by itself. Sign it when installing: AltStore / SideStore / Sideloadly (a free Apple ID works,
the app then expires after 7 days), or Xcode with your team. **TestFlight and the App Store** need a paid Apple Developer
account, a distribution certificate and provisioning profile, and a signed export (`xcodebuild archive` +
`-exportArchive`); that step isn't set up here. Apple's review may also object to an app that runs a local web server and an
emulator – a store release is a separate piece of work.

## Open

- The first real build: expect fixes (the XcodeGen spec, the Swift/Objective-C bridge, embedding the xcframework).
- Whether Node 18 (jitless on iOS) starts fast enough and stays under the memory limit with the browser emulator running.
- Safari's own limits: WebAssembly threads, audio start only after a tap, no full-screen API on iPhone.
- Saving diagnostics and other downloads (`<a download>` / blob links) aren't wired up in the WebView.
