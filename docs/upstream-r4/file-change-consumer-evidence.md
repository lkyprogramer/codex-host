# Installed Desktop file-change consumer evidence

Read-only inspection on 2026-09-26 of `/Applications/ChatGPT.app/Contents/Resources/app.asar`; the app was not started, restarted, modified, or injected. `CFBundleShortVersionString` is `26.917.71314`, `CFBundleVersion` is `10954`, and the asar SHA-256 is `03108a728bdb1616958ab89587c5495cab0cf4cd1bbe109bdfb186df0a113804`.

The asar header was parsed to read the packaged JavaScript bytes directly. `webview/assets/app-initial-51da50e6c6e3.js` contains the renderer notification reducer. Its `item/fileChange/patchUpdated` case looks up a `fileChange` Item by `itemId` in the addressed Turn. When found, it replaces that Item's `changes` with the notification's complete `changes` list. When absent, it appends an `inProgress` `fileChange` Item with that ID and list. Thus the U13 projection's single `item/started` card and subsequent same-ID `patchUpdated` notifications can grow or retract the displayed file list without another Item start. The corresponding case in `.vite/build/main-C-Mhak1n.js` has the same lookup-and-replace behavior.

The renderer's `item/completed` case projects the completed Item and updates the Turn by Item ID; `turn/diff/updated` replaces the Turn's `diff`. U13 sends one completed file Item at Turn completion and sends the full current summary with each patch update. The inspected reducer has no requirement for a separate `item/started` per changed path.

This is static evidence for the installed bundle's reducer behavior. A live Desktop render and interaction check was not run; this inspection cannot establish the appearance of the final card or behavior in a different Desktop build.
