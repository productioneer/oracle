## What “bypass Focus” actually means on macOS

macOS (like iOS/iPadOS) uses **Interruption Levels** for notifications: *passive*, *active* (default), *time sensitive*, and *critical*. Only the **UserNotifications** framework (UNUserNotificationCenter / UNNotificationInterruptionLevel) supports these modern semantics.

* **Time Sensitive**: presented immediately and intended to **break through system notification controls** (including Focus), *but only if the user allows time‑sensitive notifications for your app / for that Focus*. ([Apple Developer][1])
* **Critical**: always presented **even when Do Not Disturb is active**, and **requires an approved entitlement** (and user permission). For most developer tools, this is not realistically obtainable. ([Apple Developer][2])

So, in practice for a CLI tool:

* **Critical bypass** is almost never viable.
* **Time Sensitive** is the highest practical level, but still depends on the user’s Focus settings and per‑app notification settings. ([Apple Support][3])

---

## Capability matrix (2025–2026 reality)

### 1) `osascript` / AppleScript `display notification`

**Best for:** “just show something” with minimal dependencies.

* **Time Sensitive / Critical:** ❌ No (AppleScript “display notification” doesn’t expose interruption levels).
* **Action buttons:** ❌ No (Notification Center notification only; no custom buttons).
* **Capture click:** ❌ Not reliably.
* **Notes:** Apple’s AppleScript guide shows `display notification` as a simple Notification Center message; it’s not designed for interactive approval flows. ([Apple Developer][4])

**Verdict:** Not suitable for “Approve restart Chrome” as a single-click unblock mechanism.

---

### 2) AppleScript dialogs (`display dialog`, `display alert`)

**Best for:** A *blocking* modal prompt with buttons (very scriptable).

* **Bypass Focus:** Kind of (it’s not a notification; it’s a dialog).
* **Time Sensitive / Critical:** N/A (not a notification).
* **Action buttons:** ✅ Yes (buttons in the dialog).
* **Capture click:** ✅ Yes (the command returns which button was pressed).
* **Limitations:** It’s intrusive; can trigger automation/privacy prompts depending on how you invoke it; and it doesn’t behave like Notification Center.

**Verdict:** Good **fallback** if notifications are blocked/denied, but not what you asked for.

---

### 3) `terminal-notifier` (julienXX) – common Homebrew/NPM dependency

**Best for:** Standard notifications and click-to-run/open behavior.

From the upstream README (as of v2.0.0):

* It’s packaged as an **application bundle** because `NSUserNotification` doesn’t work from a Foundation command-line tool. ([GitHub][5])
* It supports `-open` and `-execute` to open a URL or run a shell command when the user clicks the notification. ([GitHub][5])
* It **does not provide action buttons** anymore (they explicitly removed/rolled back “sticky notification feature nor the actions buttons”; they recommend “alerter” if you need actions). ([GitHub][5])
* It has `-ignoreDnD`, but it’s a **private-method hack** and “subject to change.” ([GitHub][5])

**Time Sensitive / Critical:** ❌ No (legacy API; no interruption level).
**Action buttons:** ❌ No (v2+). ([GitHub][5])
**Capture click:** ✅ via `-execute` (write a file / invoke a command) but not a structured “which button” result. ([GitHub][5])

**Verdict:** Still useful for “click to approve” **if you can live without Focus bypass** (or if you’re okay with unreliable private hacks). Not ideal for 2025–2026 “Focus-aware” urgency.

---

### 4) “Modern Swift rewrite” `imajes/terminal-notifier`

This project explicitly adds an `--interruption-level` option including **timeSensitive**, but also notes missing parts (e.g., actions not implemented yet, shim not done). ([GitHub][6])

* **Time Sensitive:** ✅ Supported by CLI flag (per README). ([GitHub][6])
* **Action buttons:** ❌ Not yet (per README). ([GitHub][6])
* **Capture click:** likely limited until actions/callback mechanics are built out.

**Verdict:** Promising foundation, but not yet the “one tool does it all” solution.

---

### 5) NotifiCLI (released Jan 15, 2026)

This is the most relevant “CLI with interactive notifications” I found for the 2025–2026 window.

NotifiCLI’s README claims:

* **Action buttons** via `-actions "Deploy Now,Schedule Later,Cancel"`. ([GitHub][7])
* It **waits for user interaction** and prints a result to stdout (clicked button label, `dismissed`, or `default`). ([GitHub][7])
* It includes troubleshooting for “Notifications are not allowed” and suggests running the `.app` via `open …` once to associate notification permissions with the bundle. ([GitHub][7])

**Time Sensitive / Critical:** ⚠️ Not advertised in the README (so you should assume **no** Focus-bypass guarantee).
**Action buttons:** ✅ Yes. ([GitHub][7])
**Capture click:** ✅ Yes (stdout scripting + blocking wait). ([GitHub][7])

**Verdict:** If you can tolerate that the alert may be suppressed by Focus, this is *immediately practical* for your “single-click approve” flow.

---

### 6) Shortcuts

Shortcuts can be invoked from CLI (`shortcuts run …`) and can present UI / notifications, but:

* It adds a big “user environment dependency” (the shortcut must exist, be trusted, sometimes run permissions are fiddly).
* I didn’t find strong, current, Apple-documented evidence that Shortcuts exposes **time-sensitive / critical** notification flags in a way you can count on for an engineering tool (and your request needs reliability).

**Verdict:** Useful for user-specific workflows; not my recommended “best practical implementation” for a distributable CLI.

---

## The key limitation: “Time Sensitive” requires entitlements + user settings

Even if you build a perfect UNUserNotificationCenter implementation, **Time Sensitive** is not “just set a property and done”:

* Apple guidance around time-sensitive notifications emphasizes that they can break through Focus **if allowed**, and the system gives users controls for time-sensitive delivery within Focus. ([Apple Developer][8])
* The API surface for requesting “time sensitive authorization” has changed: `UNAuthorizationOptions.timeSensitive` shows up as deprecated in Apple docs search snippets, with direction to use the **time-sensitive entitlement** instead. ([Apple Developer][9])
* Third-party guidance commonly notes you must add the **Time Sensitive Notifications capability** (entitlement) in your Xcode project for time-sensitive behavior. ([Stack Overflow][10])

And **Critical** is even stricter: it requires an approved entitlement, and is explicitly described as always presented even under Do Not Disturb. ([Apple Developer][2])

---

## Recommended approach for a CLI / Node tool (best practical)

### Recommendation: ship a tiny helper `.app` (agent-style) using `UNUserNotificationCenter`

This is the only approach that cleanly supports **both**:

1. **Time Sensitive** interruption level, and
2. **Action handling** with a reliable callback mechanism,
   …without private API hacks.

You can keep Node pure and treat the helper as a small, versioned binary dependency.

#### High-level architecture

1. Your Node CLI generates a **run ID** (UUID) and a **one-time token**.
2. CLI invokes the helper like:

* **blocking mode** (simplest): helper posts notification and **waits** for a response; prints result to stdout (similar to NotifiCLI behavior).
* **async mode**: helper posts notification and exits; on click/action, helper writes an “approval file” or sends IPC, and your CLI polls/waits.

Given you explicitly want to “unblock a specific run,” *blocking mode with stdout* is the cleanest (no polling races).

#### What the helper must do (UserNotifications)

* Request notification authorization (normal `.alert` / `.sound` / `.badge`).
* Register a **category** with a single action button: `Approve restart`.
* Post a notification whose content includes:

  * `interruptionLevel = .timeSensitive`
  * `categoryIdentifier = "CHROME_RESTART_APPROVAL"`
  * `userInfo = { runId, token, maybe payload }`

WWDC guidance describes setting interruption levels on the notification content for local notifications, including Time Sensitive. ([Apple Developer][8])

#### Handle the click/action

Implement `UNUserNotificationCenterDelegate` and handle:

* `UNNotificationDefaultActionIdentifier` (user clicked the notification)
* `"APPROVE_ACTION"` (user clicked your “Approve restart” button)

On approval, either:

* print `APPROVED <runId> <token>` to stdout (blocking mode), or
* write a file like `~/Library/Application Support/yourtool/approvals/<runId>.json` (async mode), or
* run a command (but I recommend avoiding this unless you fully control quoting, environment, and trust boundaries).

---

## Minimal “works well in practice” implementation details

### 1) Use **Time Sensitive** (not Critical)

* **Critical alerts** require an approved entitlement; realistically you won’t get this for a Chrome restart prompt. ([Apple Developer][2])
* **Time Sensitive** is intended for urgent, user-relevant events and can break through Focus if allowed. ([Apple Developer][1])

### 2) Add the correct entitlement(s)

* **Time Sensitive entitlement** (capability in Xcode) is the modern path; Apple’s docs indicate the old `UNAuthorizationOptions.timeSensitive` path is deprecated in favor of entitlement. ([Apple Developer][9])
* Your helper should be **code signed** (Developer ID) and ideally notarized if you distribute it (to avoid Gatekeeper pain).

### 3) User-facing settings you must expect

Even with correct code, users may need to:

* Allow your helper app in **System Settings → Notifications**.
* Enable/allow **Time Sensitive Notifications** for your app and in their Focus configuration. Apple’s Focus setup docs explicitly call out “Time Sensitive Notifications” controls. ([Apple Support][3])

### 4) “Single click approve” UX recommendation

You can make it truly single-click by treating a **click on the notification body** as approval (default action), and optionally also provide a visible “Approve restart” button for clarity.

This reduces friction because:

* Some users have banners that disappear quickly.
* Buttons sometimes require hover/expansion depending on notification style.

### 5) Correlating approval with a specific run (securely)

Use:

* `runId = uuid`
* `token = random 128-bit`

Include both in the notification’s `userInfo`. When the helper returns approval, Node verifies token matches what it issued.

If you use a file:

* put approvals under a private directory (e.g., `~/Library/Application Support/yourtool/approvals/`)
* write atomically (write temp then rename)
* validate that the path you write is inside your expected base directory (avoid arbitrary write path injection).

---

## What I’d do today (2025–2026) for a Node CLI

### Option A (fastest usable today): NotifiCLI for interaction, no Focus bypass guarantee

If your “urgent” requirement is more “high priority” than “must always punch through Focus,” NotifiCLI is extremely practical:

* It supports action buttons and returns the clicked choice via stdout, blocking until user interacts. ([GitHub][7])

Example shell pattern (maps directly to Node `spawnSync` / `spawn`):

```bash
RUN_ID="$(uuidgen)"
CHOICE="$(notificli \
  -title "Restart Chrome for this run?" \
  -message "Run ${RUN_ID} needs to restart Chrome to continue." \
  -actions "Approve restart,Cancel")"

if [ "$CHOICE" = "Approve restart" ]; then
  echo "approved"
else
  echo "not approved: $CHOICE"
fi
```

This already gives you the “single-click action to approve” and a clean unblock mechanism (stdout). ([GitHub][7])

### Option B (recommended for Focus-bypass): your own helper app with UNUserNotificationCenter + Time Sensitive entitlement

This is the “best practical implementation” if bypassing Focus matters.

Use NotifiCLI as inspiration for:

* packaging a headless `.app`
* blocking/waiting and printing a result
  …but implement **timeSensitive interruption level** (and ship with the proper entitlement).

### Option C (only if you accept unreliability): `terminal-notifier -execute`

`terminal-notifier` can run a command on click, but:

* it’s not time-sensitive capable,
* action buttons are removed in v2,
* and its DND bypass relies on a private method. ([GitHub][5])

So I’d only use it if you want minimal work and can tolerate Focus blocking it.

---

## Concrete “click → unblock run” mechanisms

### Best: helper waits and prints result (stdout IPC)

Pros: simplest, race-free, no polling.
Cons: the notifying process blocks.

This is exactly the pattern NotifiCLI documents (waits; prints clicked action / dismissed / default). ([GitHub][7])

### Good: helper writes an approval file

Pros: CLI can continue doing other work; supports background daemons.
Cons: polling or file watchers; you need cleanup.

### Also workable: helper invokes a command

Pros: “push” model (no polling).
Cons: quoting/security; environment; sandboxing if you ever sandbox; and you have to decide what the command should do (resume job? signal PID?).

`terminal-notifier` supports this style via `-execute`. ([GitHub][5])

---

## Bottom line

* **If “bypass Focus” is truly mandatory:** your only clean path is a **small signed helper app** using **UNUserNotificationCenter** and **Time Sensitive interruption level**. Critical alerts are effectively off the table for a Chrome-restart approval prompt because of the approved entitlement requirement. ([Apple Developer][2])
* **If interactive approval is the bigger requirement and Focus-bypass is “nice to have”:** **NotifiCLI (Jan 2026)** is the most practical off-the-shelf CLI I found because it supports action buttons and returns the clicked result to stdout. ([GitHub][7])
* **Avoid betting on private API DND bypass flags** (`-ignoreDnD` style): they’re explicitly described as subject to change. ([GitHub][5])

If you want, I can sketch a minimal Swift helper structure (agent-style `.app` + CLI entrypoint) and the Node wrapper code in a way that mirrors NotifiCLI’s “wait + stdout” ergonomics, but with `interruptionLevel = .timeSensitive` and a single “Approve restart” action.

[1]: https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive "https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive"
[2]: https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/critical "https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/critical"
[3]: https://support.apple.com/guide/mac-help/set-up-a-focus-to-stay-on-task-mchl613dc43f/mac "Set up a Focus on Mac - Apple Support"
[4]: https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html?utm_source=chatgpt.com "Mac Automation Scripting Guide: Displaying Notifications"
[5]: https://github.com/julienXX/terminal-notifier "GitHub - julienXX/terminal-notifier: Send User Notifications on macOS from the command-line."
[6]: https://github.com/imajes/terminal-notifier// "GitHub - imajes/terminal-notifier: A modern approach to the terminal notifier problem"
[7]: https://github.com/saihgupr/NotifiCLI "https://github.com/saihgupr/NotifiCLI"
[8]: https://developer.apple.com/videos/play/wwdc2021/10091/ "Send communication and Time Sensitive notifications - WWDC21 - Videos - Apple Developer"
[9]: https://developer.apple.com/documentation/usernotifications/unauthorizationoptions/timesensitive?utm_source=chatgpt.com "timeSensitive | Apple Developer Documentation"
[10]: https://stackoverflow.com/questions/73058917/time-sensitive-notifications-not-being-received "https://stackoverflow.com/questions/73058917/time-sensitive-notifications-not-being-received"
